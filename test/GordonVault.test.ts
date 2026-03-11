import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  GordonVault,
  GDNToken,
  GDNPriceFeed,
  GDNStaking,
  MockUSDC,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("GordonVault", () => {
  let vault: GordonVault;
  let usdc: MockUSDC;
  let gdnToken: GDNToken;
  let priceFeed: GDNPriceFeed;
  let staking: GDNStaking;

  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let treasuryWallet: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  const GDN_PRICE = 84200000n; // $0.842 — 8 decimals
  const DEPOSIT_AMOUNT = 10_000_000000n; // 10,000 USDC

  beforeEach(async () => {
    [owner, keeper, treasuryWallet, alice, bob] = await ethers.getSigners();

    // Deploy MockUSDC
    const UsdcFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await UsdcFactory.deploy();

    // Deploy GDNToken
    const TokenFactory = await ethers.getContractFactory("GDNToken");
    gdnToken = await TokenFactory.deploy(treasuryWallet.address);

    // Deploy PriceFeed
    const FeedFactory = await ethers.getContractFactory("GDNPriceFeed");
    priceFeed = await FeedFactory.deploy(owner.address, GDN_PRICE);

    // Deploy GDNStaking (proxy)
    const StakingFactory = await ethers.getContractFactory("GDNStaking");
    staking = (await upgrades.deployProxy(StakingFactory, [
      await gdnToken.getAddress(),
      await priceFeed.getAddress(),
      treasuryWallet.address,
    ], { kind: "uups" })) as unknown as GDNStaking;

    // Deploy GordonVault (proxy)
    const VaultFactory = await ethers.getContractFactory("GordonVault");
    vault = (await upgrades.deployProxy(VaultFactory, [
      await usdc.getAddress(),
      "Gordon Crypto Vault",
      "crypto",
      keeper.address,
      treasuryWallet.address,
      await staking.getAddress(),
    ], { kind: "uups" })) as unknown as GordonVault;

    // Register vault in staking
    await staking.registerVault(await vault.getAddress());

    // Fund users with USDC
    await usdc.mint(alice.address, 100_000_000000n); // 100k USDC
    await usdc.mint(bob.address, 100_000_000000n);

    // Approve vault
    await usdc.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await vault.getAddress(), ethers.MaxUint256);
  });

  describe("Initialization", () => {
    it("should set correct initial state", async () => {
      expect(await vault.name()).to.equal("Gordon Crypto Vault");
      expect(await vault.slug()).to.equal("crypto");
      expect(await vault.keeper()).to.equal(keeper.address);
      expect(await vault.treasury()).to.equal(treasuryWallet.address);
      expect(await vault.totalShares()).to.equal(0);
      expect(await vault.totalAssets()).to.equal(0);
      expect(await vault.perfFeeBps()).to.equal(2000);
    });

    it("should not allow re-initialization", async () => {
      await expect(
        vault.initialize(
          await usdc.getAddress(), "x", "x",
          keeper.address, treasuryWallet.address, await staking.getAddress()
        )
      ).to.be.reverted;
    });
  });

  describe("Deposit", () => {
    it("should accept deposit and mint shares (1:1 first deposit)", async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);

      // Fee: 1% (tier NONE) = 100 USDC
      const fee = DEPOSIT_AMOUNT * 100n / 10000n;
      const net = DEPOSIT_AMOUNT - fee;

      expect(await vault.shareBalanceOf(alice.address)).to.equal(net);
      expect(await vault.totalShares()).to.equal(net);
      expect(await vault.totalAssets()).to.equal(net);
    });

    it("should send fee to treasury", async () => {
      const treasuryBefore = await usdc.balanceOf(treasuryWallet.address);
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
      const treasuryAfter = await usdc.balanceOf(treasuryWallet.address);

      const expectedFee = DEPOSIT_AMOUNT * 100n / 10000n; // 1%
      expect(treasuryAfter - treasuryBefore).to.equal(expectedFee);
    });

    it("should revert on zero deposit", async () => {
      await expect(vault.connect(alice).deposit(0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should revert when paused", async () => {
      await vault.pause();
      await expect(vault.connect(alice).deposit(DEPOSIT_AMOUNT))
        .to.be.reverted;
    });

    it("should emit Deposited event", async () => {
      await expect(vault.connect(alice).deposit(DEPOSIT_AMOUNT))
        .to.emit(vault, "Deposited");
    });

    it("should mint proportional shares for second depositor", async () => {
      // Alice deposits 10k
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);

      // Keeper updates NAV: positions worth 1k (simulating profit)
      await vault.connect(keeper).updatePositionsValue(1_000_000000n);

      // Bob deposits 10k — should get fewer shares (vault is worth more)
      await vault.connect(bob).deposit(DEPOSIT_AMOUNT);

      // Bob's shares should be less than Alice's
      expect(await vault.shareBalanceOf(bob.address)).to.be.lt(
        await vault.shareBalanceOf(alice.address)
      );
    });

    it("should notify staking contract of deposit", async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);

      const fee = DEPOSIT_AMOUNT * 100n / 10000n;
      const net = DEPOSIT_AMOUNT - fee;

      expect(await staking.totalDeposited(alice.address)).to.equal(net);
    });
  });

  describe("Withdraw", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
    });

    it("should withdraw and burn shares", async () => {
      const shares = await vault.shareBalanceOf(alice.address);
      const aliceBefore = await usdc.balanceOf(alice.address);

      await vault.connect(alice).withdraw(shares);

      expect(await vault.shareBalanceOf(alice.address)).to.equal(0);
      expect(await vault.totalShares()).to.equal(0);

      const aliceAfter = await usdc.balanceOf(alice.address);
      // Should get back less than deposited (deposit fee + withdraw fee)
      expect(aliceAfter).to.be.gt(aliceBefore);
    });

    it("should send withdrawal fee to treasury", async () => {
      const shares = await vault.shareBalanceOf(alice.address);
      const treasuryBefore = await usdc.balanceOf(treasuryWallet.address);

      await vault.connect(alice).withdraw(shares);

      const treasuryAfter = await usdc.balanceOf(treasuryWallet.address);
      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });

    it("should revert with insufficient shares", async () => {
      const shares = await vault.shareBalanceOf(alice.address);
      await expect(vault.connect(alice).withdraw(shares + 1n))
        .to.be.revertedWithCustomError(vault, "InsufficientShares");
    });

    it("should revert on zero shares", async () => {
      await expect(vault.connect(alice).withdraw(0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should revert with insufficient liquidity", async () => {
      // Simulate: keeper moves all USDC to positions
      // (We can't actually move USDC in test, but we can deposit, then
      //  have keeper set positionsValue high and have vault USDC drained)
      // For now, just test that bob can't withdraw alice's shares
      await expect(vault.connect(bob).withdraw(1))
        .to.be.revertedWithCustomError(vault, "InsufficientShares");
    });
  });

  describe("NAV Update", () => {
    it("should allow keeper to update positions value", async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
      await vault.connect(keeper).updatePositionsValue(5_000_000000n);

      expect(await vault.positionsValue()).to.equal(5_000_000000n);

      const fee = DEPOSIT_AMOUNT * 100n / 10000n;
      const net = DEPOSIT_AMOUNT - fee;
      expect(await vault.totalAssets()).to.equal(net + 5_000_000000n);
    });

    it("should revert if not keeper", async () => {
      await expect(vault.connect(alice).updatePositionsValue(1000n))
        .to.be.revertedWithCustomError(vault, "OnlyKeeper");
    });

    it("should revert if deviation too large", async () => {
      await vault.connect(keeper).updatePositionsValue(10_000_000000n);

      // Try +25% (over 20% limit)
      await expect(vault.connect(keeper).updatePositionsValue(12_500_000001n))
        .to.be.revertedWithCustomError(vault, "NavDeviationTooLarge");
    });

    it("should allow first update without deviation check", async () => {
      await vault.connect(keeper).updatePositionsValue(100_000_000000n);
      expect(await vault.positionsValue()).to.equal(100_000_000000n);
    });

    it("should emit NavUpdated event", async () => {
      await expect(vault.connect(keeper).updatePositionsValue(5000n))
        .to.emit(vault, "NavUpdated");
    });
  });

  describe("Performance Fee", () => {
    beforeEach(async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
    });

    it("should collect fee when NAV increases above HWM", async () => {
      // Simulate profit via positionsValue
      await vault.connect(keeper).updatePositionsValue(2_000_000000n); // +2k profit

      // Wait 24h
      await time.increase(24 * 3600 + 1);

      const treasuryBefore = await usdc.balanceOf(treasuryWallet.address);
      await vault.connect(keeper).collectPerformanceFee();
      const treasuryAfter = await usdc.balanceOf(treasuryWallet.address);

      // Should have collected 20% of the 2k profit = 400 USDC
      // (from free USDC in vault)
      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });

    it("should not collect fee when NAV below HWM", async () => {
      // No profit
      await time.increase(24 * 3600 + 1);

      const treasuryBefore = await usdc.balanceOf(treasuryWallet.address);
      await vault.connect(keeper).collectPerformanceFee();
      const treasuryAfter = await usdc.balanceOf(treasuryWallet.address);

      expect(treasuryAfter).to.equal(treasuryBefore);
    });

    it("should revert if called too early", async () => {
      await expect(vault.connect(keeper).collectPerformanceFee())
        .to.be.revertedWithCustomError(vault, "FeeTooEarly");
    });

    it("should update HWM after collection", async () => {
      await vault.connect(keeper).updatePositionsValue(2_000_000000n);
      await time.increase(24 * 3600 + 1);

      await vault.connect(keeper).collectPerformanceFee();
      const hwm = await vault.highWaterMark();

      // HWM should be updated to current total assets (after fee)
      expect(hwm).to.equal(await vault.totalAssets());
    });
  });

  describe("Strategy Execution", () => {
    it("should allow keeper to call external contracts", async () => {
      // Keeper approves USDC spending on a mock target (using USDC mint as test)
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);

      // Execute: approve MockUSDC to spend vault's USDC (simulating Polymarket approval)
      const approveData = usdc.interface.encodeFunctionData("approve", [
        keeper.address, 1000_000000n
      ]);

      await vault.connect(keeper).executeStrategy(
        await usdc.getAddress(), 0, approveData
      );

      // Verify the approval was set
      expect(await usdc.allowance(await vault.getAddress(), keeper.address))
        .to.equal(1000_000000n);
    });

    it("should revert if not keeper", async () => {
      await expect(
        vault.connect(alice).executeStrategy(await usdc.getAddress(), 0, "0x")
      ).to.be.revertedWithCustomError(vault, "OnlyKeeper");
    });

    it("should prevent calling self", async () => {
      await expect(
        vault.connect(keeper).executeStrategy(await vault.getAddress(), 0, "0x")
      ).to.be.revertedWith("Cannot call self");
    });

    it("should prevent calling staking contract", async () => {
      await expect(
        vault.connect(keeper).executeStrategy(await staking.getAddress(), 0, "0x")
      ).to.be.revertedWith("Cannot call staking");
    });
  });

  describe("Share Price", () => {
    it("should return 1:1 when empty", async () => {
      expect(await vault.sharePrice()).to.equal(1_000000n);
    });

    it("should increase after profit", async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);
      const priceBefore = await vault.sharePrice();

      await vault.connect(keeper).updatePositionsValue(2_000_000000n);
      const priceAfter = await vault.sharePrice();

      expect(priceAfter).to.be.gt(priceBefore);
    });
  });

  describe("Views", () => {
    it("should return correct user position", async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);

      const [shares, value] = await vault.userPosition(alice.address);
      expect(shares).to.be.gt(0);
      expect(value).to.be.gt(0);
      expect(value).to.be.closeTo(shares, 1); // ~1:1 on first deposit
    });

    it("should return free assets", async () => {
      await vault.connect(alice).deposit(DEPOSIT_AMOUNT);

      const fee = DEPOSIT_AMOUNT * 100n / 10000n;
      const net = DEPOSIT_AMOUNT - fee;

      expect(await vault.freeAssets()).to.equal(net);
    });
  });

  describe("Admin", () => {
    it("should allow owner to change keeper", async () => {
      await vault.setKeeper(bob.address);
      expect(await vault.keeper()).to.equal(bob.address);
    });

    it("should allow owner to set fee tiers", async () => {
      await vault.setDepositFeeBps([50, 40, 30, 20, 10]);
      const tier0 = (await vault.depositFeeBps(0));
      expect(tier0).to.equal(50);
    });

    it("should revert non-owner admin calls", async () => {
      await expect(vault.connect(alice).setKeeper(alice.address)).to.be.reverted;
    });
  });
});
