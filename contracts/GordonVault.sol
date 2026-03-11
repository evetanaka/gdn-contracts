// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "./interfaces/IGDNStaking.sol";
import "./interfaces/ITreasury.sol";

/**
 * @title GordonVault
 * @notice ERC-4626-like vault for Polymarket copy trading.
 *         Users deposit USDC, receive shares proportional to their deposit.
 *         A keeper manages positions on Polymarket and updates the NAV.
 *
 *         Key features:
 *         - Deposit/withdrawal fees based on loyalty tier (from GDNStaking)
 *         - Keeper-updated NAV (positionsValue) with deviation guard
 *         - Performance fees (20%) collected daily on NAV increase (high water mark)
 *         - Emergency pause
 *
 *         UUPS upgradeable.
 *
 *         Note: We implement ERC-4626 logic manually rather than inheriting
 *         OpenZeppelin's ERC4626Upgradeable to avoid double-inheritance issues
 *         with ERC20Upgradeable and to keep full control over fee logic.
 *         The vault shares are tracked via a simple mapping (not a full ERC-20)
 *         to keep gas costs low — shares are non-transferable by design.
 */
contract GordonVault is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Reentrancy Guard (transient storage) ────────

    modifier nonReentrant() {
        assembly {
            if tload(0x02) { revert(0, 0) }
            tstore(0x02, 1)
        }
        _;
        assembly {
            tstore(0x02, 0)
        }
    }

    // ─── State ───────────────────────────────────────

    /// @notice The underlying asset (USDC)
    IERC20 public asset;

    /// @notice Vault name and slug (e.g. "Gordon Crypto Vault", "crypto")
    string public name;
    string public slug;

    /// @notice Share balances (non-transferable)
    mapping(address => uint256) public shareBalanceOf;
    uint256 public totalShares;

    /// @notice Keeper-updated value of Polymarket positions (in USDC, 6 decimals)
    uint256 public positionsValue;
    uint256 public lastNavUpdate;

    /// @notice Performance fee tracking
    uint256 public highWaterMark;
    uint256 public lastFeeCollection;

    /// @notice External contracts
    address public keeper;
    address public treasury;
    IGDNStaking public stakingContract;

    // ─── Configuration ───────────────────────────────

    /// @notice Max NAV deviation per update in bps (default 20%)
    uint256 public maxNavDeviationBps;

    /// @notice Performance fee in bps (default 20%)
    uint256 public perfFeeBps;

    /// @notice Minimum time between performance fee collections
    uint256 public feePeriod;

    /// @notice Deposit fee tiers in bps [None, Bronze, Silver, Gold, Platinum]
    uint256[5] public depositFeeBps;

    /// @notice Withdrawal fee tiers in bps
    uint256[5] public withdrawFeeBps;

    // ─── Events ──────────────────────────────────────

    event Deposited(
        address indexed user,
        uint256 assets,
        uint256 fee,
        uint256 shares,
        uint8 tier
    );
    event Withdrawn(
        address indexed user,
        uint256 shares,
        uint256 assets,
        uint256 fee,
        uint8 tier
    );
    event NavUpdated(uint256 positionsValue, uint256 totalAssets, uint256 timestamp);
    event PerformanceFeeCollected(uint256 profit, uint256 fee);
    event StrategyExecuted(address indexed target, uint256 value, bytes data);
    event KeeperChanged(address indexed oldKeeper, address indexed newKeeper);

    // ─── Errors ──────────────────────────────────────

    error ZeroAmount();
    error InsufficientShares();
    error InsufficientLiquidity();
    error NavDeviationTooLarge();
    error FeeTooEarly();
    error OnlyKeeper();
    error ZeroAddress();

    // ─── Storage gap ─────────────────────────────────

    uint256[40] private __gap;

    // ─── Modifiers ───────────────────────────────────

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert OnlyKeeper();
        _;
    }

    // ─── Initializer ─────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address _asset,
        string calldata _name,
        string calldata _slug,
        address _keeper,
        address _treasury,
        address _stakingContract
    ) external initializer {
        __Ownable_init(msg.sender);
        __Pausable_init();

        if (_asset == address(0)) revert ZeroAddress();
        if (_keeper == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_stakingContract == address(0)) revert ZeroAddress();

        asset = IERC20(_asset);
        name = _name;
        slug = _slug;
        keeper = _keeper;
        treasury = _treasury;
        stakingContract = IGDNStaking(_stakingContract);

        // Defaults
        maxNavDeviationBps = 2000; // 20%
        perfFeeBps = 2000; // 20%
        feePeriod = 24 hours;

        // Fee tiers: [None, Bronze, Silver, Gold, Platinum]
        depositFeeBps = [uint256(100), 75, 50, 25, 10];
        withdrawFeeBps = [uint256(50), 37, 25, 12, 5];

        lastFeeCollection = block.timestamp;
    }

    // ─── Core: Deposit ───────────────────────────────

    /**
     * @notice Deposit USDC into the vault. Caller receives shares.
     * @param assets Amount of USDC to deposit (6 decimals)
     * @return shares Amount of vault shares minted
     */
    function deposit(uint256 assets) external nonReentrant whenNotPaused returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();

        // Calculate fee based on loyalty tier
        uint8 tier = stakingContract.loyaltyTier(msg.sender);
        uint256 fee = (assets * depositFeeBps[tier]) / 10000;
        uint256 net = assets - fee;

        // Calculate shares
        shares = _convertToShares(net);
        if (shares == 0) revert ZeroAmount();

        // Transfer USDC
        asset.safeTransferFrom(msg.sender, address(this), net);
        if (fee > 0) {
            asset.safeTransferFrom(msg.sender, treasury, fee);
        }

        // Mint shares
        shareBalanceOf[msg.sender] += shares;
        totalShares += shares;

        // Update high water mark on first deposit
        if (highWaterMark == 0) {
            highWaterMark = totalAssets();
        }

        // Notify staking contract
        stakingContract.updateDeposits(msg.sender, int256(uint256(net)));

        emit Deposited(msg.sender, assets, fee, shares, tier);
    }

    /**
     * @notice Withdraw USDC by redeeming shares.
     * @param shares Amount of vault shares to redeem
     * @return assets Amount of USDC returned (after fee)
     */
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (shareBalanceOf[msg.sender] < shares) revert InsufficientShares();

        // Calculate USDC value of shares
        uint256 grossAssets = _convertToAssets(shares);

        // Calculate fee
        uint8 tier = stakingContract.loyaltyTier(msg.sender);
        uint256 fee = (grossAssets * withdrawFeeBps[tier]) / 10000;
        assets = grossAssets - fee;

        // Check liquidity
        uint256 available = asset.balanceOf(address(this));
        if (available < grossAssets) revert InsufficientLiquidity();

        // Burn shares
        shareBalanceOf[msg.sender] -= shares;
        totalShares -= shares;

        // Transfer
        if (fee > 0) {
            asset.safeTransfer(treasury, fee);
        }
        asset.safeTransfer(msg.sender, assets);

        // Notify staking contract
        stakingContract.updateDeposits(msg.sender, -int256(uint256(assets)));

        emit Withdrawn(msg.sender, shares, assets, fee, tier);
    }

    // ─── Views ───────────────────────────────────────

    /**
     * @notice Total assets under management (free USDC + positions value)
     */
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) + positionsValue;
    }

    /**
     * @notice Price of one share in USDC (scaled to 1e6 for USDC decimals)
     */
    function sharePrice() external view returns (uint256) {
        if (totalShares == 0) return 1e6; // 1:1 when empty
        return (totalAssets() * 1e6) / totalShares;
    }

    /**
     * @notice Convert USDC amount to shares
     */
    function convertToShares(uint256 assets) external view returns (uint256) {
        return _convertToShares(assets);
    }

    /**
     * @notice Convert shares to USDC amount
     */
    function convertToAssets(uint256 shares) external view returns (uint256) {
        return _convertToAssets(shares);
    }

    /**
     * @notice Free USDC available (not in positions)
     */
    function freeAssets() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    /**
     * @notice User's share balance and its USDC value
     */
    function userPosition(address user) external view returns (uint256 shares, uint256 value) {
        shares = shareBalanceOf[user];
        value = shares > 0 ? _convertToAssets(shares) : 0;
    }

    // ─── Keeper: NAV Update ──────────────────────────

    /**
     * @notice Update the value of Polymarket positions.
     *         Called by the keeper every ~5 minutes.
     * @param _positionsValue Total value of all open positions (USDC, 6 decimals)
     */
    function updatePositionsValue(uint256 _positionsValue) external onlyKeeper {
        // Deviation guard (skip on first update)
        if (positionsValue > 0) {
            uint256 deviation;
            if (_positionsValue > positionsValue) {
                deviation = ((_positionsValue - positionsValue) * 10000) / positionsValue;
            } else {
                deviation = ((positionsValue - _positionsValue) * 10000) / positionsValue;
            }
            if (deviation > maxNavDeviationBps) revert NavDeviationTooLarge();
        }

        positionsValue = _positionsValue;
        lastNavUpdate = block.timestamp;

        emit NavUpdated(_positionsValue, totalAssets(), block.timestamp);
    }

    // ─── Keeper: Strategy Execution ──────────────────

    /**
     * @notice Execute a strategy action (e.g., approve USDC to Polymarket, swap tokens).
     *         The keeper constructs the calldata off-chain.
     * @param target Contract to call
     * @param value ETH value (usually 0)
     * @param data Calldata
     */
    function executeStrategy(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyKeeper returns (bytes memory result) {
        if (target == address(0)) revert ZeroAddress();
        // Prevent calling the vault itself or the staking/treasury contracts
        require(target != address(this), "Cannot call self");
        require(target != address(stakingContract), "Cannot call staking");
        require(target != treasury, "Cannot call treasury");

        bool success;
        (success, result) = target.call{value: value}(data);
        require(success, "Strategy call failed");

        emit StrategyExecuted(target, value, data);
    }

    // ─── Keeper: Performance Fee ─────────────────────

    /**
     * @notice Collect performance fee if NAV has increased above high water mark.
     *         Called by keeper once per 24h.
     */
    function collectPerformanceFee() external onlyKeeper {
        if (block.timestamp < lastFeeCollection + feePeriod) revert FeeTooEarly();

        uint256 currentNav = totalAssets();
        if (currentNav > highWaterMark) {
            uint256 profit = currentNav - highWaterMark;
            uint256 fee = (profit * perfFeeBps) / 10000;

            uint256 available = asset.balanceOf(address(this));
            if (available < fee) {
                // Take what's available (partial fee)
                fee = available;
            }

            if (fee > 0) {
                asset.safeTransfer(treasury, fee);
                emit PerformanceFeeCollected(profit, fee);
            }

            // Update HWM after fee extraction
            highWaterMark = totalAssets();
        }

        lastFeeCollection = block.timestamp;
    }

    // ─── Admin ───────────────────────────────────────

    function setKeeper(address _keeper) external onlyOwner {
        if (_keeper == address(0)) revert ZeroAddress();
        emit KeeperChanged(keeper, _keeper);
        keeper = _keeper;
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert ZeroAddress();
        treasury = _treasury;
    }

    function setStakingContract(address _staking) external onlyOwner {
        if (_staking == address(0)) revert ZeroAddress();
        stakingContract = IGDNStaking(_staking);
    }

    function setMaxNavDeviationBps(uint256 _bps) external onlyOwner {
        require(_bps > 0 && _bps <= 5000, "Invalid bps");
        maxNavDeviationBps = _bps;
    }

    function setPerfFeeBps(uint256 _bps) external onlyOwner {
        require(_bps <= 5000, "Fee too high");
        perfFeeBps = _bps;
    }

    function setFeePeriod(uint256 _period) external onlyOwner {
        require(_period >= 1 hours, "Period too short");
        feePeriod = _period;
    }

    function setDepositFeeBps(uint256[5] calldata _fees) external onlyOwner {
        for (uint256 i = 0; i < 5; i++) {
            require(_fees[i] <= 1000, "Fee too high"); // Max 10%
        }
        depositFeeBps = _fees;
    }

    function setWithdrawFeeBps(uint256[5] calldata _fees) external onlyOwner {
        for (uint256 i = 0; i < 5; i++) {
            require(_fees[i] <= 1000, "Fee too high");
        }
        withdrawFeeBps = _fees;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Internal ────────────────────────────────────

    function _convertToShares(uint256 assets) internal view returns (uint256) {
        if (totalShares == 0) return assets; // 1:1 on first deposit
        return (assets * totalShares) / totalAssets();
    }

    function _convertToAssets(uint256 shares) internal view returns (uint256) {
        if (totalShares == 0) return 0;
        return (shares * totalAssets()) / totalShares;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    /// @notice Allow vault to receive ETH (needed for some Polymarket interactions)
    receive() external payable {}
}
