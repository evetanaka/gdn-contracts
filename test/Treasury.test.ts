import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import {
  Treasury,
  GDNToken,
  GDNStaking,
  GDNPriceFeed,
  MockUSDC,
} from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("Treasury", () => {
  let treasury: Treasury;
  let usdc: MockUSDC;
  let gdnToken: GDNToken;
  let staking: GDNStaking;
  let priceFeed: GDNPriceFeed;

  let owner: SignerWithAddress;
  let keeper: SignerWithAddress;
  let vaultMock: SignerWithAddress;
  let alice: SignerWithAddress;
  let dexRouterMock: SignerWithAddress;

  const GDN_PRICE = 84200000n;

  beforeEach(async () => {
    [owner, keeper, vaultMock, alice, dexRouterMock] = await ethers.getSigners();

    // Deploy tokens
    const UsdcFactory = await ethers.getContractFactory("MockUSDC");
    usdc = await UsdcFactory.deploy();

    const TokenFactory = await ethers.getContractFactory("GDNToken");
    gdnToken = await TokenFactory.deploy(owner.address);

    // Deploy PriceFeed
    const FeedFactory = await ethers.getContractFactory("GDNPriceFeed");
    priceFeed = await FeedFactory.deploy(owner.address, GDN_PRICE);

    // Deploy Staking
    const StakingFactory = await ethers.getContractFactory("GDNStaking");
    staking = (await upgrades.deployProxy(StakingFactory, [
      await gdnToken.getAddress(),
      await priceFeed.getAddress(),
      owner.address, // temporary treasury
    ], { kind: "uups" })) as unknown as GDNStaking;

    // Deploy Treasury
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    treasury = (await upgrades.deployProxy(TreasuryFactory, [
      await usdc.getAddress(),
      await gdnToken.getAddress(),
      await staking.getAddress(),
      dexRouterMock.address,
      keeper.address,
    ], { kind: "uups" })) as unknown as Treasury;

    // Update staking treasury to the real treasury
    await staking.setTreasury(await treasury.getAddress());

    // Authorize vault mock as fee source
    await treasury.authorizeSource(vaultMock.address);
  });

  describe("Initialization", () => {
    it("should set correct initial state", async () => {
      expect(await treasury.keeper()).to.equal(keeper.address);
      expect(await treasury.buybackRatioBps()).to.equal(5000);
      expect(await treasury.rewardRatioBps()).to.equal(5000);
      expect(await treasury.totalBuybacks()).to.equal(0);
    });

    it("should not allow re-initialization", async () => {
      await expect(
        treasury.initialize(
          await usdc.getAddress(),
          await gdnToken.getAddress(),
          await staking.getAddress(),
          dexRouterMock.address,
          keeper.address
        )
      ).to.be.reverted;
    });
  });

  describe("Fee Collection", () => {
    it("should track fees from authorized sources", async () => {
      // Simulate vault sending USDC fees to treasury
      await usdc.mint(await treasury.getAddress(), 1000_000000n);
      await treasury.connect(vaultMock).notifyFees(1000_000000n);

      expect(await treasury.totalUsdcCollected()).to.equal(1000_000000n);
    });

    it("should revert from unauthorized source", async () => {
      await expect(treasury.connect(alice).notifyFees(100n))
        .to.be.revertedWith("Not authorized source");
    });

    it("should report pending fees", async () => {
      await usdc.mint(await treasury.getAddress(), 5000_000000n);
      expect(await treasury.pendingFees()).to.equal(5000_000000n);
    });
  });

  describe("Ratios", () => {
    it("should allow owner to set ratios", async () => {
      await treasury.setRatios(7000, 3000);
      expect(await treasury.buybackRatioBps()).to.equal(7000);
      expect(await treasury.rewardRatioBps()).to.equal(3000);
    });

    it("should revert if ratios don't sum to 10000", async () => {
      await expect(treasury.setRatios(5000, 4000))
        .to.be.revertedWithCustomError(treasury, "InvalidRatios");
    });

    it("should revert for non-owner", async () => {
      await expect(treasury.connect(alice).setRatios(5000, 5000))
        .to.be.reverted;
    });
  });

  describe("Admin", () => {
    it("should authorize and revoke sources", async () => {
      await treasury.authorizeSource(alice.address);
      expect(await treasury.authorizedSources(alice.address)).to.be.true;

      await treasury.revokeSource(alice.address);
      expect(await treasury.authorizedSources(alice.address)).to.be.false;
    });

    it("should allow owner to change keeper", async () => {
      await treasury.setKeeper(alice.address);
      expect(await treasury.keeper()).to.equal(alice.address);
    });

    it("should allow owner to change DEX router", async () => {
      await treasury.setDexRouter(alice.address);
      expect(await treasury.dexRouter()).to.equal(alice.address);
    });

    it("should return stats", async () => {
      const [collected, burned, distributed, buybacks, pending] = await treasury.stats();
      expect(collected).to.equal(0);
      expect(burned).to.equal(0);
      expect(distributed).to.equal(0);
      expect(buybacks).to.equal(0);
      expect(pending).to.equal(0);
    });
  });

  describe("Recovery", () => {
    it("should allow recovering non-USDC tokens", async () => {
      // Send some GDN to treasury by accident
      await gdnToken.transfer(await treasury.getAddress(), ethers.parseEther("100"));

      await treasury.recoverToken(
        await gdnToken.getAddress(),
        ethers.parseEther("100"),
        owner.address
      );
    });

    it("should not allow recovering USDC when not paused", async () => {
      await usdc.mint(await treasury.getAddress(), 1000_000000n);
      await expect(
        treasury.recoverToken(await usdc.getAddress(), 1000_000000n, owner.address)
      ).to.be.revertedWith("Pause first to recover USDC");
    });

    it("should allow recovering USDC when paused", async () => {
      await usdc.mint(await treasury.getAddress(), 1000_000000n);
      await treasury.pause();
      await treasury.recoverToken(await usdc.getAddress(), 1000_000000n, owner.address);
      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(0);
    });
  });
});
