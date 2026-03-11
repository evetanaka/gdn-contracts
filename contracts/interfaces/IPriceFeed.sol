// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IPriceFeed
 * @notice Minimal price feed interface. Allows swapping implementations
 *         (keeper-pushed → Chainlink) without upgrading consumers.
 */
interface IPriceFeed {
    /// @notice Returns the latest price (8 decimals). Reverts if stale.
    function latestPrice() external view returns (uint256);
}
