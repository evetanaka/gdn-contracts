import { expect } from "chai";
import { ethers } from "hardhat";
import { MockUSDC } from "../typechain-types";

describe("MockUSDC", () => {
  let usdc: MockUSDC;

  beforeEach(async () => {
    const Factory = await ethers.getContractFactory("MockUSDC");
    usdc = await Factory.deploy();
  });

  it("should have 6 decimals", async () => {
    expect(await usdc.decimals()).to.equal(6);
  });

  it("should have correct name and symbol", async () => {
    expect(await usdc.name()).to.equal("USD Coin (Mock)");
    expect(await usdc.symbol()).to.equal("USDC");
  });

  it("should allow anyone to mint", async () => {
    const [, alice] = await ethers.getSigners();
    await usdc.mint(alice.address, 1000_000000n); // 1000 USDC
    expect(await usdc.balanceOf(alice.address)).to.equal(1000_000000n);
  });

  it("should mint 10k USDC via faucet", async () => {
    const [alice] = await ethers.getSigners();
    await usdc.connect(alice).faucet();
    expect(await usdc.balanceOf(alice.address)).to.equal(10000_000000n);
  });
});
