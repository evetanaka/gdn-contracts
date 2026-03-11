import { expect } from "chai";
import { ethers } from "hardhat";
import { GDNPriceFeed } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("GDNPriceFeed", () => {
  let feed: GDNPriceFeed;
  let owner: SignerWithAddress;
  let oracle: SignerWithAddress;
  let attacker: SignerWithAddress;

  const INITIAL_PRICE = 84200000n; // $0.842 with 8 decimals

  beforeEach(async () => {
    [owner, oracle, attacker] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("GDNPriceFeed");
    feed = await Factory.deploy(oracle.address, INITIAL_PRICE);
  });

  describe("Deployment", () => {
    it("should set initial price and oracle", async () => {
      expect(await feed.price()).to.equal(INITIAL_PRICE);
      expect(await feed.oracle()).to.equal(oracle.address);
      expect(await feed.updatedAt()).to.be.gt(0);
    });

    it("should revert with zero oracle", async () => {
      const Factory = await ethers.getContractFactory("GDNPriceFeed");
      await expect(Factory.deploy(ethers.ZeroAddress, INITIAL_PRICE))
        .to.be.revertedWith("PriceFeed: zero oracle");
    });

    it("should revert with zero price", async () => {
      const Factory = await ethers.getContractFactory("GDNPriceFeed");
      await expect(Factory.deploy(oracle.address, 0))
        .to.be.revertedWith("PriceFeed: zero price");
    });
  });

  describe("updatePrice", () => {
    it("should allow oracle to update price", async () => {
      const newPrice = 90000000n; // $0.90
      await expect(feed.connect(oracle).updatePrice(newPrice))
        .to.emit(feed, "PriceUpdated")
        .withArgs(newPrice, await time.latest().then(t => t + 1));

      expect(await feed.price()).to.equal(newPrice);
    });

    it("should revert if not oracle", async () => {
      await expect(feed.connect(attacker).updatePrice(90000000n))
        .to.be.revertedWith("PriceFeed: only oracle");
    });

    it("should revert with zero price", async () => {
      await expect(feed.connect(oracle).updatePrice(0))
        .to.be.revertedWith("PriceFeed: zero price");
    });

    it("should revert if deviation too large", async () => {
      // 50% deviation = max allowed by default
      const tooHigh = INITIAL_PRICE * 2n; // +100%
      await expect(feed.connect(oracle).updatePrice(tooHigh))
        .to.be.revertedWith("PriceFeed: deviation too large");
    });

    it("should allow price within deviation", async () => {
      // +40% (under 50% limit)
      const acceptable = INITIAL_PRICE * 140n / 100n;
      await feed.connect(oracle).updatePrice(acceptable);
      expect(await feed.price()).to.equal(acceptable);
    });
  });

  describe("latestPrice", () => {
    it("should return price when fresh", async () => {
      expect(await feed.latestPrice()).to.equal(INITIAL_PRICE);
    });

    it("should revert when stale (>1h)", async () => {
      await time.increase(3601); // 1h + 1s
      await expect(feed.latestPrice())
        .to.be.revertedWith("PriceFeed: stale");
    });

    it("should not revert at exactly 1h", async () => {
      await time.increase(3599);
      expect(await feed.latestPrice()).to.equal(INITIAL_PRICE);
    });
  });

  describe("Admin functions", () => {
    it("should allow owner to change oracle", async () => {
      await feed.connect(owner).setOracle(attacker.address);
      expect(await feed.oracle()).to.equal(attacker.address);
    });

    it("should revert if non-owner changes oracle", async () => {
      await expect(feed.connect(attacker).setOracle(attacker.address))
        .to.be.reverted;
    });

    it("should allow owner to change staleness", async () => {
      await feed.connect(owner).setMaxStaleness(7200); // 2h
      expect(await feed.maxStaleness()).to.equal(7200);
    });

    it("should revert if staleness too short", async () => {
      await expect(feed.connect(owner).setMaxStaleness(60)) // 1 min
        .to.be.revertedWith("PriceFeed: too short");
    });

    it("should allow owner to change max deviation", async () => {
      await feed.connect(owner).setMaxDeviationBps(2000); // 20%
      // Now a 40% change should revert
      const tooHigh = INITIAL_PRICE * 141n / 100n;
      await expect(feed.connect(oracle).updatePrice(tooHigh))
        .to.be.revertedWith("PriceFeed: deviation too large");
    });
  });
});
