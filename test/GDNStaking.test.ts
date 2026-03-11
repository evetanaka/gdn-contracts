import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { GDNStaking, GDNToken, GDNPriceFeed, MockUSDC } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("GDNStaking", () => {
  let staking: GDNStaking;
  let gdnToken: GDNToken;
  let priceFeed: GDNPriceFeed;
  let mockUsdc: MockUSDC;

  let owner: SignerWithAddress;
  let treasuryWallet: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;
  let vaultMock: SignerWithAddress;

  const GDN_PRICE = 84200000n; // $0.842 — 8 decimals
  const STAKE_AMOUNT = ethers.parseEther("10000"); // 10,000 $GDN
  const THIRTY_DAYS = 30 * 24 * 3600;

  beforeEach(async () => {
    [owner, treasuryWallet, alice, bob, vaultMock] = await ethers.getSigners();

    // Deploy GDNToken → all tokens to treasuryWallet
    const TokenFactory = await ethers.getContractFactory("GDNToken");
    gdnToken = await TokenFactory.deploy(treasuryWallet.address);

    // Deploy PriceFeed
    const FeedFactory = await ethers.getContractFactory("GDNPriceFeed");
    priceFeed = await FeedFactory.deploy(owner.address, GDN_PRICE);

    // Deploy GDNStaking (UUPS proxy)
    const StakingFactory = await ethers.getContractFactory("GDNStaking");
    staking = (await upgrades.deployProxy(StakingFactory, [
      await gdnToken.getAddress(),
      await priceFeed.getAddress(),
      treasuryWallet.address,
    ], { kind: "uups" })) as unknown as GDNStaking;

    // Give alice some GDN for staking
    await gdnToken.connect(treasuryWallet).transfer(alice.address, ethers.parseEther("100000"));
    await gdnToken.connect(alice).approve(await staking.getAddress(), ethers.MaxUint256);

    // Give bob some GDN
    await gdnToken.connect(treasuryWallet).transfer(bob.address, ethers.parseEther("100000"));
    await gdnToken.connect(bob).approve(await staking.getAddress(), ethers.MaxUint256);

    // Register vault mock
    await staking.registerVault(vaultMock.address);
  });

  describe("Initialization", () => {
    it("should set correct initial state", async () => {
      expect(await staking.gdnToken()).to.equal(await gdnToken.getAddress());
      expect(await staking.treasury()).to.equal(treasuryWallet.address);
      expect(await staking.totalEffectiveStaked()).to.equal(0);
      expect(await staking.slashBaseBps()).to.equal(500);
      expect(await staking.slashCapBps()).to.equal(1000);
    });

    it("should not allow re-initialization", async () => {
      await expect(
        staking.initialize(
          await gdnToken.getAddress(),
          await priceFeed.getAddress(),
          treasuryWallet.address
        )
      ).to.be.reverted;
    });
  });

  describe("Staking", () => {
    it("should stake with 3-month lock (1x boost)", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);

      const info = await staking.getStake(alice.address);
      expect(info.amount).to.equal(STAKE_AMOUNT);
      expect(info.effectiveAmount).to.equal(STAKE_AMOUNT); // 1x
      expect(info.boostBps).to.equal(10000);
      expect(await staking.totalEffectiveStaked()).to.equal(STAKE_AMOUNT);
    });

    it("should stake with 6-month lock (1.5x boost)", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 6);

      const info = await staking.getStake(alice.address);
      const expectedEffective = (STAKE_AMOUNT * 15000n) / 10000n;
      expect(info.effectiveAmount).to.equal(expectedEffective);
      expect(info.boostBps).to.equal(15000);
    });

    it("should stake with 12-month lock (3x boost)", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 12);

      const info = await staking.getStake(alice.address);
      const expectedEffective = (STAKE_AMOUNT * 30000n) / 10000n;
      expect(info.effectiveAmount).to.equal(expectedEffective);
      expect(info.boostBps).to.equal(30000);
    });

    it("should revert with invalid lock duration", async () => {
      await expect(staking.connect(alice).stake(STAKE_AMOUNT, 5))
        .to.be.revertedWithCustomError(staking, "InvalidLockDuration");
    });

    it("should revert if already staking", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      await expect(staking.connect(alice).stake(STAKE_AMOUNT, 3))
        .to.be.revertedWithCustomError(staking, "AlreadyStaking");
    });

    it("should revert with zero amount", async () => {
      await expect(staking.connect(alice).stake(0, 3))
        .to.be.revertedWithCustomError(staking, "ZeroAmount");
    });

    it("should transfer GDN from user to contract", async () => {
      const balBefore = await gdnToken.balanceOf(alice.address);
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      const balAfter = await gdnToken.balanceOf(alice.address);
      expect(balBefore - balAfter).to.equal(STAKE_AMOUNT);
    });
  });

  describe("Unstake — after lock", () => {
    it("should return full amount after lock expires", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      await time.increase(THIRTY_DAYS * 3 + 1);

      const balBefore = await gdnToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const balAfter = await gdnToken.balanceOf(alice.address);

      expect(balAfter - balBefore).to.equal(STAKE_AMOUNT);
      expect(await staking.totalEffectiveStaked()).to.equal(0);
    });

    it("should delete stake info after unstake", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      await time.increase(THIRTY_DAYS * 3 + 1);
      await staking.connect(alice).unstake();

      const info = await staking.getStake(alice.address);
      expect(info.amount).to.equal(0);
    });
  });

  describe("Unstake — early (slash)", () => {
    it("should slash on early unstake", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 12);

      // Unstake after 3 months (9 months remaining)
      await time.increase(THIRTY_DAYS * 3);

      const treasuryBal = await gdnToken.balanceOf(treasuryWallet.address);
      await staking.connect(alice).unstake();
      const treasuryAfter = await gdnToken.balanceOf(treasuryWallet.address);

      // Slash should be > 0 and sent to treasury
      expect(treasuryAfter).to.be.gt(treasuryBal);
    });

    it("should cap slash at 10%", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 12);

      // Unstake immediately (12 months remaining)
      // Slash = 500 + (12 × 50) = 1100 → capped at 1000 (10%)
      const balBefore = await gdnToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const balAfter = await gdnToken.balanceOf(alice.address);

      const returned = balAfter - balBefore;
      const slashed = STAKE_AMOUNT - returned;

      // Should be exactly 10% (capped)
      expect(slashed).to.equal((STAKE_AMOUNT * 1000n) / 10000n);
    });

    it("should apply minimum 5.5% slash with 1 month remaining", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);

      // Unstake with ~1 month remaining
      await time.increase(THIRTY_DAYS * 2);

      const balBefore = await gdnToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const balAfter = await gdnToken.balanceOf(alice.address);

      const returned = balAfter - balBefore;
      const slashed = STAKE_AMOUNT - returned;

      // Slash should be 500 + (1 × 50) = 550 bps = 5.5%
      // (with rounding due to block timestamps)
      expect(slashed).to.be.gte((STAKE_AMOUNT * 550n) / 10000n);
      expect(slashed).to.be.lte((STAKE_AMOUNT * 600n) / 10000n);
    });

    it("should revert if not staking", async () => {
      await expect(staking.connect(alice).unstake())
        .to.be.revertedWithCustomError(staking, "NotStaking");
    });
  });

  describe("Rewards", () => {
    it("should distribute rewards proportionally", async () => {
      // Alice stakes 10k with 3mo (1x), Bob stakes 10k with 12mo (3x)
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      await staking.connect(bob).stake(STAKE_AMOUNT, 12);

      // Total effective: 10k + 30k = 40k
      // Alice gets 1/4, Bob gets 3/4

      const rewardAmount = ethers.parseEther("4000");
      await gdnToken.connect(treasuryWallet).approve(await staking.getAddress(), rewardAmount);
      await staking.connect(treasuryWallet).distributeRewards(rewardAmount);

      // Note: treasury is the authorized caller because it's set as treasury address
      // But distributeRewards checks msg.sender == treasury, and treasuryWallet IS the treasury

      const alicePending = await staking.pendingRewards(alice.address);
      const bobPending = await staking.pendingRewards(bob.address);

      // Alice: 10k/40k × 4000 = 1000
      expect(alicePending).to.be.closeTo(ethers.parseEther("1000"), ethers.parseEther("1"));
      // Bob: 30k/40k × 4000 = 3000
      expect(bobPending).to.be.closeTo(ethers.parseEther("3000"), ethers.parseEther("1"));
    });

    it("should allow claiming rewards", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);

      const rewardAmount = ethers.parseEther("1000");
      await gdnToken.connect(treasuryWallet).approve(await staking.getAddress(), rewardAmount);
      await staking.connect(treasuryWallet).distributeRewards(rewardAmount);

      const balBefore = await gdnToken.balanceOf(alice.address);
      await staking.connect(alice).claimRewards();
      const balAfter = await gdnToken.balanceOf(alice.address);

      expect(balAfter - balBefore).to.be.closeTo(rewardAmount, ethers.parseEther("1"));
    });

    it("should claim rewards on unstake", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);

      const rewardAmount = ethers.parseEther("1000");
      await gdnToken.connect(treasuryWallet).approve(await staking.getAddress(), rewardAmount);
      await staking.connect(treasuryWallet).distributeRewards(rewardAmount);

      await time.increase(THIRTY_DAYS * 3 + 1);

      const balBefore = await gdnToken.balanceOf(alice.address);
      await staking.connect(alice).unstake();
      const balAfter = await gdnToken.balanceOf(alice.address);

      // Should get stake + rewards
      expect(balAfter - balBefore).to.be.closeTo(
        STAKE_AMOUNT + rewardAmount,
        ethers.parseEther("1")
      );
    });
  });

  describe("Loyalty Tier", () => {
    it("should return NONE if not staking", async () => {
      expect(await staking.loyaltyTier(alice.address)).to.equal(0);
    });

    it("should return NONE if no deposits", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      expect(await staking.loyaltyTier(alice.address)).to.equal(0);
    });

    it("should calculate tier based on effective stake and deposits", async () => {
      // Alice stakes 10,000 GDN at $0.842 = $8,420 effective value (1x boost)
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);

      // Simulate vault deposit of 100,000 USDC (6 decimals)
      const depositAmount = 100_000_000000n; // 100k USDC
      await staking.connect(vaultMock).updateDeposits(alice.address, int256(depositAmount));

      // Ratio = $8,420 / $100,000 = 8.42% → Gold (≥5%)
      expect(await staking.loyaltyTier(alice.address)).to.equal(3);
    });

    it("should give higher tier with 12mo boost", async () => {
      // Same amount but 12mo lock (3x boost)
      // Effective value = 10,000 × 3 × $0.842 = $25,260
      await staking.connect(alice).stake(STAKE_AMOUNT, 12);

      const depositAmount = 100_000_000000n;
      await staking.connect(vaultMock).updateDeposits(alice.address, int256(depositAmount));

      // Ratio = $25,260 / $100,000 = 25.26% → Platinum (≥10%)
      expect(await staking.loyaltyTier(alice.address)).to.equal(4);
    });

    it("should return Bronze for small staker", async () => {
      const smallStake = ethers.parseEther("200"); // 200 GDN × $0.842 = $168.4
      await staking.connect(alice).stake(smallStake, 3);

      // Deposit 10,000 USDC
      const deposit = 10_000_000000n;
      await staking.connect(vaultMock).updateDeposits(alice.address, int256(deposit));

      // Ratio = $168.4 / $10,000 = 1.68% → Bronze (≥1%)
      expect(await staking.loyaltyTier(alice.address)).to.equal(1);
    });
  });

  describe("Vault integration (updateDeposits)", () => {
    it("should allow registered vault to update deposits", async () => {
      await staking.connect(vaultMock).updateDeposits(alice.address, int256(1000_000000n));
      expect(await staking.totalDeposited(alice.address)).to.equal(1000_000000n);
    });

    it("should handle negative delta (withdrawal)", async () => {
      await staking.connect(vaultMock).updateDeposits(alice.address, int256(1000_000000n));
      await staking.connect(vaultMock).updateDeposits(alice.address, -int256(400_000000n));
      expect(await staking.totalDeposited(alice.address)).to.equal(600_000000n);
    });

    it("should not underflow on large withdrawal", async () => {
      await staking.connect(vaultMock).updateDeposits(alice.address, int256(100_000000n));
      await staking.connect(vaultMock).updateDeposits(alice.address, -int256(500_000000n));
      expect(await staking.totalDeposited(alice.address)).to.equal(0);
    });

    it("should revert for unregistered vault", async () => {
      await expect(
        staking.connect(alice).updateDeposits(alice.address, int256(1000n))
      ).to.be.revertedWithCustomError(staking, "NotRegisteredVault");
    });
  });

  describe("Admin", () => {
    it("should allow owner to register/unregister vaults", async () => {
      const newVault = bob.address;
      await staking.registerVault(newVault);
      expect(await staking.registeredVaults(newVault)).to.be.true;

      await staking.unregisterVault(newVault);
      expect(await staking.registeredVaults(newVault)).to.be.false;
    });

    it("should allow owner to change slash params", async () => {
      await staking.setSlashParams(300, 100, 1500);
      expect(await staking.slashBaseBps()).to.equal(300);
      expect(await staking.slashPerMonthBps()).to.equal(100);
      expect(await staking.slashCapBps()).to.equal(1500);
    });

    it("should allow pause/unpause", async () => {
      await staking.pause();
      await expect(staking.connect(alice).stake(STAKE_AMOUNT, 3))
        .to.be.reverted;

      await staking.unpause();
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
    });
  });

  describe("View helpers", () => {
    it("should return time until unlock", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      const remaining = await staking.timeUntilUnlock(alice.address);
      expect(remaining).to.be.closeTo(THIRTY_DAYS * 3, 10);
    });

    it("should return 0 after lock expires", async () => {
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      await time.increase(THIRTY_DAYS * 3 + 1);
      expect(await staking.timeUntilUnlock(alice.address)).to.equal(0);
    });

    it("should return isStaking correctly", async () => {
      expect(await staking.isStaking(alice.address)).to.be.false;
      await staking.connect(alice).stake(STAKE_AMOUNT, 3);
      expect(await staking.isStaking(alice.address)).to.be.true;
    });
  });
});

// Helper to create int256 from BigInt for the test
function int256(value: bigint): bigint {
  return value;
}
