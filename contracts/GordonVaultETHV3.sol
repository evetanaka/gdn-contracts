// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./GordonVaultETHV2.sol";

/**
 * @title GordonVaultETHV3
 * @notice Upgrade: corrected fee model.
 *
 *         Changes from V2:
 *         1. Management fee (2% annual, share dilution, weekly collection)
 *         2. Performance fee now based on sharePrice (not totalAssets)
 *            — fixes false-profit bug when new deposits inflate totalAssets
 *         3. hwmSharePrice replaces highWaterMark for per-share tracking
 *         4. Single collectFees() entry point for both fee types
 *
 *         Fee math:
 *         - Management: mint `totalShares × mgmtFeeBps / 10000 / 52` shares to treasury
 *         - Performance: if sharePrice > hwmSharePrice,
 *           profit = (sharePrice - hwmSharePrice) × totalShares / 1e6
 *           fee = profit × perfFeeBps / 10000 (transferred as USDC)
 *
 *         Uses 4 slots from V1's __gap (38 → 32, accounting for V2's 2 slots → 30).
 */
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract GordonVaultETHV3 is GordonVaultETHV2 {
    using SafeERC20 for IERC20;

    // ─── New State (V3) ──────────────────────────────

    /// @notice High water mark as share price (6 decimals, like USDC)
    /// Replaces the V1 `highWaterMark` (which tracked totalAssets — incorrect)
    uint256 public hwmSharePrice;

    /// @notice Management fee in basis points (200 = 2% annual)
    uint256 public mgmtFeeBps;

    /// @notice V3 initialization flag
    bool private _v3Initialized;

    /// @notice Timestamp of last management fee collection
    uint256 public lastMgmtFeeCollection;

    // ─── Events ──────────────────────────────────────

    event ManagementFeeCollected(uint256 sharesMinted, uint256 timestamp);
    event PerformanceFeeCollectedV3(uint256 profitPerShare, uint256 totalProfit, uint256 fee, uint256 newHwm);
    event FeesCollected(uint256 mgmtSharesMinted, uint256 perfFeeUsdc, uint256 timestamp);
    event MgmtFeeBpsUpdated(uint256 oldBps, uint256 newBps);
    event HwmSharePriceUpdated(uint256 oldHwm, uint256 newHwm);

    // ─── Errors ──────────────────────────────────────

    error AlreadyInitializedV3();
    error FeeCollectionTooEarly();
    error NoSharesOutstanding();

    // ─── V3 Initializer ──────────────────────────────

    /**
     * @notice One-time initialization for V3 upgrade.
     *         Sets hwmSharePrice to current sharePrice and mgmtFeeBps to 200 (2%).
     *         Must be called by owner immediately after upgrade.
     */
    function initializeV3() external onlyOwner {
        if (_v3Initialized) revert AlreadyInitializedV3();

        uint256 currentPrice = _currentSharePrice();
        hwmSharePrice = currentPrice > 0 ? currentPrice : 1e6; // Default 1 USDC/share
        mgmtFeeBps = 200; // 2% annual
        lastMgmtFeeCollection = block.timestamp;
        _v3Initialized = true;

        emit HwmSharePriceUpdated(0, hwmSharePrice);
        emit MgmtFeeBpsUpdated(0, 200);
    }

    // ─── Core: Collect All Fees ──────────────────────

    /**
     * @notice Collect both management and performance fees.
     *         Should be called weekly by the keeper.
     *
     *         Order matters:
     *         1. Management fee first (dilutes shares → slightly reduces sharePrice)
     *         2. Performance fee second (based on post-mgmt-fee sharePrice vs HWM)
     *
     *         This ensures mgmt fee doesn't create artificial "profit" for perf fee.
     */
    function collectFees() external onlyKeeper {
        if (totalShares == 0) revert NoSharesOutstanding();
        if (block.timestamp < lastFeeCollection + feePeriod) revert FeeCollectionTooEarly();

        uint256 mgmtSharesMinted = 0;
        uint256 perfFeeUsdc = 0;

        // ─── 1. Management Fee (share dilution) ─────
        if (mgmtFeeBps > 0) {
            // Pro-rata based on time elapsed since last mgmt fee
            uint256 elapsed = block.timestamp - lastMgmtFeeCollection;
            // shares = totalShares × mgmtFeeBps / 10000 × elapsed / 365 days
            mgmtSharesMinted = (totalShares * mgmtFeeBps * elapsed) / (10000 * 365 days);

            if (mgmtSharesMinted > 0) {
                shareBalanceOf[treasury] += mgmtSharesMinted;
                totalShares += mgmtSharesMinted;
            }

            lastMgmtFeeCollection = block.timestamp;
            emit ManagementFeeCollected(mgmtSharesMinted, block.timestamp);
        }

        // ─── 2. Performance Fee (per-share HWM) ─────
        uint256 currentPrice = _currentSharePrice();

        if (currentPrice > hwmSharePrice && hwmSharePrice > 0) {
            uint256 profitPerShare = currentPrice - hwmSharePrice;

            // totalProfit = profitPerShare × totalShares / 1e6 (USDC decimals)
            uint256 totalProfit = (profitPerShare * totalShares) / 1e6;

            // fee = totalProfit × perfFeeBps / 10000
            uint256 fee = (totalProfit * perfFeeBps) / 10000;

            // Cap fee at available free USDC
            uint256 available = asset.balanceOf(address(this));
            if (fee > available) {
                fee = available;
            }

            if (fee > 0) {
                asset.safeTransfer(treasury, fee);
                perfFeeUsdc = fee;
            }

            // Update HWM to post-fee share price
            uint256 newHwm = _currentSharePrice();
            emit PerformanceFeeCollectedV3(profitPerShare, totalProfit, fee, newHwm);
            hwmSharePrice = newHwm;
        }

        lastFeeCollection = block.timestamp;

        // Also update legacy highWaterMark for backward compatibility
        highWaterMark = totalAssets();

        emit FeesCollected(mgmtSharesMinted, perfFeeUsdc, block.timestamp);
    }

    // ─── Admin ───────────────────────────────────────

    function setMgmtFeeBps(uint256 _bps) external onlyOwner {
        require(_bps <= 1000, "Mgmt fee too high"); // Max 10% annual
        emit MgmtFeeBpsUpdated(mgmtFeeBps, _bps);
        mgmtFeeBps = _bps;
    }

    /**
     * @notice Emergency: manually reset HWM to current share price.
     *         Use with caution — this forgives any drawdown.
     */
    function resetHwm() external onlyOwner {
        uint256 oldHwm = hwmSharePrice;
        hwmSharePrice = _currentSharePrice();
        emit HwmSharePriceUpdated(oldHwm, hwmSharePrice);
    }

    // ─── Views ───────────────────────────────────────

    /**
     * @notice Pending management fee (shares that would be minted now).
     */
    function pendingMgmtFee() external view returns (uint256 sharesDue) {
        if (totalShares == 0 || mgmtFeeBps == 0) return 0;
        uint256 elapsed = block.timestamp - lastMgmtFeeCollection;
        return (totalShares * mgmtFeeBps * elapsed) / (10000 * 365 days);
    }

    /**
     * @notice Pending performance fee in USDC.
     */
    function pendingPerfFee() external view returns (uint256 feeUsdc) {
        if (totalShares == 0) return 0;
        uint256 currentPrice = _currentSharePrice();
        if (currentPrice <= hwmSharePrice || hwmSharePrice == 0) return 0;
        uint256 profitPerShare = currentPrice - hwmSharePrice;
        uint256 totalProfit = (profitPerShare * totalShares) / 1e6;
        return (totalProfit * perfFeeBps) / 10000;
    }

    /**
     * @notice Full fee status for the admin dashboard.
     */
    function feeStatus() external view returns (
        uint256 currentSharePrice_,
        uint256 hwmSharePrice_,
        uint256 mgmtFeeBps_,
        uint256 perfFeeBps_,
        uint256 pendingMgmtShares,
        uint256 pendingPerfUsdc,
        uint256 lastCollection,
        uint256 nextEligible
    ) {
        currentSharePrice_ = _currentSharePrice();
        hwmSharePrice_ = hwmSharePrice;
        mgmtFeeBps_ = mgmtFeeBps;
        perfFeeBps_ = perfFeeBps;

        // Pending mgmt
        if (totalShares > 0 && mgmtFeeBps > 0) {
            uint256 elapsed = block.timestamp - lastMgmtFeeCollection;
            pendingMgmtShares = (totalShares * mgmtFeeBps * elapsed) / (10000 * 365 days);
        }

        // Pending perf
        if (totalShares > 0 && currentSharePrice_ > hwmSharePrice_ && hwmSharePrice_ > 0) {
            uint256 profitPerShare = currentSharePrice_ - hwmSharePrice_;
            uint256 totalProfit = (profitPerShare * totalShares) / 1e6;
            pendingPerfUsdc = (totalProfit * perfFeeBps) / 10000;
        }

        lastCollection = lastFeeCollection;
        nextEligible = lastFeeCollection + feePeriod;
    }

    // ─── Internal ────────────────────────────────────

    function _currentSharePrice() internal view returns (uint256) {
        if (totalShares == 0) return 1e6; // 1 USDC
        return (totalAssets() * 1e6) / totalShares;
    }
}
