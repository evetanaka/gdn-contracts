// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGDNStaking {
    /// @notice Returns the loyalty tier for a user (0=None, 1=Bronze, 2=Silver, 3=Gold, 4=Platinum)
    function loyaltyTier(address user) external view returns (uint8);

    /// @notice Called by vaults to update a user's total deposited amount
    function updateDeposits(address user, int256 delta) external;

    /// @notice Called by Treasury to distribute $GDN rewards to stakers
    function distributeRewards(uint256 amount) external;

    /// @notice Returns the total USDC deposited by a user across all vaults
    function totalDeposited(address user) external view returns (uint256);
}
