import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  GordonVaultETH,
  GDNToken,
  GDNPriceFeed,
  GDNStaking,
  MockUSDC,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("GordonVaultETH", () => {
  let vault: GordonVaultETH;
  let usdc: MockUSDC;
  let gdnToken: GDNToken;
  let priceFeed: GDNPriceFeed;
  let staking: GDNStaking;

  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let bridgeAdmin: SignerWithAddress;
  let treasuryWallet: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  const GDN_PRICE = 84200000n;
  const DEPOSIT_AMOUNT = 10_000_000000n;

  beforeEach(async () => {
    [owner, keeper, bridgeAdmin, treasuryWallet, alice, bob] = await ethers.getSigners();

    const UsdcFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await UsdcFactory.deploy();

    const TokenFactory = await ethers.getContractFactory("GDNToken");
    gdnToken = await TokenFactory.deploy(treasuryWallet.address);

    const FeedFactory = await ethers.getContractFactory("GDNPriceFeed");
    priceFeed = await FeedFactory.deploy(owner.address, GDN_PRICE);

    const StakingFactory = await ethers.getContractFactory("GDNStaking");
    staking = (await upgrades.deployProxy(StakingFactory, [
      await gdnToken.getAddress(),
      await priceFeed.getAddress(),
      treasuryWallet.address,
    ], { kind: "uups" })) as unknown as GDNStaking;

    const VaultFactory = await ethers.getContractFactory("GordonVaultETH");
    vault = (await upgrades.deployProxy(VaultFactory, [
      await usdc.getAddress(),
      "Gordon Crypto Vault",
      "crypto",
      keeper.address,
      bridgeAdmin.address,
      treasuryWallet.address,
      await staking.getAddress(),
    ], { kind: "uups" })) as unknown as GordonVaultETH;

    await staking.registerVault(await vault.getAddress());

    await usdc.mint(alice.address, 100_000_000000n);
    await usdc.mint(bob.address, 100_000_000000n);
    await usdc.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await vault.getAddress(), ethers.MaxUint256);
  });

  describe("Initialization", () => {
    it("should set correct initial state", async () => {
      expect(await vault.name()).to.equal("Gordon Crypto Vault");
      expect(await vault.slug()).to.equal("crypto");
      expect(await vault.keeper()).to.equal(keeper.address);
      expect(await vault.bridgeAdmin()).to.equal(bridgeAdmin.address);
      expect(await vault.totalShares()).to.equal(0);
      expect(await vault.bridgedAmount()).to.equal(0);
    });
  });

  describe("Deposit", () => {
    it("should accept deposit and mint shares (1:1 first deposit)", async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
      const fee = DEPOSIT_AMOUNT * 100n / 10000n;
      const net = DEPOSIT_AMOUNT - fee;
      expect(await vault.shareBalanceOf(alice.address)).to.equal(net);
      expect(await vault.totalAssets()).to.equal(net);
    });

    it("should send fee to treasury", async () => {
      const before = await usdc.balanceOf(treasuryWallet.address);
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
      const after_ = await usdc.balanceOf(treasuryWallet.address);
      expect(after_ - before).to.equal(DEPOSIT_AMOUNT * 100n / 10000n);
    });

    it("should revert on zero", async () => {
      await expect(vault.connect(alice).deposit(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should emit Deposited event", async () => {
      await expect(vault.connect(alice).deposit(DEPOSIT_AMOUNT)).to.emit(vault, "Deposited");
    });
  });

  describe("Withdraw", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
    });

    it("should withdraw and return USDC", async () => {
      const shares = await vault.shareBalanceOf(alice.address);
      const before = await usdc.balanceOf(alice.address);
      await vault.connect(alice).withdraw(shares);
      const after_ = await usdc.balanceOf(alice.address);
      expect(after_).to.be.gt(before);
      expect(await vault.shareBalanceOf(alice.address)).to.equal(0);
    });

    it("should revert with insufficient shares", async () => {
      const shares = await vault.shareBalanceOf(alice.address);
      await expect(vault.connect(alice).withdraw(shares + 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientShares");
    });

    it("should revert if liquidity bridged away", async () => {
      // Bridge most USDC to Polygon
      const freeUsdc = await usdc.balanceOf(await vault.getAddress());
      await vault.connect(bridgeAdmin).bridgeToPolygon(freeUsdc - 100n); // leave 100 wei

      const shares = await vault.shareBalanceOf(alice.address);
      await expect(vault.connect(alice).withdraw(shares))
        .to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
    });
  });

  describe("Bridge to Polygon", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
    });

    it("should transfer USDC to bridge admin and track amount", async () => {
      const amount = 5_000_000000n;
      const adminBefore = await usdc.balanceOf(bridgeAdmin.address);

      await vault.connect(bridgeAdmin).bridgeToPolygon(amount);

      expect(await usdc.balanceOf(bridgeAdmin.address)).to.equal(adminBefore + amount);
      expect(await vault.bridgedAmount()).to.equal(amount);
    });

    it("should maintain totalAssets after bridge", async () => {
      const totalBefore = await vault.totalAssets();
      await vault.connect(bridgeAdmin).bridgeToPolygon(5_000_000000n);
      // totalAssets = freeUSDC (decreased) + bridgedAmount (increased) = same
      expect(await vault.totalAssets()).to.equal(totalBefore);
    });

    it("should revert if not bridge admin", async () => {
      await expect(vault.connect(alice).bridgeToPolygon(1000n))
        .to.be.revertedWithCustomError(vault, "OnlyBridgeAdmin");
    });

    it("should revert if insufficient liquidity", async () => {
      const free = await usdc.balanceOf(await vault.getAddress());
      await expect(vault.connect(bridgeAdmin).bridgeToPolygon(free + 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
    });

    it("should emit BridgedToPolygon event", async () => {
      await expect(vault.connect(bridgeAdmin).bridgeToPolygon(1_000_000000n))
        .to.emit(vault, "BridgedToPolygon");
    });
  });

  describe("Return from Polygon", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
      await vault.connect(bridgeAdmin).bridgeToPolygon(5_000_000000n);
    });

    it("should decrease bridgedAmount on return", async () => {
      // Admin sends USDC back to vault
      await usdc.mint(await vault.getAddress(), 3_000_000000n);
      await vault.connect(bridgeAdmin).returnFromPolygon(3_000_000000n);

      expect(await vault.bridgedAmount()).to.equal(2_000_000000n);
    });

    it("should handle return > bridged (profit)", async () => {
      // Return more than bridged (trading profit)
      await usdc.mint(await vault.getAddress(), 7_000_000000n);
      await vault.connect(bridgeAdmin).returnFromPolygon(7_000_000000n);

      expect(await vault.bridgedAmount()).to.equal(0);
    });

    it("should emit ReturnedFromPolygon event", async () => {
      await usdc.mint(await vault.getAddress(), 1_000_000000n);
      await expect(vault.connect(bridgeAdmin).returnFromPolygon(1_000_000000n))
        .to.emit(vault, "ReturnedFromPolygon");
    });
  });

  describe("NAV with bridged funds", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
    });

    it("totalAssets should include bridged + positions", async () => {
      await vault.connect(bridgeAdmin).bridgeToPolygon(5_000_000000n);
      await vault.connect(keeper).updatePositionsValue(2_000_000000n);

      const fee = DEPOSIT_AMOUNT * 100n / 10000n;
      const net = DEPOSIT_AMOUNT - fee;
      // free = net - 5k, bridged = 5k, positions = 2k
      expect(await vault.totalAssets()).to.equal(net + 2_000_000000n);
      // free USDC = net - 5k
      expect(await vault.freeAssets()).to.equal(net - 5_000_000000n);
    });

    it("share price should increase with positions profit", async () => {
      const priceBefore = await vault.sharePrice();
      await vault.connect(keeper).updatePositionsValue(2_000_000000n);
      expect(await vault.sharePrice()).to.be.gt(priceBefore);
    });
  });

  describe("Performance Fee", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
    });

    it("should collect fee on NAV increase", async () => {
      await vault.connect(keeper).updatePositionsValue(2_000_000000n);
      await time.increase(24 * 3600 + 1);

      const before = await usdc.balanceOf(treasuryWallet.address);
      await vault.connect(keeper).collectPerformanceFee();
      expect(await usdc.balanceOf(treasuryWallet.address)).to.be.gt(before);
    });

    it("should not collect when below HWM", async () => {
      await time.increase(24 * 3600 + 1);
      const before = await usdc.balanceOf(treasuryWallet.address);
      await vault.connect(keeper).collectPerformanceFee();
      expect(await usdc.balanceOf(treasuryWallet.address)).to.equal(before);
    });

    it("should revert if too early", async () => {
      await expect(vault.connect(keeper).collectPerformanceFee())
        .to.be.revertedWithCustomError(vault, "FeeTooEarly");
    });
  });

  describe("Admin", () => {
    it("should change bridge admin", async () => {
      await vault.setBridgeAdmin(bob.address);
      expect(await vault.bridgeAdmin()).to.equal(bob.address);
    });

    it("should change keeper", async () => {
      await vault.setKeeper(bob.address);
      expect(await vault.keeper()).to.equal(bob.address);
    });
  });
});
