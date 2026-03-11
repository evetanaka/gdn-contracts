import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { GordonVaultPolygon, MockUSDC } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GordonVaultPolygon", () => {
  let vault: GordonVaultPolygon;
  let usdc: MockUSDC;

  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let bridgeAdmin: SignerWithAddress;
  let alice: SignerWithAddress;

  beforeEach(async () => {
    [owner, keeper, bridgeAdmin, alice] = await ethers.getSigners();

    const UsdcFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await UsdcFactory.deploy();

    const VaultFactory = await ethers.getContractFactory("GordonVaultPolygon");
    vault = (await upgrades.deployProxy(VaultFactory, [
      await usdc.getAddress(),
      "Gordon Crypto Vault (Polygon)",
      "crypto",
      keeper.address,
      bridgeAdmin.address,
    ], { kind: "uups" })) as unknown as GordonVaultPolygon;

    // Fund vault (simulating bridge deposit)
    await usdc.mint(await vault.getAddress(), 50_000_000000n);
  });

  describe("Initialization", () => {
    it("should set correct state", async () => {
      expect(await vault.name()).to.equal("Gordon Crypto Vault (Polygon)");
      expect(await vault.slug()).to.equal("crypto");
      expect(await vault.keeper()).to.equal(keeper.address);
      expect(await vault.bridgeAdmin()).to.equal(bridgeAdmin.address);
    });
  });

  describe("Strategy Execution", () => {
    it("should allow keeper to call external contracts", async () => {
      // Approve USDC spending (simulating Polymarket approval)
      const approveData = usdc.interface.encodeFunctionData("approve", [
        keeper.address, 10_000_000000n
      ]);

      await vault.connect(keeper).executeStrategy(await usdc.getAddress(), 0, approveData);
      expect(await usdc.allowance(await vault.getAddress(), keeper.address)).to.equal(10_000_000000n);
    });

    it("should revert if not keeper", async () => {
      await expect(vault.connect(alice).executeStrategy(await usdc.getAddress(), 0, "0x"))
        .to.be.revertedWithCustomError(vault, "OnlyKeeper");
    });

    it("should prevent calling self", async () => {
      await expect(vault.connect(keeper).executeStrategy(await vault.getAddress(), 0, "0x"))
        .to.be.revertedWith("Cannot call self");
    });
  });

  describe("NAV Update", () => {
    it("should update positions value", async () => {
      await vault.connect(keeper).updatePositionsValue(20_000_000000n);
      expect(await vault.positionsValue()).to.equal(20_000_000000n);
      expect(await vault.totalAssets()).to.equal(50_000_000000n + 20_000_000000n);
    });

    it("should revert if not keeper", async () => {
      await expect(vault.connect(alice).updatePositionsValue(1000n))
        .to.be.revertedWithCustomError(vault, "OnlyKeeper");
    });
  });

  describe("Bridge Admin: Withdraw for Bridge", () => {
    it("should allow admin to withdraw USDC", async () => {
      const before = await usdc.balanceOf(bridgeAdmin.address);
      await vault.connect(bridgeAdmin).withdrawForBridge(10_000_000000n);
      expect(await usdc.balanceOf(bridgeAdmin.address)).to.equal(before + 10_000_000000n);
    });

    it("should revert if not admin", async () => {
      await expect(vault.connect(alice).withdrawForBridge(1000n))
        .to.be.revertedWithCustomError(vault, "OnlyBridgeAdmin");
    });

    it("should revert if insufficient balance", async () => {
      await expect(vault.connect(bridgeAdmin).withdrawForBridge(100_000_000000n))
        .to.be.revertedWithCustomError(vault, "InsufficientBalance");
    });
  });

  describe("Views", () => {
    it("should return free USDC", async () => {
      expect(await vault.freeUsdc()).to.equal(50_000_000000n);
    });

    it("should return total assets including positions", async () => {
      await vault.connect(keeper).updatePositionsValue(5_000_000000n);
      expect(await vault.totalAssets()).to.equal(55_000_000000n);
    });
  });

  describe("Admin", () => {
    it("should allow owner to change keeper", async () => {
      await vault.setKeeper(alice.address);
      expect(await vault.keeper()).to.equal(alice.address);
    });

    it("should allow pause/unpause", async () => {
      await vault.pause();
      await expect(vault.connect(keeper).executeStrategy(await usdc.getAddress(), 0, "0x"))
        .to.be.reverted;
      await vault.unpause();
    });
  });
});
