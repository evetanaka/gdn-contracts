// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./interfaces/IGDNStaking.sol";

/**
 * @title GordonVaultETH
 * @notice User-facing vault on Ethereum. Users deposit/withdraw USDC here.
 *         Shares, fees, and loyalty tier calculation all happen on this chain.
 *
 *         An admin wallet bridges USDC in daily batches to a paired
 *         GordonVaultPolygon where the keeper executes Polymarket trades.
 *
 *         totalAssets = freeUSDC + bridgedAmount + positionsValue
 *         - freeUSDC: USDC sitting in this contract (available for withdrawals)
 *         - bridgedAmount: USDC sent to Polygon (tracked automatically on bridge/return)
 *         - positionsValue: value of open Polymarket positions (updated by keeper)
 *
 *         UUPS upgradeable.
 */
contract GordonVaultETH is
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

    IERC20 public asset; // USDC
    string public name;
    string public slug;

    /// @notice Share balances (non-transferable)
    mapping(address => uint256) public shareBalanceOf;
    uint256 public totalShares;

    /// @notice USDC currently bridged to Polygon (auto-tracked)
    uint256 public bridgedAmount;

    /// @notice Value of open Polymarket positions on Polygon (keeper-updated)
    uint256 public positionsValue;
    uint256 public lastNavUpdate;

    /// @notice Performance fee tracking
    uint256 public highWaterMark;
    uint256 public lastFeeCollection;

    /// @notice External contracts & roles
    address public keeper;
    address public bridgeAdmin; // Wallet that bridges funds (Réda)
    address public treasury;
    IGDNStaking public stakingContract;

    // ─── Configuration ───────────────────────────────

    uint256 public maxNavDeviationBps;
    uint256 public perfFeeBps;
    uint256 public feePeriod;
    uint256[5] public depositFeeBps;
    uint256[5] public withdrawFeeBps;

    // ─── Events ──────────────────────────────────────

    event Deposited(address indexed user, uint256 assets, uint256 fee, uint256 shares, uint8 tier);
    event Withdrawn(address indexed user, uint256 shares, uint256 assets, uint256 fee, uint8 tier);
    event BridgedToPolygon(address indexed admin, uint256 amount, uint256 totalBridged);
    event ReturnedFromPolygon(address indexed admin, uint256 amount, uint256 totalBridged);
    event NavUpdated(uint256 positionsValue, uint256 totalAssets, uint256 timestamp);
    event PerformanceFeeCollected(uint256 profit, uint256 fee);
    event KeeperChanged(address indexed oldKeeper, address indexed newKeeper);
    event BridgeAdminChanged(address indexed oldAdmin, address indexed newAdmin);

    // ─── Errors ──────────────────────────────────────

    error ZeroAmount();
    error InsufficientShares();
    error InsufficientLiquidity();
    error NavDeviationTooLarge();
    error FeeTooEarly();
    error OnlyKeeper();
    error OnlyBridgeAdmin();
    error ZeroAddress();

    // ─── Storage gap ─────────────────────────────────

    uint256[38] private __gap;

    // ─── Modifiers ───────────────────────────────────

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert OnlyKeeper();
        _;
    }

    modifier onlyBridgeAdmin() {
        if (msg.sender != bridgeAdmin) revert OnlyBridgeAdmin();
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
        address _bridgeAdmin,
        address _treasury,
        address _stakingContract
    ) external initializer {
        __Ownable_init(msg.sender);
        __Pausable_init();

        if (_asset == address(0)) revert ZeroAddress();
        if (_keeper == address(0)) revert ZeroAddress();
        if (_bridgeAdmin == address(0)) revert ZeroAddress();
        if (_treasury == address(0)) revert ZeroAddress();
        if (_stakingContract == address(0)) revert ZeroAddress();

        asset = IERC20(_asset);
        name = _name;
        slug = _slug;
        keeper = _keeper;
        bridgeAdmin = _bridgeAdmin;
        treasury = _treasury;
        stakingContract = IGDNStaking(_stakingContract);

        maxNavDeviationBps = 2000;
        perfFeeBps = 2000;
        feePeriod = 24 hours;

        depositFeeBps = [uint256(100), 75, 50, 25, 10];
        withdrawFeeBps = [uint256(50), 37, 25, 12, 5];

        lastFeeCollection = block.timestamp;
    }

    // ─── Core: Deposit ───────────────────────────────

    /**
     * @notice Deposit USDC into the vault. Shares minted based on current NAV.
     */
    function deposit(uint256 assets) external nonReentrant whenNotPaused returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();

        uint8 tier = stakingContract.loyaltyTier(msg.sender);
        uint256 fee = (assets * depositFeeBps[tier]) / 10000;
        uint256 net = assets - fee;

        shares = _convertToShares(net);
        if (shares == 0) revert ZeroAmount();

        asset.safeTransferFrom(msg.sender, address(this), net);
        if (fee > 0) {
            asset.safeTransferFrom(msg.sender, treasury, fee);
        }

        shareBalanceOf[msg.sender] += shares;
        totalShares += shares;

        if (highWaterMark == 0) {
            highWaterMark = totalAssets();
        }

        stakingContract.updateDeposits(msg.sender, int256(uint256(net)));

        emit Deposited(msg.sender, assets, fee, shares, tier);
    }

    /**
     * @notice Withdraw USDC by redeeming shares. Only from free USDC (not bridged).
     */
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (shareBalanceOf[msg.sender] < shares) revert InsufficientShares();

        uint256 grossAssets = _convertToAssets(shares);

        uint8 tier = stakingContract.loyaltyTier(msg.sender);
        uint256 fee = (grossAssets * withdrawFeeBps[tier]) / 10000;
        assets = grossAssets - fee;

        // Can only withdraw from free USDC on Ethereum
        uint256 available = asset.balanceOf(address(this));
        if (available < grossAssets) revert InsufficientLiquidity();

        shareBalanceOf[msg.sender] -= shares;
        totalShares -= shares;

        if (fee > 0) {
            asset.safeTransfer(treasury, fee);
        }
        asset.safeTransfer(msg.sender, assets);

        stakingContract.updateDeposits(msg.sender, -int256(uint256(assets)));

        emit Withdrawn(msg.sender, shares, assets, fee, tier);
    }

    // ─── Bridge: Admin-controlled ────────────────────

    /**
     * @notice Bridge USDC to Polygon for trading. Called by bridge admin.
     *         The admin handles the actual bridge transaction externally.
     *         This function transfers USDC to the admin and tracks the amount.
     * @param amount USDC to bridge (6 decimals)
     */
    function bridgeToPolygon(uint256 amount) external onlyBridgeAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 available = asset.balanceOf(address(this));
        if (available < amount) revert InsufficientLiquidity();

        asset.safeTransfer(bridgeAdmin, amount);
        bridgedAmount += amount;

        emit BridgedToPolygon(msg.sender, amount, bridgedAmount);
    }

    /**
     * @notice Record USDC returned from Polygon. The admin sends USDC back
     *         to the vault and calls this to update tracking.
     * @param amount USDC returned (6 decimals). Must have been transferred first.
     */
    function returnFromPolygon(uint256 amount) external onlyBridgeAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Admin must have already transferred USDC to this contract
        // We just update the tracking
        if (amount > bridgedAmount) {
            bridgedAmount = 0; // Profit case: returned more than bridged
        } else {
            bridgedAmount -= amount;
        }

        emit ReturnedFromPolygon(msg.sender, amount, bridgedAmount);
    }

    // ─── Views ───────────────────────────────────────

    /**
     * @notice Total assets = free USDC + bridged USDC + positions value
     */
    function totalAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) + bridgedAmount + positionsValue;
    }

    function sharePrice() external view returns (uint256) {
        if (totalShares == 0) return 1e6;
        return (totalAssets() * 1e6) / totalShares;
    }

    function convertToShares(uint256 assets) external view returns (uint256) {
        return _convertToShares(assets);
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return _convertToAssets(shares);
    }

    function freeAssets() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function userPosition(address user) external view returns (uint256 shares, uint256 value) {
        shares = shareBalanceOf[user];
        value = shares > 0 ? _convertToAssets(shares) : 0;
    }

    // ─── Keeper: NAV Update ──────────────────────────

    /**
     * @notice Update the value of Polymarket positions on Polygon.
     *         This represents the mark-to-market value of open bets.
     */
    function updatePositionsValue(uint256 _positionsValue) external onlyKeeper {
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

    // ─── Keeper: Performance Fee ─────────────────────

    function collectPerformanceFee() external onlyKeeper {
        if (block.timestamp < lastFeeCollection + feePeriod) revert FeeTooEarly();

        uint256 currentNav = totalAssets();
        if (currentNav > highWaterMark) {
            uint256 profit = currentNav - highWaterMark;
            uint256 fee = (profit * perfFeeBps) / 10000;

            uint256 available = asset.balanceOf(address(this));
            if (available < fee) {
                fee = available;
            }

            if (fee > 0) {
                asset.safeTransfer(treasury, fee);
                emit PerformanceFeeCollected(profit, fee);
            }

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

    function setBridgeAdmin(address _admin) external onlyOwner {
        if (_admin == address(0)) revert ZeroAddress();
        emit BridgeAdminChanged(bridgeAdmin, _admin);
        bridgeAdmin = _admin;
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
        for (uint256 i = 0; i < 5; i++) require(_fees[i] <= 1000, "Fee too high");
        depositFeeBps = _fees;
    }

    function setWithdrawFeeBps(uint256[5] calldata _fees) external onlyOwner {
        for (uint256 i = 0; i < 5; i++) require(_fees[i] <= 1000, "Fee too high");
        withdrawFeeBps = _fees;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Internal ────────────────────────────────────

    function _convertToShares(uint256 assets) internal view returns (uint256) {
        if (totalShares == 0) return assets;
        return (assets * totalShares) / totalAssets();
    }

    function _convertToAssets(uint256 shares) internal view returns (uint256) {
        if (totalShares == 0) return 0;
        return (shares * totalAssets()) / totalShares;
    }

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    receive() external payable {}
}
