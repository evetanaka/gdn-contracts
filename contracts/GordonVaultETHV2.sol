// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GordonVaultETH.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title GordonVaultETHV2
 * @notice Upgrade: adds polygonMirrorWallet for bridge security.
 *         The mirror address is stored on-chain so the backend can verify
 *         bridge destinations match the contract's expected mirror.
 *
 *         Uses 2 slots from __gap (38 → 36).
 */
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract GordonVaultETHV2 is GordonVaultETH {
    using SafeERC20 for IERC20;

    // ─── New State (V2) ──────────────────────────────

    /// @notice The Polygon EOA wallet that mirrors this vault for Polymarket trading
    address public polygonMirrorWallet;

    /// @notice V2 initialization flag
    bool private _v2Initialized;

    // ─── Events ──────────────────────────────────────

    event MirrorWalletSet(address indexed mirror);
    event BridgedToMirror(address indexed admin, address indexed mirror, uint256 amount);

    // ─── Errors ──────────────────────────────────────

    error AlreadyInitializedV2();
    error MirrorNotSet();
    error InvalidMirrorAddress();

    // ─── V2 Initializer ──────────────────────────────

    /**
     * @notice One-time initialization for V2 upgrade.
     * @param _mirror The Polygon EOA address for this vault's mirror wallet
     */
    function initializeV2(address _mirror) external onlyOwner {
        if (_v2Initialized) revert AlreadyInitializedV2();
        if (_mirror == address(0)) revert ZeroAddress();

        polygonMirrorWallet = _mirror;
        _v2Initialized = true;

        emit MirrorWalletSet(_mirror);
    }

    // ─── Override: Secure Bridge ─────────────────────

    /**
     * @notice Bridge USDC to Polygon. Now emits the mirror address for verification.
     *         The bridge admin still handles the actual bridge transaction,
     *         but the mirror address is publicly verifiable on-chain.
     */
    function bridgeToPolygon(uint256 amount) external override onlyBridgeAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (polygonMirrorWallet == address(0)) revert MirrorNotSet();

        uint256 available = asset.balanceOf(address(this));
        if (available < amount) revert InsufficientLiquidity();

        asset.safeTransfer(bridgeAdmin, amount);
        bridgedAmount += amount;

        emit BridgedToMirror(msg.sender, polygonMirrorWallet, amount);
        emit BridgedToPolygon(msg.sender, amount, bridgedAmount);
    }

    // ─── Admin: Update Mirror ────────────────────────

    /**
     * @notice Update the mirror wallet address. Only owner.
     *         In production, consider adding a timelock here.
     */
    function setPolygonMirrorWallet(address _mirror) external onlyOwner {
        if (_mirror == address(0)) revert InvalidMirrorAddress();
        polygonMirrorWallet = _mirror;
        emit MirrorWalletSet(_mirror);
    }

    // ─── View ────────────────────────────────────────

    /**
     * @notice Returns the expected Polygon destination for bridged funds.
     *         Backend/keeper should verify bridge txs go to this address.
     */
    function getMirrorWallet() external view returns (address) {
        return polygonMirrorWallet;
    }
}
