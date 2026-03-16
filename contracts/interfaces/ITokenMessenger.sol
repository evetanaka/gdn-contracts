// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Circle CCTP TokenMessenger interface
interface ITokenMessenger {
    /**
     * @notice Deposits and burns tokens from sender to be minted on destination domain.
     * @param amount Amount of tokens to burn
     * @param destinationDomain Destination domain identifier
     * @param mintRecipient Address of mint recipient on destination domain (as bytes32)
     * @param burnToken Address of token to burn on source domain
     * @return nonce Unique nonce reserved by message
     */
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);
}
