// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "./interfaces/IGDNStaking.sol";

/**
 * @title Treasury
 * @notice Collects fees from all vaults and executes:
 *         - Buyback & burn: swap USDC → $GDN on DEX, then burn
 *         - Staker rewards: swap USDC → $GDN, distribute to stakers
 *
 *         The split ratio (buyback vs rewards) is configurable by the owner (multisig).
 *         UUPS upgradeable.
 */
contract Treasury is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Reentrancy Guard (transient storage) ────────

    modifier nonReentrant() {
        assembly {
            if tload(0x03) { revert(0, 0) }
            tstore(0x03, 1)
        }
        _;
        assembly {
            tstore(0x03, 0)
        }
    }

    // ─── State ───────────────────────────────────────

    IERC20 public usdc;
    ERC20Burnable public gdnToken;
    IGDNStaking public stakingContract;

    /// @notice DEX router for swaps (QuickSwap / Uniswap V3)
    address public dexRouter;

    /// @notice Authorized fee sources (vault addresses)
    mapping(address => bool) public authorizedSources;

    /// @notice Keeper address (executes buyback + reward distribution)
    address public keeper;

    // ─── Fee Split Configuration ─────────────────────

    /// @notice Buyback & burn ratio in bps (e.g. 5000 = 50%)
    uint256 public buybackRatioBps;

    /// @notice Staker rewards ratio in bps (e.g. 5000 = 50%)
    uint256 public rewardRatioBps;

    // ─── Tracking ────────────────────────────────────

    uint256 public totalUsdcCollected;
    uint256 public totalGdnBurned;
    uint256 public totalGdnDistributed;
    uint256 public totalBuybacks;

    // ─── Events ──────────────────────────────────────

    event FeesReceived(address indexed source, uint256 amount);
    event BuybackBurned(uint256 usdcSpent, uint256 gdnBurned, uint256 gdnPrice);
    event RewardsDistributed(uint256 usdcSpent, uint256 gdnDistributed);
    event RatiosUpdated(uint256 buybackBps, uint256 rewardBps);
    event SourceAuthorized(address indexed source);
    event SourceRevoked(address indexed source);
    event SwapExecuted(uint256 usdcIn, uint256 gdnOut);

    // ─── Errors ──────────────────────────────────────

    error OnlyKeeper();
    error InvalidRatios();
    error ZeroAddress();
    error InsufficientBalance();
    error SwapFailed();

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
        address _usdc,
        address _gdnToken,
        address _stakingContract,
        address _dexRouter,
        address _keeper
    ) external initializer {
        __Ownable_init(msg.sender);
        __Pausable_init();

        if (_usdc == address(0)) revert ZeroAddress();
        if (_gdnToken == address(0)) revert ZeroAddress();
        if (_stakingContract == address(0)) revert ZeroAddress();
        if (_dexRouter == address(0)) revert ZeroAddress();
        if (_keeper == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);
        gdnToken = ERC20Burnable(_gdnToken);
        stakingContract = IGDNStaking(_stakingContract);
        dexRouter = _dexRouter;
        keeper = _keeper;

        // Default: 50/50 split
        buybackRatioBps = 5000;
        rewardRatioBps = 5000;
    }

    // ─── Fee Collection ──────────────────────────────

    /**
     * @notice Called when USDC is transferred to Treasury from vaults.
     *         Vaults send fees directly via safeTransfer; this function
     *         is for explicit tracking if needed.
     */
    function notifyFees(uint256 amount) external {
        require(authorizedSources[msg.sender], "Not authorized source");
        totalUsdcCollected += amount;
        emit FeesReceived(msg.sender, amount);
    }

    // ─── Buyback & Burn + Reward Distribution ────────

    /**
     * @notice Execute buyback & burn + staker reward distribution.
     *         Called by keeper (typically every 24h).
     *
     * @param usdcAmount Total USDC to use for buyback + rewards
     * @param swapCalldata Encoded swap calldata for the DEX router
     *                     (swap USDC → GDN). Constructed off-chain by keeper.
     * @param minGdnTotal Minimum total $GDN expected from the swap (slippage protection)
     */
    function executeBuybackAndReward(
        uint256 usdcAmount,
        bytes calldata swapCalldata,
        uint256 minGdnTotal
    ) external onlyKeeper nonReentrant whenNotPaused {
        uint256 balance = usdc.balanceOf(address(this));
        if (balance < usdcAmount) revert InsufficientBalance();

        // Approve DEX router
        usdc.safeIncreaseAllowance(dexRouter, usdcAmount);

        // Execute swap (USDC → GDN)
        uint256 gdnBefore = gdnToken.balanceOf(address(this));
        (bool success,) = dexRouter.call(swapCalldata);
        if (!success) revert SwapFailed();
        uint256 gdnReceived = gdnToken.balanceOf(address(this)) - gdnBefore;

        require(gdnReceived >= minGdnTotal, "Slippage exceeded");

        emit SwapExecuted(usdcAmount, gdnReceived);

        // Split the received GDN
        uint256 burnAmount = (gdnReceived * buybackRatioBps) / 10000;
        uint256 rewardAmount = gdnReceived - burnAmount;

        // 1. Buyback & Burn
        if (burnAmount > 0) {
            gdnToken.burn(burnAmount);
            totalGdnBurned += burnAmount;

            uint256 gdnPrice = (usdcAmount * 1e18) / gdnReceived; // price in USDC per GDN (scaled)
            emit BuybackBurned(
                (usdcAmount * buybackRatioBps) / 10000,
                burnAmount,
                gdnPrice
            );
        }

        // 2. Staker Rewards
        if (rewardAmount > 0) {
            IERC20(address(gdnToken)).safeIncreaseAllowance(address(stakingContract), rewardAmount);
            stakingContract.distributeRewards(rewardAmount);
            totalGdnDistributed += rewardAmount;

            emit RewardsDistributed(
                usdcAmount - (usdcAmount * buybackRatioBps) / 10000,
                rewardAmount
            );
        }

        totalBuybacks++;
    }

    // ─── Admin ───────────────────────────────────────

    /**
     * @notice Set the buyback/reward split ratio. Must sum to 10000.
     */
    function setRatios(uint256 _buybackBps, uint256 _rewardBps) external onlyOwner {
        if (_buybackBps + _rewardBps != 10000) revert InvalidRatios();
        buybackRatioBps = _buybackBps;
        rewardRatioBps = _rewardBps;
        emit RatiosUpdated(_buybackBps, _rewardBps);
    }

    function authorizeSource(address source) external onlyOwner {
        authorizedSources[source] = true;
        emit SourceAuthorized(source);
    }

    function revokeSource(address source) external onlyOwner {
        authorizedSources[source] = false;
        emit SourceRevoked(source);
    }

    function setKeeper(address _keeper) external onlyOwner {
        if (_keeper == address(0)) revert ZeroAddress();
        keeper = _keeper;
    }

    function setDexRouter(address _router) external onlyOwner {
        if (_router == address(0)) revert ZeroAddress();
        dexRouter = _router;
    }

    function setStakingContract(address _staking) external onlyOwner {
        if (_staking == address(0)) revert ZeroAddress();
        stakingContract = IGDNStaking(_staking);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    /**
     * @notice Emergency: recover tokens accidentally sent to Treasury.
     *         Cannot recover USDC (that's the fee pool) unless paused.
     */
    function recoverToken(address token, uint256 amount, address to) external onlyOwner {
        if (token == address(usdc)) {
            require(paused(), "Pause first to recover USDC");
        }
        IERC20(token).safeTransfer(to, amount);
    }

    // ─── Views ───────────────────────────────────────

    function pendingFees() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function stats() external view returns (
        uint256 _totalCollected,
        uint256 _totalBurned,
        uint256 _totalDistributed,
        uint256 _totalBuybacks,
        uint256 _pendingUsdc
    ) {
        return (
            totalUsdcCollected,
            totalGdnBurned,
            totalGdnDistributed,
            totalBuybacks,
            usdc.balanceOf(address(this))
        );
    }

    // ─── Internal ────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    receive() external payable {}
}
