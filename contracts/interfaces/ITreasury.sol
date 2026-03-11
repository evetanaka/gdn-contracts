// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ITreasury {
    /// @notice Receive fees from vaults
    function receiveFees(uint256 amount) external;
}
