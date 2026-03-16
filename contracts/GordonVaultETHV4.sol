// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GordonVaultETHMainnet.sol";
import "./interfaces/ITokenMessenger.sol";

/**
 * @title GordonVaultETH V4 — CCTP Bridge Upgrade
 * @notice Replaces manual bridgeToPolygon with Circle CCTP cross-chain transfer.
 *
 *         Flow: bridgeToPolygon(amount) →
 *           1. Approve USDC to Circle TokenMessenger
 *           2. Call depositForBurn → burns USDC on Ethereum
 *           3. Circle mints native USDC on Polygon to polygonMirrorWallet
 *           4. Backend swaps native USDC → USDC.e on Polygon (for Polymarket)
 *
 *         returnFromPolygon remains accounting-only (actual USDC return
 *         happens via CCTP from Polygon, called by the mirror wallet).
 */
contract GordonVaultETHV4 is GordonVaultETHMainnet {
    // ─── Circle CCTP Constants ───────────────────────
    address public constant TOKEN_MESSENGER = 0xBd3fa81B58Ba92a82136038B25aDec7066af3155;
    uint32 public constant POLYGON_DOMAIN = 7;

    // ─── Events ──────────────────────────────────────
    event BridgedViaCCTP(address indexed initiator, address indexed mirrorWallet, uint256 amount, uint64 cctpNonce);

    // ─── V4 Initializer ─────────────────────────────
    function initializeV4() external reinitializer(4) {
        // No new state to initialize — just marks version 4
    }

    /**
     * @notice Bridge USDC to Polygon mirror wallet via Circle CCTP.
     *         Burns USDC on Ethereum, Circle mints on Polygon (~15-20 min).
     * @param amount Amount of USDC (6 decimals) to bridge
     */
    function bridgeToPolygon(uint256 amount) external override onlyBridgeAdmin nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (polygonMirrorWallet == address(0)) revert MirrorNotSet();

        uint256 available = asset.balanceOf(address(this));
        if (available < amount) revert InsufficientLiquidity();

        // Approve Circle TokenMessenger to spend vault's USDC
        asset.approve(TOKEN_MESSENGER, amount);

        // Convert mirror wallet address to bytes32 (CCTP format)
        bytes32 mintRecipient = bytes32(uint256(uint160(polygonMirrorWallet)));

        // Burn USDC on Ethereum → will be minted on Polygon to mirror wallet
        uint64 cctpNonce = ITokenMessenger(TOKEN_MESSENGER).depositForBurn(
            amount,
            POLYGON_DOMAIN,
            mintRecipient,
            address(asset)
        );

        bridgedAmount += amount;

        emit BridgedViaCCTP(msg.sender, polygonMirrorWallet, amount, cctpNonce);
        emit BridgedToMirror(msg.sender, polygonMirrorWallet, amount);
        emit BridgedToPolygon(msg.sender, amount, bridgedAmount);
    }
}
