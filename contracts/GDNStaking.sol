// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IPriceFeed.sol";
import "./interfaces/IGDNStaking.sol";

/**
 * @title GDNStaking
 * @notice Lock staking for $GDN with:
 *         - Lock periods: 3, 6, 9, or 12 months
 *         - Boost multipliers: 1x, 1.5x, 2x, 3x
 *         - Loyalty tier calculation (using Chainlink-compatible price feed)
 *         - Reward distribution (Synthetix pattern)
 *         - Early unstake slash: 5% + 0.5% per remaining month (cap 10%)
 *
 *         UUPS upgradeable — storage layout must be preserved across versions.
 */
contract GDNStaking is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    IGDNStaking
{
    using SafeERC20 for IERC20;

    // ─── Reentrancy Guard (transient storage, upgrade-safe) ───

    // Using a fixed slot in transient storage for reentrancy lock
    bytes32 private constant _REENTRANCY_SLOT = keccak256("GDNStaking.reentrancyLock");

    modifier nonReentrant() {
        assembly {
            if tload(_REENTRANCY_SLOT) { revert(0, 0) }
            tstore(_REENTRANCY_SLOT, 1)
        }
        _;
        assembly {
            tstore(_REENTRANCY_SLOT, 0)
        }
    }

    // ─── Structs ─────────────────────────────────────

    struct StakeInfo {
        uint256 amount;           // $GDN staked
        uint256 effectiveAmount;  // amount × boost (for reward calc)
        uint64  lockStart;
        uint64  lockEnd;
        uint16  boostBps;         // 10000 = 1x, 15000 = 1.5x, etc.
        uint256 rewardDebt;       // Synthetix reward tracking
    }

    // ─── State ───────────────────────────────────────

    IERC20 public gdnToken;
    IPriceFeed public priceFeed;
    address public treasury;

    mapping(address => StakeInfo) public stakes;
    mapping(address => uint256) public override totalDeposited; // Updated by vaults

    uint256 public totalEffectiveStaked;
    uint256 public accRewardPerShare;    // ×1e18 precision

    /// @notice Addresses authorized to call updateDeposits (registered vaults)
    mapping(address => bool) public registeredVaults;

    // ─── Constants ───────────────────────────────────

    uint256 private constant PRECISION = 1e18;
    uint256 private constant BPS = 10000;

    /// @notice Boost multipliers in bps for each lock duration
    /// Index: 0=3mo, 1=6mo, 2=9mo, 3=12mo
    uint16[4] public boostTiers; // [10000, 15000, 20000, 30000]

    /// @notice Slash base in bps (5% = 500)
    uint256 public slashBaseBps;

    /// @notice Slash per remaining month in bps (0.5% = 50)
    uint256 public slashPerMonthBps;

    /// @notice Slash cap in bps (10% = 1000)
    uint256 public slashCapBps;

    // ─── Events ──────────────────────────────────────

    event Staked(address indexed user, uint256 amount, uint256 lockMonths, uint16 boostBps);
    event Unstaked(address indexed user, uint256 returnAmount);
    event Slashed(address indexed user, uint256 slashAmount, uint256 slashBps);
    event RewardsClaimed(address indexed user, uint256 amount);
    event RewardsDistributed(uint256 amount);
    event VaultRegistered(address indexed vault);
    event VaultUnregistered(address indexed vault);
    event DepositsUpdated(address indexed user, int256 delta, uint256 newTotal);

    // ─── Errors ──────────────────────────────────────

    error AlreadyStaking();
    error NotStaking();
    error InvalidLockDuration();
    error NotRegisteredVault();
    error ZeroAmount();

    // ─── Storage gap for upgrades ────────────────────

    uint256[40] private __gap;

    // ─── Initializer ─────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _gdnToken,
        address _priceFeed,
        address _treasury
    ) external initializer {
        __Ownable_init(msg.sender);
        __Pausable_init();

        require(_gdnToken != address(0), "zero token");
        require(_priceFeed != address(0), "zero feed");
        require(_treasury != address(0), "zero treasury");

        gdnToken = IERC20(_gdnToken);
        priceFeed = IPriceFeed(_priceFeed);
        treasury = _treasury;

        // Default boost tiers
        boostTiers = [uint16(10000), uint16(15000), uint16(20000), uint16(30000)];

        // Default slash params
        slashBaseBps = 500;      // 5%
        slashPerMonthBps = 50;   // 0.5% per remaining month
        slashCapBps = 1000;      // 10% cap
    }

    // ─── Staking ─────────────────────────────────────

    /**
     * @notice Stake $GDN with a lock period.
     * @param amount Amount of $GDN to stake
     * @param lockMonths Lock duration: 3, 6, 9, or 12
     */
    function stake(uint256 amount, uint256 lockMonths) external nonReentrant whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (stakes[msg.sender].amount != 0) revert AlreadyStaking();

        uint8 tierIndex = _lockMonthsToIndex(lockMonths);
        uint16 boost = boostTiers[tierIndex];
        uint256 effective = (amount * boost) / BPS;

        gdnToken.safeTransferFrom(msg.sender, address(this), amount);

        stakes[msg.sender] = StakeInfo({
            amount: amount,
            effectiveAmount: effective,
            lockStart: uint64(block.timestamp),
            lockEnd: uint64(block.timestamp + (lockMonths * 30 days)),
            boostBps: boost,
            rewardDebt: (effective * accRewardPerShare) / PRECISION
        });

        totalEffectiveStaked += effective;

        emit Staked(msg.sender, amount, lockMonths, boost);
    }

    /**
     * @notice Unstake $GDN. If before lock end, a slash is applied.
     */
    function unstake() external nonReentrant {
        StakeInfo storage s = stakes[msg.sender];
        if (s.amount == 0) revert NotStaking();

        // Claim pending rewards first
        _claimRewards(msg.sender);

        uint256 returnAmount = s.amount;

        if (block.timestamp < s.lockEnd) {
            // Early unstake → slash
            uint256 remaining = (s.lockEnd - block.timestamp);
            uint256 monthsRemaining = (remaining / 30 days) + 1; // Round up

            uint256 slash = slashBaseBps + (monthsRemaining * slashPerMonthBps);
            if (slash > slashCapBps) slash = slashCapBps;

            uint256 slashAmount = (s.amount * slash) / BPS;
            returnAmount = s.amount - slashAmount;

            // Slashed tokens go to treasury
            gdnToken.safeTransfer(treasury, slashAmount);
            emit Slashed(msg.sender, slashAmount, slash);
        }

        totalEffectiveStaked -= s.effectiveAmount;
        gdnToken.safeTransfer(msg.sender, returnAmount);
        delete stakes[msg.sender];

        emit Unstaked(msg.sender, returnAmount);
    }

    // ─── Rewards (Synthetix pattern) ─────────────────

    /**
     * @notice Distribute $GDN rewards to all stakers.
     *         Called by Treasury after buying $GDN with fees.
     * @param amount Amount of $GDN to distribute
     */
    function distributeRewards(uint256 amount) external override {
        require(msg.sender == treasury, "only treasury");
        if (totalEffectiveStaked == 0) return;

        gdnToken.safeTransferFrom(msg.sender, address(this), amount);
        accRewardPerShare += (amount * PRECISION) / totalEffectiveStaked;

        emit RewardsDistributed(amount);
    }

    /**
     * @notice Claim accumulated $GDN rewards.
     */
    function claimRewards() external nonReentrant {
        _claimRewards(msg.sender);
    }

    /**
     * @notice View pending rewards for a user.
     */
    function pendingRewards(address user) external view returns (uint256) {
        StakeInfo storage s = stakes[user];
        if (s.amount == 0) return 0;
        return ((s.effectiveAmount * accRewardPerShare) / PRECISION) - s.rewardDebt;
    }

    // ─── Loyalty Tier (called by vaults) ─────────────

    /**
     * @notice Returns the loyalty tier for a user.
     * @dev Uses effectiveAmount (with boost) for the ratio calculation.
     *      0=None, 1=Bronze, 2=Silver, 3=Gold, 4=Platinum
     */
    function loyaltyTier(address user) external view override returns (uint8) {
        StakeInfo storage s = stakes[user];
        if (s.amount == 0) return 0;

        uint256 deposited = totalDeposited[user];
        if (deposited == 0) return 0;

        uint256 gdnPrice = priceFeed.latestPrice(); // 8 decimals

        // effectiveAmount is 18 decimals, gdnPrice is 8 decimals
        // gdnValueUsd = effectiveAmount × gdnPrice / 1e8 → 18 decimals
        uint256 gdnValueUsd = (s.effectiveAmount * gdnPrice) / 1e8;

        // deposited is USDC (6 decimals), normalize to 18 decimals
        uint256 depositsNorm = deposited * 1e12;

        // ratio in bps: (gdnValue × 10000) / deposits
        uint256 ratioBps = (gdnValueUsd * BPS) / depositsNorm;

        if (ratioBps >= 1000) return 4; // Platinum (≥10%)
        if (ratioBps >= 500)  return 3; // Gold (≥5%)
        if (ratioBps >= 300)  return 2; // Silver (≥3%)
        if (ratioBps >= 100)  return 1; // Bronze (≥1%)
        return 0; // None
    }

    // ─── Vault integration ───────────────────────────

    /**
     * @notice Called by registered vaults to update a user's total deposit amount.
     * @param user The depositor
     * @param delta Positive for deposit, negative for withdrawal (in USDC, 6 decimals)
     */
    function updateDeposits(address user, int256 delta) external override {
        if (!registeredVaults[msg.sender]) revert NotRegisteredVault();

        if (delta > 0) {
            totalDeposited[user] += uint256(delta);
        } else {
            uint256 decrease = uint256(-delta);
            if (decrease > totalDeposited[user]) {
                totalDeposited[user] = 0;
            } else {
                totalDeposited[user] -= decrease;
            }
        }

        emit DepositsUpdated(user, delta, totalDeposited[user]);
    }

    // ─── Admin ───────────────────────────────────────

    function registerVault(address vault) external onlyOwner {
        registeredVaults[vault] = true;
        emit VaultRegistered(vault);
    }

    function unregisterVault(address vault) external onlyOwner {
        registeredVaults[vault] = false;
        emit VaultUnregistered(vault);
    }

    function setPriceFeed(address _feed) external onlyOwner {
        require(_feed != address(0), "zero feed");
        priceFeed = IPriceFeed(_feed);
    }

    function setTreasury(address _treasury) external onlyOwner {
        require(_treasury != address(0), "zero treasury");
        treasury = _treasury;
    }

    function setSlashParams(uint256 _baseBps, uint256 _perMonthBps, uint256 _capBps) external onlyOwner {
        require(_baseBps <= 2000, "base too high");
        require(_capBps <= 3000, "cap too high");
        slashBaseBps = _baseBps;
        slashPerMonthBps = _perMonthBps;
        slashCapBps = _capBps;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── View helpers ────────────────────────────────

    function getStake(address user) external view returns (StakeInfo memory) {
        return stakes[user];
    }

    function isStaking(address user) external view returns (bool) {
        return stakes[user].amount > 0;
    }

    function timeUntilUnlock(address user) external view returns (uint256) {
        StakeInfo storage s = stakes[user];
        if (s.amount == 0 || block.timestamp >= s.lockEnd) return 0;
        return s.lockEnd - block.timestamp;
    }

    // ─── Internal ────────────────────────────────────

    function _claimRewards(address user) internal {
        StakeInfo storage s = stakes[user];
        if (s.amount == 0) return;

        uint256 pending = ((s.effectiveAmount * accRewardPerShare) / PRECISION) - s.rewardDebt;
        if (pending > 0) {
            gdnToken.safeTransfer(user, pending);
            emit RewardsClaimed(user, pending);
        }
        s.rewardDebt = (s.effectiveAmount * accRewardPerShare) / PRECISION;
    }

    function _lockMonthsToIndex(uint256 months) internal pure returns (uint8) {
        if (months == 3) return 0;
        if (months == 6) return 1;
        if (months == 9) return 2;
        if (months == 12) return 3;
        revert InvalidLockDuration();
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
