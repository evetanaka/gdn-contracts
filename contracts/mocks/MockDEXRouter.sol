// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title MockDEXRouter
 * @notice Test-only mock that simulates a DEX router swap (USDC → GDN).
 *         Fixed rate: 1 USDC (6 dec) = 10 GDN (18 dec).
 */
contract MockDEXRouter {
    IERC20 public usdc;
    IERC20 public gdn;

    constructor(address _usdc, address _gdn) {
        usdc = IERC20(_usdc);
        gdn = IERC20(_gdn);
    }

    function swap(uint256 usdcAmount) external returns (uint256 gdnOut) {
        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        gdnOut = usdcAmount * 10 * 1e12; // 6 dec → 18 dec, rate 10:1
        require(gdn.transfer(msg.sender, gdnOut), "GDN transfer failed");
    }
}
