import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("GordonVaultPolygon", function () {
  async function deployFixture() {
    const [owner, keeper, bridgeAdmin, user1] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const Vault = await ethers.getContractFactory("GordonVaultPolygon");
    const vault = await upgrades.deployProxy(Vault, [
      await usdc.getAddress(),
      "Crypto Vault Polygon",
      "crypto-polygon",
      keeper.address,
      bridgeAdmin.address,
    ], { kind: "uups" });

    // Seed vault with USDC (simulating bridge deposit)
    await usdc.mint(await vault.getAddress(), ethers.parseUnits("50000", 6));

    return { vault, usdc, owner, keeper, bridgeAdmin, user1 };
  }

  describe("Initialization", function () {
    it("should initialize correctly", async function () {
      const { vault, keeper, bridgeAdmin } = await loadFixture(deployFixture);
      expect(await vault.name()).to.equal("Crypto Vault Polygon");
      expect(await vault.slug()).to.equal("crypto-polygon");
      expect(await vault.keeper()).to.equal(keeper.address);
      expect(await vault.bridgeAdmin()).to.equal(bridgeAdmin.address);
    });

    it("should reject zero addresses", async function () {
      const Vault = await ethers.getContractFactory("GordonVaultPolygon");
      await expect(
        upgrades.deployProxy(Vault, [
          ethers.ZeroAddress, "x", "x", ethers.ZeroAddress, ethers.ZeroAddress,
        ], { kind: "uups" })
      ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
    });
  });

  describe("Strategy Execution", function () {
    it("should execute strategy (approve call)", async function () {
      const { vault, usdc, keeper } = await loadFixture(deployFixture);

      // Simulate a strategy call: approve USDC spending by some address
      const approveData = usdc.interface.encodeFunctionData("approve", [keeper.address, ethers.parseUnits("1000", 6)]);
      await expect(vault.connect(keeper).executeStrategy(await usdc.getAddress(), 0, approveData))
        .to.emit(vault, "StrategyExecuted");
    });

    it("should reject strategy from non-keeper", async function () {
      const { vault, usdc, bridgeAdmin } = await loadFixture(deployFixture);
      const data = usdc.interface.encodeFunctionData("approve", [bridgeAdmin.address, 100]);
      await expect(vault.connect(bridgeAdmin).executeStrategy(await usdc.getAddress(), 0, data))
        .to.be.revertedWithCustomError(vault, "OnlyKeeper");
    });

    it("should reject self-call", async function () {
      const { vault, keeper } = await loadFixture(deployFixture);
      await expect(vault.connect(keeper).executeStrategy(await vault.getAddress(), 0, "0x"))
        .to.be.revertedWith("Cannot call self");
    });

    it("should reject zero target", async function () {
      const { vault, keeper } = await loadFixture(deployFixture);
      await expect(vault.connect(keeper).executeStrategy(ethers.ZeroAddress, 0, "0x"))
        .to.be.revertedWithCustomError(vault, "ZeroAddress");
    });

    it("should reject when paused", async function () {
      const { vault, usdc, keeper, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).pause();
      const data = usdc.interface.encodeFunctionData("approve", [keeper.address, 100]);
      await expect(vault.connect(keeper).executeStrategy(await usdc.getAddress(), 0, data))
        .to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
  });

  describe("NAV Update", function () {
    it("should update positions value", async function () {
      const { vault, keeper } = await loadFixture(deployFixture);
      await vault.connect(keeper).updatePositionsValue(ethers.parseUnits("10000", 6));
      expect(await vault.positionsValue()).to.equal(ethers.parseUnits("10000", 6));
    });

    it("should calculate totalAssets correctly", async function () {
      const { vault, usdc, keeper } = await loadFixture(deployFixture);
      await vault.connect(keeper).updatePositionsValue(ethers.parseUnits("5000", 6));

      const free = await usdc.balanceOf(await vault.getAddress());
      const positions = ethers.parseUnits("5000", 6);
      expect(await vault.totalAssets()).to.equal(free + positions);
    });

    it("should reject NAV update from non-keeper", async function () {
      const { vault, bridgeAdmin } = await loadFixture(deployFixture);
      await expect(vault.connect(bridgeAdmin).updatePositionsValue(100))
        .to.be.revertedWithCustomError(vault, "OnlyKeeper");
    });
  });

  describe("Bridge Admin", function () {
    it("should withdraw USDC for bridge", async function () {
      const { vault, usdc, bridgeAdmin } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("10000", 6);
      const before = await usdc.balanceOf(bridgeAdmin.address);

      await expect(vault.connect(bridgeAdmin).withdrawForBridge(amount))
        .to.emit(vault, "FundsWithdrawnByAdmin");

      expect(await usdc.balanceOf(bridgeAdmin.address)).to.equal(before + amount);
    });

    it("should reject withdraw from non-admin", async function () {
      const { vault, keeper } = await loadFixture(deployFixture);
      await expect(vault.connect(keeper).withdrawForBridge(100))
        .to.be.revertedWithCustomError(vault, "OnlyBridgeAdmin");
    });

    it("should reject withdraw with zero amount", async function () {
      const { vault, bridgeAdmin } = await loadFixture(deployFixture);
      await expect(vault.connect(bridgeAdmin).withdrawForBridge(0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should reject withdraw exceeding balance", async function () {
      const { vault, bridgeAdmin } = await loadFixture(deployFixture);
      await expect(vault.connect(bridgeAdmin).withdrawForBridge(ethers.parseUnits("999999", 6)))
        .to.be.revertedWithCustomError(vault, "InsufficientBalance");
    });
  });

  describe("Admin", function () {
    it("should set keeper", async function () {
      const { vault, owner, user1 } = await loadFixture(deployFixture);
      await vault.connect(owner).setKeeper(user1.address);
      expect(await vault.keeper()).to.equal(user1.address);
    });

    it("should set bridge admin", async function () {
      const { vault, owner, user1 } = await loadFixture(deployFixture);
      await vault.connect(owner).setBridgeAdmin(user1.address);
      expect(await vault.bridgeAdmin()).to.equal(user1.address);
    });

    it("should pause/unpause", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).pause();
      expect(await vault.paused()).to.be.true;
      await vault.connect(owner).unpause();
      expect(await vault.paused()).to.be.false;
    });
  });

  describe("UUPS Upgrade", function () {
    it("should upgrade by owner", async function () {
      const { vault } = await loadFixture(deployFixture);
      const V2 = await ethers.getContractFactory("GordonVaultPolygon");
      await expect(upgrades.upgradeProxy(await vault.getAddress(), V2)).to.not.be.reverted;
    });

    it("should reject upgrade from non-owner", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      const V2 = await ethers.getContractFactory("GordonVaultPolygon", user1);
      await expect(upgrades.upgradeProxy(await vault.getAddress(), V2))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });
});
