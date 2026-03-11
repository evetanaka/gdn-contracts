// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/**
 * @title GDNToken
 * @notice Gordon Protocol governance & utility token.
 *         Fixed supply of 100,000,000 $GDN minted at deploy to the treasury.
 *         No mint function — supply can only decrease via burns.
 *         NOT upgradeable by design (trust guarantee for holders).
 */
contract GDNToken is ERC20, ERC20Burnable, ERC20Permit {
    uint256 public constant TOTAL_SUPPLY = 100_000_000 * 1e18;

    /**
     * @param treasury Address receiving the full initial supply.
     *                 Expected to be a multisig (Gnosis Safe).
     */
    constructor(address treasury) ERC20("Gordon Token", "GDN") ERC20Permit("Gordon Token") {
        require(treasury != address(0), "GDN: zero treasury");
        _mint(treasury, TOTAL_SUPPLY);
    }
}
