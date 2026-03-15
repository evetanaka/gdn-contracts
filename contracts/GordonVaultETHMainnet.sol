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
 * @title GordonVaultETH (Mainnet)
 * @notice User-facing vault on Ethereum. Merges V1 + V2 (mirror) + V3 (fees).
 *
 *         Users deposit/withdraw USDC. Shares are non-transferable.
 *         Bridge admin moves USDC to Polygon mirror wallet for Polymarket trading.
 *
 *         Fee model (V3):
 *         - Management fee: annual % via share dilution (default 2%)
 *         - Performance fee: per-share HWM, % on profit (default 20%)
 *         - Entry/exit fees: 5-tier loyalty system via GDN staking
 *
 *         totalAssets = freeUSDC + bridgedAmount + positionsValue
 *
 *         UUPS upgradeable. Owner = Gnosis Safe multisig.
 */
contract GordonVaultETHMainnet is
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

    // ─── State (V1) ─────────────────────────────────

    IERC20 public asset;                    // USDC
    string public name;
    string public slug;

    mapping(address => uint256) public shareBalanceOf;
    uint256 public totalShares;

    uint256 public bridgedAmount;           // USDC on Polygon
    uint256 public positionsValue;          // Mark-to-market of Polymarket positions
    uint256 public lastNavUpdate;

    uint256 public highWaterMark;           // Legacy (V1), kept for compatibility
    uint256 public lastFeeCollection;

    address public keeper;
    address public bridgeAdmin;
    address public treasury;
    IGDNStaking public stakingContract;

    uint256 public maxNavDeviationBps;
    uint256 public perfFeeBps;
    uint256 public feePeriod;
    uint256[5] public depositFeeBps;
    uint256[5] public withdrawFeeBps;

    // ─── State (V2) — Mirror ─────────────────────────

    address public polygonMirrorWallet;
    bool private _v2Initialized;            // Unused in mainnet, kept for slot compat

    // ─── State (V3) — Fees ───────────────────────────

    uint256 public hwmSharePrice;           // Per-share HWM (6 decimals)
    uint256 public mgmtFeeBps;              // Management fee (200 = 2%/yr)
    bool private _v3Initialized;            // Unused in mainnet, kept for slot compat
    uint256 public lastMgmtFeeCollection;

    // ─── Storage gap ─────────────────────────────────

    uint256[30] private __gap;

    // ─── Events ──────────────────────────────────────

    // Core
    event Deposited(address indexed user, uint256 assets, uint256 fee, uint256 shares, uint8 tier);
    event Withdrawn(address indexed user, uint256 shares, uint256 assets, uint256 fee, uint8 tier);
    event NavUpdated(uint256 positionsValue, uint256 totalAssets, uint256 timestamp);

    // Bridge
    event BridgedToPolygon(address indexed admin, uint256 amount, uint256 totalBridged);
    event BridgedToMirror(address indexed admin, address indexed mirror, uint256 amount);
    event ReturnedFromPolygon(address indexed admin, uint256 amount, uint256 totalBridged);

    // Mirror
    event MirrorWalletSet(address indexed mirror);

    // Fees
    event ManagementFeeCollected(uint256 sharesMinted, uint256 timestamp);
    event PerformanceFeeCollectedV3(uint256 profitPerShare, uint256 totalProfit, uint256 fee, uint256 newHwm);
    event FeesCollected(uint256 mgmtSharesMinted, uint256 perfFeeUsdc, uint256 timestamp);
    event PerformanceFeeCollected(uint256 profit, uint256 fee); // Legacy compat

    // Admin
    event KeeperChanged(address indexed oldKeeper, address indexed newKeeper);
    event BridgeAdminChanged(address indexed oldAdmin, address indexed newAdmin);
    event MgmtFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event HwmSharePriceUpdated(uint256 oldHwm, uint256 newHwm);

    // ─── Errors ──────────────────────────────────────

    error ZeroAmount();
    error InsufficientShares();
    error InsufficientLiquidity();
    error NavDeviationTooLarge();
    error FeeTooEarly();
    error OnlyKeeper();
    error OnlyBridgeAdmin();
    error ZeroAddress();
    error MirrorNotSet();
    error InvalidMirrorAddress();
    error FeeCollectionTooEarly();
    error NoSharesOutstanding();

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
        address _stakingContract,
        address _mirror
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

        // V1 defaults
        maxNavDeviationBps = 2000;
        perfFeeBps = 2000;          // 20%
        feePeriod = 7 days;
        depositFeeBps = [uint256(100), 75, 50, 25, 10];
        withdrawFeeBps = [uint256(50), 37, 25, 12, 5];
        lastFeeCollection = block.timestamp;

        // V2: mirror
        if (_mirror != address(0)) {
            polygonMirrorWallet = _mirror;
            emit MirrorWalletSet(_mirror);
        }

        // V3: fees
        hwmSharePrice = 1e6;       // 1 USDC/share
        mgmtFeeBps = 200;          // 2% annual
        lastMgmtFeeCollection = block.timestamp;
    }

    // ═══════════════════════════════════════════════════
    // ─── Core: Deposit & Withdraw ────────────────────
    // ═══════════════════════════════════════════════════

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

    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (shareBalanceOf[msg.sender] < shares) revert InsufficientShares();

        uint256 grossAssets = _convertToAssets(shares);

        uint8 tier = stakingContract.loyaltyTier(msg.sender);
        uint256 fee = (grossAssets * withdrawFeeBps[tier]) / 10000;
        assets = grossAssets - fee;

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

    // ═══════════════════════════════════════════════════
    // ─── Bridge ──────────────────────────────────────
    // ═══════════════════════════════════════════════════

    function bridgeToPolygon(uint256 amount) external onlyBridgeAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (polygonMirrorWallet == address(0)) revert MirrorNotSet();

        uint256 available = asset.balanceOf(address(this));
        if (available < amount) revert InsufficientLiquidity();

        asset.safeTransfer(bridgeAdmin, amount);
        bridgedAmount += amount;

        emit BridgedToMirror(msg.sender, polygonMirrorWallet, amount);
        emit BridgedToPolygon(msg.sender, amount, bridgedAmount);
    }

    function returnFromPolygon(uint256 amount) external onlyBridgeAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();

        if (amount > bridgedAmount) {
            bridgedAmount = 0;
        } else {
            bridgedAmount -= amount;
        }

        emit ReturnedFromPolygon(msg.sender, amount, bridgedAmount);
    }

    // ═══════════════════════════════════════════════════
    // ─── Keeper: NAV Update ──────────────────────────
    // ═══════════════════════════════════════════════════

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

    // ═══════════════════════════════════════════════════
    // ─── Keeper: Fee Collection (V3) ─────────────────
    // ═══════════════════════════════════════════════════

    /**
     * @notice Collect management + performance fees.
     *         1. Mgmt fee via share dilution (pro-rata time elapsed)
     *         2. Perf fee on per-share profit above HWM
     */
    function collectFees() external onlyKeeper {
        if (totalShares == 0) revert NoSharesOutstanding();
        if (block.timestamp < lastFeeCollection + feePeriod) revert FeeCollectionTooEarly();

        uint256 mgmtSharesMinted = 0;
        uint256 perfFeeUsdc = 0;

        // ─── 1. Management Fee (share dilution) ─────
        if (mgmtFeeBps > 0) {
            uint256 elapsed = block.timestamp - lastMgmtFeeCollection;
            mgmtSharesMinted = (totalShares * mgmtFeeBps * elapsed) / (10000 * 365 days);

            if (mgmtSharesMinted > 0) {
                shareBalanceOf[treasury] += mgmtSharesMinted;
                totalShares += mgmtSharesMinted;
            }

            lastMgmtFeeCollection = block.timestamp;
            emit ManagementFeeCollected(mgmtSharesMinted, block.timestamp);
        }

        // ─── 2. Performance Fee (per-share HWM) ─────
        uint256 currentPrice = _currentSharePrice();

        if (currentPrice > hwmSharePrice && hwmSharePrice > 0) {
            uint256 profitPerShare = currentPrice - hwmSharePrice;
            uint256 totalProfit = (profitPerShare * totalShares) / 1e6;
            uint256 fee = (totalProfit * perfFeeBps) / 10000;

            uint256 available = asset.balanceOf(address(this));
            if (fee > available) {
                fee = available;
            }

            if (fee > 0) {
                asset.safeTransfer(treasury, fee);
                perfFeeUsdc = fee;
            }

            uint256 newHwm = _currentSharePrice();
            emit PerformanceFeeCollectedV3(profitPerShare, totalProfit, fee, newHwm);
            hwmSharePrice = newHwm;
        }

        lastFeeCollection = block.timestamp;
        highWaterMark = totalAssets();

        emit FeesCollected(mgmtSharesMinted, perfFeeUsdc, block.timestamp);
    }

    // ═══════════════════════════════════════════════════
    // ─── Views ───────────────────────────────────────
    // ═══════════════════════════════════════════════════

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

    function getMirrorWallet() external view returns (address) {
        return polygonMirrorWallet;
    }

    function pendingMgmtFee() external view returns (uint256 sharesDue) {
        if (totalShares == 0 || mgmtFeeBps == 0) return 0;
        uint256 elapsed = block.timestamp - lastMgmtFeeCollection;
        return (totalShares * mgmtFeeBps * elapsed) / (10000 * 365 days);
    }

    function pendingPerfFee() external view returns (uint256 feeUsdc) {
        if (totalShares == 0) return 0;
        uint256 currentPrice = _currentSharePrice();
        if (currentPrice <= hwmSharePrice || hwmSharePrice == 0) return 0;
        uint256 profitPerShare = currentPrice - hwmSharePrice;
        uint256 totalProfit = (profitPerShare * totalShares) / 1e6;
        return (totalProfit * perfFeeBps) / 10000;
    }

    function feeStatus() external view returns (
        uint256 currentSharePrice_,
        uint256 hwmSharePrice_,
        uint256 mgmtFeeBps_,
        uint256 perfFeeBps_,
        uint256 pendingMgmtShares,
        uint256 pendingPerfUsdc,
        uint256 lastCollection,
        uint256 nextEligible
    ) {
        currentSharePrice_ = _currentSharePrice();
        hwmSharePrice_ = hwmSharePrice;
        mgmtFeeBps_ = mgmtFeeBps;
        perfFeeBps_ = perfFeeBps;

        if (totalShares > 0 && mgmtFeeBps > 0) {
            uint256 elapsed = block.timestamp - lastMgmtFeeCollection;
            pendingMgmtShares = (totalShares * mgmtFeeBps * elapsed) / (10000 * 365 days);
        }

        if (totalShares > 0 && currentSharePrice_ > hwmSharePrice_ && hwmSharePrice_ > 0) {
            uint256 profitPerShare = currentSharePrice_ - hwmSharePrice_;
            uint256 totalProfit = (profitPerShare * totalShares) / 1e6;
            pendingPerfUsdc = (totalProfit * perfFeeBps) / 10000;
        }

        lastCollection = lastFeeCollection;
        nextEligible = lastFeeCollection + feePeriod;
    }

    // ═══════════════════════════════════════════════════
    // ─── Admin ───────────────────────────────────────
    // ═══════════════════════════════════════════════════

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

    function setPolygonMirrorWallet(address _mirror) external onlyOwner {
        if (_mirror == address(0)) revert InvalidMirrorAddress();
        polygonMirrorWallet = _mirror;
        emit MirrorWalletSet(_mirror);
    }

    function setMaxNavDeviationBps(uint256 _bps) external onlyOwner {
        require(_bps > 0 && _bps <= 5000, "Invalid bps");
        maxNavDeviationBps = _bps;
    }

    function setPerfFeeBps(uint256 _bps) external onlyOwner {
        require(_bps <= 5000, "Fee too high");
        perfFeeBps = _bps;
    }

    function setMgmtFeeBps(uint256 _bps) external onlyOwner {
        require(_bps <= 1000, "Mgmt fee too high");
        emit MgmtFeeBpsUpdated(mgmtFeeBps, _bps);
        mgmtFeeBps = _bps;
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

    function resetHwm() external onlyOwner {
        uint256 oldHwm = hwmSharePrice;
        hwmSharePrice = _currentSharePrice();
        emit HwmSharePriceUpdated(oldHwm, hwmSharePrice);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ═══════════════════════════════════════════════════
    // ─── Internal ────────────────────────────────────
    // ═══════════════════════════════════════════════════

    function _currentSharePrice() internal view returns (uint256) {
        if (totalShares == 0) return 1e6;
        return (totalAssets() * 1e6) / totalShares;
    }

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
