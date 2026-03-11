import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

/**
 * MockDEXRouter — a fake DEX router that swaps USDC → GDN at a 1:10 ratio.
 * Must be deployed as a contract for the Treasury to call.
 */
const MOCK_DEX_ROUTER_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockDEXRouter {
    IERC20 public usdc;
    IERC20 public gdn;
    uint256 public rate; // GDN per USDC (scaled by 1e12 for 6→18 decimal conversion)

    constructor(address _usdc, address _gdn) {
        usdc = IERC20(_usdc);
        gdn = IERC20(_gdn);
        rate = 10; // 1 USDC = 10 GDN
    }

    function swap(uint256 usdcAmount) external returns (uint256 gdnOut) {
        usdc.transferFrom(msg.sender, address(this), usdcAmount);
        gdnOut = usdcAmount * rate * 1e12; // 6 decimals → 18 decimals × rate
        require(gdn.transfer(msg.sender, gdnOut), "GDN transfer failed");
    }
}
`;

describe("Treasury", function () {
  async function deployFixture() {
    const [owner, keeper, vault1, vault2, user1] = await ethers.getSigners();

    // Deploy tokens
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const GDNToken = await ethers.getContractFactory("GDNToken");
    const gdn = await GDNToken.deploy(owner.address);

    // Deploy GDNPriceFeed
    const PriceFeed = await ethers.getContractFactory("GDNPriceFeed");
    const priceFeed = await PriceFeed.deploy(owner.address, ethers.parseUnits("1", 8));

    // Deploy GDNStaking (treasury address = placeholder, we'll update after Treasury deploy)
    const Staking = await ethers.getContractFactory("GDNStaking");
    const staking = await upgrades.deployProxy(Staking, [
      await gdn.getAddress(),
      await priceFeed.getAddress(),
      owner.address, // temporary treasury, will update
    ], { kind: "uups" });

    // Deploy MockDEXRouter
    // We need to compile this inline, so let's use a simpler approach:
    // Deploy it via ethers contract factory from compiled artifact
    // Actually, we'll write a mock contract file instead
    const MockDEX = await ethers.getContractFactory("MockDEXRouter");
    const dexRouter = await MockDEX.deploy(await usdc.getAddress(), await gdn.getAddress());

    // Fund the DEX with GDN for swaps
    await gdn.transfer(await dexRouter.getAddress(), ethers.parseUnits("10000000", 18));

    // Deploy Treasury
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    const treasury = await upgrades.deployProxy(TreasuryFactory, [
      await usdc.getAddress(),
      await gdn.getAddress(),
      await staking.getAddress(),
      await dexRouter.getAddress(),
      keeper.address,
    ], { kind: "uups" });

    // Set treasury address in staking
    await staking.setTreasury(await treasury.getAddress());

    // Authorize vaults
    await treasury.authorizeSource(vault1.address);
    await treasury.authorizeSource(vault2.address);

    return { treasury, usdc, gdn, staking, dexRouter, priceFeed, owner, keeper, vault1, vault2, user1 };
  }

  describe("Initialization", function () {
    it("should initialize correctly", async function () {
      const { treasury, keeper } = await loadFixture(deployFixture);
      expect(await treasury.keeper()).to.equal(keeper.address);
      expect(await treasury.buybackRatioBps()).to.equal(5000);
      expect(await treasury.rewardRatioBps()).to.equal(5000);
    });

    it("should reject zero addresses", async function () {
      const T = await ethers.getContractFactory("Treasury");
      await expect(
        upgrades.deployProxy(T, [
          ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        ], { kind: "uups" })
      ).to.be.revertedWithCustomError(T, "ZeroAddress");
    });
  });

  describe("Fee Collection", function () {
    it("should track fees from authorized source", async function () {
      const { treasury, usdc, vault1 } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 6);

      // Vault sends USDC to treasury
      await usdc.mint(vault1.address, amount);
      await usdc.connect(vault1).transfer(await treasury.getAddress(), amount);

      // Notify
      await expect(treasury.connect(vault1).notifyFees(amount))
        .to.emit(treasury, "FeesReceived");

      expect(await treasury.totalUsdcCollected()).to.equal(amount);
    });

    it("should reject notify from unauthorized source", async function () {
      const { treasury, user1 } = await loadFixture(deployFixture);
      await expect(treasury.connect(user1).notifyFees(100))
        .to.be.revertedWith("Not authorized source");
    });
  });

  describe("Buyback & Reward", function () {
    it("should execute buyback and reward distribution", async function () {
      const { treasury, usdc, gdn, dexRouter, keeper, staking, owner } = await loadFixture(deployFixture);

      // Fund treasury with USDC fees
      const feeAmount = ethers.parseUnits("10000", 6);
      await usdc.mint(await treasury.getAddress(), feeAmount);

      // We need a staker to receive rewards — stake some GDN first
      await gdn.transfer(owner.address, ethers.parseUnits("1000", 18));
      await gdn.connect(owner).approve(await staking.getAddress(), ethers.MaxUint256);
      await staking.connect(owner).stake(ethers.parseUnits("1000", 18), 3); // 3 month lock

      // Build swap calldata
      const swapCalldata = dexRouter.interface.encodeFunctionData("swap", [feeAmount]);
      const expectedGdn = BigInt(feeAmount) * 10n * 1000000000000n; // rate=10, 6→18 decimals

      await expect(treasury.connect(keeper).executeBuybackAndReward(
        feeAmount,
        swapCalldata,
        1 // min GDN (we know the mock gives fixed rate)
      )).to.emit(treasury, "SwapExecuted");

      expect(await treasury.totalBuybacks()).to.equal(1);
      expect(await treasury.totalGdnBurned()).to.be.gt(0);
      expect(await treasury.totalGdnDistributed()).to.be.gt(0);
    });

    it("should reject from non-keeper", async function () {
      const { treasury, user1 } = await loadFixture(deployFixture);
      await expect(treasury.connect(user1).executeBuybackAndReward(100, "0x", 0))
        .to.be.revertedWithCustomError(treasury, "OnlyKeeper");
    });

    it("should reject with insufficient balance", async function () {
      const { treasury, keeper } = await loadFixture(deployFixture);
      await expect(treasury.connect(keeper).executeBuybackAndReward(
        ethers.parseUnits("999999", 6), "0x", 0
      )).to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });

    it("should reject when paused", async function () {
      const { treasury, usdc, keeper, owner } = await loadFixture(deployFixture);
      await usdc.mint(await treasury.getAddress(), ethers.parseUnits("100", 6));
      await treasury.connect(owner).pause();
      await expect(treasury.connect(keeper).executeBuybackAndReward(100, "0x", 0))
        .to.be.revertedWithCustomError(treasury, "EnforcedPause");
    });
  });

  describe("Admin", function () {
    it("should set ratios", async function () {
      const { treasury, owner } = await loadFixture(deployFixture);
      await treasury.connect(owner).setRatios(7000, 3000);
      expect(await treasury.buybackRatioBps()).to.equal(7000);
      expect(await treasury.rewardRatioBps()).to.equal(3000);
    });

    it("should reject invalid ratios (not summing to 10000)", async function () {
      const { treasury, owner } = await loadFixture(deployFixture);
      await expect(treasury.connect(owner).setRatios(5000, 4000))
        .to.be.revertedWithCustomError(treasury, "InvalidRatios");
    });

    it("should authorize and revoke sources", async function () {
      const { treasury, owner, user1 } = await loadFixture(deployFixture);
      await treasury.connect(owner).authorizeSource(user1.address);
      expect(await treasury.authorizedSources(user1.address)).to.be.true;
      await treasury.connect(owner).revokeSource(user1.address);
      expect(await treasury.authorizedSources(user1.address)).to.be.false;
    });

    it("should set keeper", async function () {
      const { treasury, owner, user1 } = await loadFixture(deployFixture);
      await treasury.connect(owner).setKeeper(user1.address);
      expect(await treasury.keeper()).to.equal(user1.address);
    });

    it("should set dex router", async function () {
      const { treasury, owner, user1 } = await loadFixture(deployFixture);
      await treasury.connect(owner).setDexRouter(user1.address);
      expect(await treasury.dexRouter()).to.equal(user1.address);
    });

    it("should recover tokens (non-USDC)", async function () {
      const { treasury, gdn, owner, user1 } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 18);
      await gdn.transfer(await treasury.getAddress(), amount);
      await treasury.connect(owner).recoverToken(await gdn.getAddress(), amount, user1.address);
      expect(await gdn.balanceOf(user1.address)).to.equal(amount);
    });

    it("should not recover USDC unless paused", async function () {
      const { treasury, usdc, owner, user1 } = await loadFixture(deployFixture);
      await usdc.mint(await treasury.getAddress(), ethers.parseUnits("100", 6));
      await expect(treasury.connect(owner).recoverToken(await usdc.getAddress(), 100, user1.address))
        .to.be.revertedWith("Pause first to recover USDC");
    });

    it("should recover USDC when paused", async function () {
      const { treasury, usdc, owner, user1 } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("100", 6);
      await usdc.mint(await treasury.getAddress(), amount);
      await treasury.connect(owner).pause();
      await treasury.connect(owner).recoverToken(await usdc.getAddress(), amount, user1.address);
      expect(await usdc.balanceOf(user1.address)).to.equal(amount);
    });
  });

  describe("Views", function () {
    it("should return pending fees", async function () {
      const { treasury, usdc } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("500", 6);
      await usdc.mint(await treasury.getAddress(), amount);
      expect(await treasury.pendingFees()).to.equal(amount);
    });

    it("should return stats", async function () {
      const { treasury } = await loadFixture(deployFixture);
      const [collected, burned, distributed, buybacks, pending] = await treasury.stats();
      expect(collected).to.equal(0);
      expect(burned).to.equal(0);
      expect(distributed).to.equal(0);
      expect(buybacks).to.equal(0);
    });
  });

  describe("UUPS Upgrade", function () {
    it("should upgrade by owner", async function () {
      const { treasury } = await loadFixture(deployFixture);
      const V2 = await ethers.getContractFactory("Treasury");
      await expect(upgrades.upgradeProxy(await treasury.getAddress(), V2)).to.not.be.reverted;
    });

    it("should reject upgrade from non-owner", async function () {
      const { treasury, user1 } = await loadFixture(deployFixture);
      const V2 = await ethers.getContractFactory("Treasury", user1);
      await expect(upgrades.upgradeProxy(await treasury.getAddress(), V2))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });
});
