// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IGordonVault {
    /// @notice Returns the total USDC deposited by a user (gross, for loyalty tier calc)
    function getUserTotalDeposited(address user) external view returns (uint256);
}
