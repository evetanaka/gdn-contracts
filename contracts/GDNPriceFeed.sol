// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/IPriceFeed.sol";

/**
 * @title GDNPriceFeed
 * @notice Oracle adapter for $GDN/USD price.
 *         Phase 1: keeper-pushed price from DEX TWAP.
 *         Phase 2: migrate to native Chainlink feed.
 *         NOT upgradeable — if we need to change, deploy a new one
 *         and point the staking contract to it.
 */
contract GDNPriceFeed is IPriceFeed, Ownable {
    /// @notice $GDN price in USD with 8 decimals (Chainlink standard)
    uint256 public price;

    /// @notice Timestamp of last price update
    uint256 public updatedAt;

    /// @notice Address authorized to push price updates
    address public oracle;

    /// @notice Maximum staleness before reads revert (default 1 hour)
    uint256 public maxStaleness = 1 hours;

    /// @notice Maximum price deviation per update in bps (default 50% = 5000 bps)
    uint256 public maxDeviationBps = 5000;

    event PriceUpdated(uint256 price, uint256 timestamp);
    event OracleChanged(address indexed oldOracle, address indexed newOracle);
    event MaxStalenessChanged(uint256 oldValue, uint256 newValue);

    constructor(address _oracle, uint256 _initialPrice) Ownable(msg.sender) {
        require(_oracle != address(0), "PriceFeed: zero oracle");
        require(_initialPrice > 0, "PriceFeed: zero price");
        oracle = _oracle;
        price = _initialPrice;
        updatedAt = block.timestamp;
    }

    // ─── Oracle functions ────────────────────────────

    /**
     * @notice Push a new price. Only callable by the authorized oracle.
     * @param _price New $GDN/USD price (8 decimals)
     */
    function updatePrice(uint256 _price) external {
        require(msg.sender == oracle, "PriceFeed: only oracle");
        require(_price > 0, "PriceFeed: zero price");

        // Deviation guard
        if (price > 0) {
            uint256 deviation = _price > price
                ? ((_price - price) * 10000) / price
                : ((price - _price) * 10000) / price;
            require(deviation <= maxDeviationBps, "PriceFeed: deviation too large");
        }

        price = _price;
        updatedAt = block.timestamp;
        emit PriceUpdated(_price, block.timestamp);
    }

    // ─── Read interface (IPriceFeed) ─────────────────

    /**
     * @notice Returns the latest $GDN price. Reverts if stale.
     * @return $GDN/USD price with 8 decimals
     */
    function latestPrice() external view override returns (uint256) {
        require(block.timestamp - updatedAt <= maxStaleness, "PriceFeed: stale");
        return price;
    }

    /**
     * @notice Returns the latest price and its timestamp.
     */
    function latestPriceInfo() external view returns (uint256 _price, uint256 _updatedAt) {
        return (price, updatedAt);
    }

    // ─── Admin functions ─────────────────────────────

    function setOracle(address _oracle) external onlyOwner {
        require(_oracle != address(0), "PriceFeed: zero oracle");
        emit OracleChanged(oracle, _oracle);
        oracle = _oracle;
    }

    function setMaxStaleness(uint256 _maxStaleness) external onlyOwner {
        require(_maxStaleness >= 5 minutes, "PriceFeed: too short");
        emit MaxStalenessChanged(maxStaleness, _maxStaleness);
        maxStaleness = _maxStaleness;
    }

    function setMaxDeviationBps(uint256 _bps) external onlyOwner {
        require(_bps > 0 && _bps <= 10000, "PriceFeed: invalid bps");
        maxDeviationBps = _bps;
    }
}
