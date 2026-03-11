// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title GordonVaultPolygon
 * @notice Trading vault on Polygon. Receives bridged USDC from Ethereum.
 *         The keeper executes trades on Polymarket from this vault.
 *
 *         No user-facing functions (deposit/withdraw). No shares. No fees.
 *         Just a secure USDC pool with keeper-only trade execution
 *         and admin-only fund management (bridge back to ETH).
 *
 *         UUPS upgradeable.
 */
contract GordonVaultPolygon is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Reentrancy Guard (transient storage) ────────

    modifier nonReentrant() {
        assembly {
            if tload(0x04) { revert(0, 0) }
            tstore(0x04, 1)
        }
        _;
        assembly {
            tstore(0x04, 0)
        }
    }

    // ─── State ───────────────────────────────────────

    IERC20 public usdc;
    string public name;
    string public slug;

    address public keeper;
    address public bridgeAdmin;

    /// @notice Total USDC value locked in Polymarket positions (keeper-updated)
    uint256 public positionsValue;
    uint256 public lastNavUpdate;

    // ─── Events ──────────────────────────────────────

    event StrategyExecuted(address indexed target, uint256 value, bytes data);
    event NavUpdated(uint256 positionsValue, uint256 totalAssets, uint256 timestamp);
    event FundsWithdrawnByAdmin(address indexed admin, uint256 amount);

    // ─── Errors ──────────────────────────────────────

    error OnlyKeeper();
    error OnlyBridgeAdmin();
    error ZeroAddress();
    error ZeroAmount();
    error InsufficientBalance();

    // ─── Storage gap ─────────────────────────────────

    uint256[44] private __gap;

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
        address _usdc,
        string calldata _name,
        string calldata _slug,
        address _keeper,
        address _bridgeAdmin
    ) external initializer {
        __Ownable_init(msg.sender);
        __Pausable_init();

        if (_usdc == address(0)) revert ZeroAddress();
        if (_keeper == address(0)) revert ZeroAddress();
        if (_bridgeAdmin == address(0)) revert ZeroAddress();

        usdc = IERC20(_usdc);
        name = _name;
        slug = _slug;
        keeper = _keeper;
        bridgeAdmin = _bridgeAdmin;
    }

    // ─── Keeper: Trade Execution ─────────────────────

    /**
     * @notice Execute a trade on Polymarket (approve USDC, interact with CTF exchange).
     *         The keeper constructs calldata off-chain.
     * @param target Contract to call (e.g., Polymarket exchange, USDC for approvals)
     * @param value ETH value (usually 0)
     * @param data Calldata
     */
    function executeStrategy(
        address target,
        uint256 value,
        bytes calldata data
    ) external onlyKeeper nonReentrant whenNotPaused returns (bytes memory result) {
        if (target == address(0)) revert ZeroAddress();
        require(target != address(this), "Cannot call self");

        bool success;
        (success, result) = target.call{value: value}(data);
        require(success, "Strategy call failed");

        emit StrategyExecuted(target, value, data);
    }

    /**
     * @notice Update the value of open Polymarket positions.
     */
    function updatePositionsValue(uint256 _positionsValue) external onlyKeeper {
        positionsValue = _positionsValue;
        lastNavUpdate = block.timestamp;
        emit NavUpdated(_positionsValue, totalAssets(), block.timestamp);
    }

    // ─── Bridge Admin: Fund Management ───────────────

    /**
     * @notice Withdraw USDC to bridge back to Ethereum.
     *         Called by bridge admin after closing positions or to return profits.
     */
    function withdrawForBridge(uint256 amount) external onlyBridgeAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 available = usdc.balanceOf(address(this));
        if (available < amount) revert InsufficientBalance();

        usdc.safeTransfer(bridgeAdmin, amount);
        emit FundsWithdrawnByAdmin(msg.sender, amount);
    }

    // ─── Views ───────────────────────────────────────

    /**
     * @notice Total assets = free USDC + positions value
     */
    function totalAssets() public view returns (uint256) {
        return usdc.balanceOf(address(this)) + positionsValue;
    }

    function freeUsdc() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    // ─── Admin ───────────────────────────────────────

    function setKeeper(address _keeper) external onlyOwner {
        if (_keeper == address(0)) revert ZeroAddress();
        keeper = _keeper;
    }

    function setBridgeAdmin(address _admin) external onlyOwner {
        if (_admin == address(0)) revert ZeroAddress();
        bridgeAdmin = _admin;
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Internal ────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    receive() external payable {}
}
