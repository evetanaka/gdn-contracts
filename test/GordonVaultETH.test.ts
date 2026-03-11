import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("GordonVaultETH", function () {
  async function deployFixture() {
    const [owner, keeper, bridgeAdmin, user1, user2, treasuryAddr] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    // Deploy GDNToken (for staking)
    const GDNToken = await ethers.getContractFactory("GDNToken");
    const gdn = await GDNToken.deploy(owner.address);

    // Deploy GDNPriceFeed
    const PriceFeed = await ethers.getContractFactory("GDNPriceFeed");
    const priceFeed = await PriceFeed.deploy(owner.address, ethers.parseUnits("1", 8));

    // Deploy GDNStaking
    const Staking = await ethers.getContractFactory("GDNStaking");
    const staking = await upgrades.deployProxy(Staking, [
      await gdn.getAddress(),
      await priceFeed.getAddress(),
      treasuryAddr.address,
    ], { kind: "uups" });

    // Deploy GordonVaultETH
    const Vault = await ethers.getContractFactory("GordonVaultETH");
    const vault = await upgrades.deployProxy(Vault, [
      await usdc.getAddress(),
      "Crypto Vault",
      "crypto",
      keeper.address,
      bridgeAdmin.address,
      treasuryAddr.address,
      await staking.getAddress(),
    ], { kind: "uups" });

    // Register vault in staking contract
    await staking.registerVault(await vault.getAddress());

    // Mint USDC to users
    const MINT_AMOUNT = ethers.parseUnits("100000", 6);
    await usdc.mint(user1.address, MINT_AMOUNT);
    await usdc.mint(user2.address, MINT_AMOUNT);

    // Approve vault
    await usdc.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(user2).approve(await vault.getAddress(), ethers.MaxUint256);

    return { vault, usdc, gdn, staking, priceFeed, owner, keeper, bridgeAdmin, user1, user2, treasuryAddr };
  }

  describe("Initialization", function () {
    it("should initialize correctly", async function () {
      const { vault, usdc, keeper, bridgeAdmin, treasuryAddr } = await loadFixture(deployFixture);
      expect(await vault.name()).to.equal("Crypto Vault");
      expect(await vault.slug()).to.equal("crypto");
      expect(await vault.asset()).to.equal(await usdc.getAddress());
      expect(await vault.keeper()).to.equal(keeper.address);
      expect(await vault.bridgeAdmin()).to.equal(bridgeAdmin.address);
      expect(await vault.treasury()).to.equal(treasuryAddr.address);
      expect(await vault.maxNavDeviationBps()).to.equal(2000);
      expect(await vault.perfFeeBps()).to.equal(2000);
      expect(await vault.feePeriod()).to.equal(24 * 3600);
    });

    it("should reject zero addresses", async function () {
      const Vault = await ethers.getContractFactory("GordonVaultETH");
      await expect(
        upgrades.deployProxy(Vault, [
          ethers.ZeroAddress, "Test", "test",
          ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress,
        ], { kind: "uups" })
      ).to.be.revertedWithCustomError(Vault, "ZeroAddress");
    });

    it("should not be re-initializable", async function () {
      const { vault, keeper, bridgeAdmin, treasuryAddr, usdc, staking } = await loadFixture(deployFixture);
      await expect(
        vault.initialize(
          await usdc.getAddress(), "x", "x",
          keeper.address, bridgeAdmin.address, treasuryAddr.address, await staking.getAddress()
        )
      ).to.be.revertedWithCustomError(vault, "InvalidInitialization");
    });
  });

  describe("Deposit", function () {
    it("should deposit and mint shares (first deposit 1:1)", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 6);

      // Tier 0 = 100bps = 1% fee
      const fee = amount * 100n / 10000n; // 10 USDC
      const net = amount - fee; // 990 USDC

      await expect(vault.connect(user1).deposit(amount))
        .to.emit(vault, "Deposited");

      // First deposit: shares = net assets (1:1)
      expect(await vault.shareBalanceOf(user1.address)).to.equal(net);
      expect(await vault.totalShares()).to.equal(net);
    });

    it("should charge correct fee per tier", async function () {
      const { vault, usdc, user1, treasuryAddr } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 6);
      const treasuryBefore = await usdc.balanceOf(treasuryAddr.address);

      await vault.connect(user1).deposit(amount);

      const fee = amount * 100n / 10000n; // 1% for tier 0
      expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(treasuryBefore + fee);
    });

    it("should revert on zero deposit", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await expect(vault.connect(user1).deposit(0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should revert when paused", async function () {
      const { vault, user1, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).pause();
      await expect(vault.connect(user1).deposit(ethers.parseUnits("100", 6)))
        .to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("should set highWaterMark on first deposit", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      expect(await vault.highWaterMark()).to.equal(0);
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6));
      expect(await vault.highWaterMark()).to.be.gt(0);
    });

    it("should update staking deposits", async function () {
      const { vault, staking, user1 } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 6);
      await vault.connect(user1).deposit(amount);

      const net = amount - (amount * 100n / 10000n);
      expect(await staking.totalDeposited(user1.address)).to.equal(net);
    });

    it("should mint proportional shares on second deposit", async function () {
      const { vault, user1, user2 } = await loadFixture(deployFixture);
      const amount = ethers.parseUnits("1000", 6);

      await vault.connect(user1).deposit(amount);
      const shares1 = await vault.shareBalanceOf(user1.address);

      await vault.connect(user2).deposit(amount);
      const shares2 = await vault.shareBalanceOf(user2.address);

      // Same amount → same shares (both tier 0)
      expect(shares1).to.equal(shares2);
    });
  });

  describe("Withdraw", function () {
    it("should withdraw and burn shares", async function () {
      const { vault, usdc, user1 } = await loadFixture(deployFixture);
      const depositAmount = ethers.parseUnits("1000", 6);
      await vault.connect(user1).deposit(depositAmount);

      const shares = await vault.shareBalanceOf(user1.address);
      const balBefore = await usdc.balanceOf(user1.address);

      await expect(vault.connect(user1).withdraw(shares))
        .to.emit(vault, "Withdrawn");

      expect(await vault.shareBalanceOf(user1.address)).to.equal(0);
      expect(await vault.totalShares()).to.equal(0);

      // User gets back assets minus withdraw fee
      const balAfter = await usdc.balanceOf(user1.address);
      expect(balAfter).to.be.gt(balBefore);
    });

    it("should charge withdrawal fee to treasury", async function () {
      const { vault, usdc, user1, treasuryAddr } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6));

      const shares = await vault.shareBalanceOf(user1.address);
      const treasuryBefore = await usdc.balanceOf(treasuryAddr.address);

      await vault.connect(user1).withdraw(shares);

      // Withdrawal fee should go to treasury
      expect(await usdc.balanceOf(treasuryAddr.address)).to.be.gt(treasuryBefore);
    });

    it("should revert with zero shares", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await expect(vault.connect(user1).withdraw(0))
        .to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should revert with insufficient shares", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await expect(vault.connect(user1).withdraw(1000))
        .to.be.revertedWithCustomError(vault, "InsufficientShares");
    });

    it("should revert if liquidity insufficient (funds bridged)", async function () {
      const { vault, usdc, user1, bridgeAdmin } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6));

      // Bridge most USDC to Polygon
      const vaultBalance = await usdc.balanceOf(await vault.getAddress());
      await vault.connect(bridgeAdmin).bridgeToPolygon(vaultBalance - 1n);

      const shares = await vault.shareBalanceOf(user1.address);
      await expect(vault.connect(user1).withdraw(shares))
        .to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
    });

    it("should update staking deposits on withdraw", async function () {
      const { vault, staking, user1 } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6));
      const deposited = await staking.totalDeposited(user1.address);
      expect(deposited).to.be.gt(0);

      const shares = await vault.shareBalanceOf(user1.address);
      await vault.connect(user1).withdraw(shares);

      // totalDeposited should decrease
      expect(await staking.totalDeposited(user1.address)).to.be.lt(deposited);
    });
  });

  describe("Bridge", function () {
    it("should bridge USDC to polygon (sends to bridgeAdmin)", async function () {
      const { vault, usdc, user1, bridgeAdmin } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      const bridgeAmount = ethers.parseUnits("5000", 6);
      const adminBefore = await usdc.balanceOf(bridgeAdmin.address);

      await expect(vault.connect(bridgeAdmin).bridgeToPolygon(bridgeAmount))
        .to.emit(vault, "BridgedToPolygon");

      expect(await usdc.balanceOf(bridgeAdmin.address)).to.equal(adminBefore + bridgeAmount);
      expect(await vault.bridgedAmount()).to.equal(bridgeAmount);
    });

    it("should track returnFromPolygon", async function () {
      const { vault, usdc, user1, bridgeAdmin } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      const bridgeAmount = ethers.parseUnits("5000", 6);
      await vault.connect(bridgeAdmin).bridgeToPolygon(bridgeAmount);

      // Admin sends USDC back to vault
      await usdc.mint(bridgeAdmin.address, bridgeAmount); // simulate bridge return
      await usdc.connect(bridgeAdmin).transfer(await vault.getAddress(), bridgeAmount);
      await vault.connect(bridgeAdmin).returnFromPolygon(bridgeAmount);

      expect(await vault.bridgedAmount()).to.equal(0);
    });

    it("should handle profit case (returned > bridged)", async function () {
      const { vault, usdc, user1, bridgeAdmin } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      const bridgeAmount = ethers.parseUnits("5000", 6);
      await vault.connect(bridgeAdmin).bridgeToPolygon(bridgeAmount);

      // Return more than bridged (profit)
      const returnAmount = ethers.parseUnits("6000", 6);
      await usdc.mint(bridgeAdmin.address, returnAmount);
      await usdc.connect(bridgeAdmin).transfer(await vault.getAddress(), returnAmount);
      await vault.connect(bridgeAdmin).returnFromPolygon(returnAmount);

      expect(await vault.bridgedAmount()).to.equal(0); // Clamped to 0
    });

    it("should revert if not bridge admin", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6));
      await expect(vault.connect(user1).bridgeToPolygon(100))
        .to.be.revertedWithCustomError(vault, "OnlyBridgeAdmin");
    });

    it("should revert bridge with insufficient liquidity", async function () {
      const { vault, bridgeAdmin } = await loadFixture(deployFixture);
      await expect(vault.connect(bridgeAdmin).bridgeToPolygon(ethers.parseUnits("1000", 6)))
        .to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
    });
  });

  describe("NAV & totalAssets", function () {
    it("should calculate totalAssets = free + bridged + positions", async function () {
      const { vault, usdc, user1, bridgeAdmin, keeper } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      const freeUsdc = await usdc.balanceOf(await vault.getAddress());

      // Bridge some
      await vault.connect(bridgeAdmin).bridgeToPolygon(ethers.parseUnits("3000", 6));

      // Set positions value
      await vault.connect(keeper).updatePositionsValue(ethers.parseUnits("1500", 6));

      const total = await vault.totalAssets();
      const expected = (freeUsdc - ethers.parseUnits("3000", 6)) + ethers.parseUnits("3000", 6) + ethers.parseUnits("1500", 6);
      expect(total).to.equal(expected);
    });

    it("should reject NAV update with too large deviation", async function () {
      const { vault, user1, keeper } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      await vault.connect(keeper).updatePositionsValue(ethers.parseUnits("1000", 6));

      // >20% deviation
      await expect(vault.connect(keeper).updatePositionsValue(ethers.parseUnits("1300", 6)))
        .to.be.revertedWithCustomError(vault, "NavDeviationTooLarge");
    });

    it("should allow NAV update within deviation", async function () {
      const { vault, user1, keeper } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      await vault.connect(keeper).updatePositionsValue(ethers.parseUnits("1000", 6));
      await vault.connect(keeper).updatePositionsValue(ethers.parseUnits("1100", 6)); // 10% OK
      expect(await vault.positionsValue()).to.equal(ethers.parseUnits("1100", 6));
    });

    it("should reject NAV update from non-keeper", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await expect(vault.connect(user1).updatePositionsValue(100))
        .to.be.revertedWithCustomError(vault, "OnlyKeeper");
    });
  });

  describe("Performance Fee", function () {
    it("should collect performance fee when NAV exceeds HWM", async function () {
      const { vault, usdc, user1, keeper, treasuryAddr } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      const hwm = await vault.highWaterMark();

      // Simulate profit: positions gained value
      await vault.connect(keeper).updatePositionsValue(ethers.parseUnits("2000", 6));

      // Advance time past fee period
      await time.increase(25 * 3600);

      const treasuryBefore = await usdc.balanceOf(treasuryAddr.address);
      await vault.connect(keeper).collectPerformanceFee();
      const treasuryAfter = await usdc.balanceOf(treasuryAddr.address);

      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });

    it("should not collect fee before period", async function () {
      const { vault, user1, keeper } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      await expect(vault.connect(keeper).collectPerformanceFee())
        .to.be.revertedWithCustomError(vault, "FeeTooEarly");
    });

    it("should not collect fee when NAV below HWM", async function () {
      const { vault, usdc, user1, keeper, treasuryAddr } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));

      await time.increase(25 * 3600);

      const treasuryBefore = await usdc.balanceOf(treasuryAddr.address);
      await vault.connect(keeper).collectPerformanceFee();
      // No fee since no profit
      expect(await usdc.balanceOf(treasuryAddr.address)).to.equal(treasuryBefore);
    });

    it("should update HWM after collection", async function () {
      const { vault, user1, keeper } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("10000", 6));
      await vault.connect(keeper).updatePositionsValue(ethers.parseUnits("2000", 6));

      await time.increase(25 * 3600);
      await vault.connect(keeper).collectPerformanceFee();

      // HWM should be updated to current totalAssets (post-fee)
      const hwm = await vault.highWaterMark();
      expect(hwm).to.equal(await vault.totalAssets());
    });
  });

  describe("Views", function () {
    it("should return share price 1:1 initially", async function () {
      const { vault } = await loadFixture(deployFixture);
      expect(await vault.sharePrice()).to.equal(ethers.parseUnits("1", 6));
    });

    it("should return user position", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6));

      const [shares, value] = await vault.userPosition(user1.address);
      expect(shares).to.be.gt(0);
      expect(value).to.be.gt(0);
    });

    it("should return freeAssets", async function () {
      const { vault, usdc, user1 } = await loadFixture(deployFixture);
      await vault.connect(user1).deposit(ethers.parseUnits("1000", 6));
      expect(await vault.freeAssets()).to.equal(await usdc.balanceOf(await vault.getAddress()));
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

    it("should set treasury", async function () {
      const { vault, owner, user1 } = await loadFixture(deployFixture);
      await vault.connect(owner).setTreasury(user1.address);
      expect(await vault.treasury()).to.equal(user1.address);
    });

    it("should set fee params", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).setMaxNavDeviationBps(3000);
      expect(await vault.maxNavDeviationBps()).to.equal(3000);

      await vault.connect(owner).setPerfFeeBps(1000);
      expect(await vault.perfFeeBps()).to.equal(1000);

      await vault.connect(owner).setFeePeriod(2 * 3600);
      expect(await vault.feePeriod()).to.equal(2 * 3600);
    });

    it("should reject admin calls from non-owner", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      await expect(vault.connect(user1).setKeeper(user1.address))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should pause and unpause", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      await vault.connect(owner).pause();
      expect(await vault.paused()).to.be.true;
      await vault.connect(owner).unpause();
      expect(await vault.paused()).to.be.false;
    });
  });

  describe("UUPS Upgrade", function () {
    it("should upgrade by owner", async function () {
      const { vault, owner } = await loadFixture(deployFixture);
      const V2 = await ethers.getContractFactory("GordonVaultETH");
      await expect(upgrades.upgradeProxy(await vault.getAddress(), V2))
        .to.not.be.reverted;
    });

    it("should reject upgrade from non-owner", async function () {
      const { vault, user1 } = await loadFixture(deployFixture);
      const V2 = await ethers.getContractFactory("GordonVaultETH", user1);
      await expect(upgrades.upgradeProxy(await vault.getAddress(), V2))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });
});
