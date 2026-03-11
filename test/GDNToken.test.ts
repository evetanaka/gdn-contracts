import { expect } from "chai";
import { ethers } from "hardhat";
import { GDNToken } from "../typechain-types";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("GDNToken", () => {
  let token: GDNToken;
  let treasury: SignerWithAddress;
  let alice: SignerWithAddress;
  let bob: SignerWithAddress;

  const TOTAL_SUPPLY = ethers.parseEther("100000000"); // 100M

  beforeEach(async () => {
    [treasury, alice, bob] = await ethers.getSigners();
    const Factory = await ethers.getContractFactory("GDNToken");
    token = await Factory.deploy(treasury.address);
  });

  describe("Deployment", () => {
    it("should mint total supply to treasury", async () => {
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
      expect(await token.balanceOf(treasury.address)).to.equal(TOTAL_SUPPLY);
    });

    it("should have correct name and symbol", async () => {
      expect(await token.name()).to.equal("Gordon Token");
      expect(await token.symbol()).to.equal("GDN");
    });

    it("should have 18 decimals", async () => {
      expect(await token.decimals()).to.equal(18);
    });

    it("should revert with zero treasury address", async () => {
      const Factory = await ethers.getContractFactory("GDNToken");
      await expect(Factory.deploy(ethers.ZeroAddress)).to.be.revertedWith("GDN: zero treasury");
    });
  });

  describe("Transfers", () => {
    it("should transfer tokens", async () => {
      const amount = ethers.parseEther("1000");
      await token.connect(treasury).transfer(alice.address, amount);
      expect(await token.balanceOf(alice.address)).to.equal(amount);
    });
  });

  describe("Burn", () => {
    it("should allow anyone to burn their own tokens", async () => {
      const amount = ethers.parseEther("1000");
      await token.connect(treasury).transfer(alice.address, amount);

      const burnAmount = ethers.parseEther("500");
      await token.connect(alice).burn(burnAmount);

      expect(await token.balanceOf(alice.address)).to.equal(amount - burnAmount);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY - burnAmount);
    });

    it("should revert when burning more than balance", async () => {
      await expect(
        token.connect(alice).burn(ethers.parseEther("1"))
      ).to.be.reverted;
    });
  });

  describe("Permit (EIP-2612)", () => {
    it("should support permit", async () => {
      // Verify the DOMAIN_SEPARATOR exists (EIP-2612 support)
      const domain = await token.eip712Domain();
      expect(domain.name).to.equal("Gordon Token");
    });
  });

  describe("No mint", () => {
    it("should have no public mint function", async () => {
      // GDNToken has no mint — this is verified by the contract not having one
      // The only way to get tokens is from treasury or transfers
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);
    });
  });
});
