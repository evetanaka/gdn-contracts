import { ethers, upgrades } from "hardhat";

/**
 * Deploy all Gordon.fi contracts to Sepolia testnet.
 *
 * Order:
 * 1. MockUSDC (testnet only)
 * 2. GDNToken
 * 3. GDNPriceFeed
 * 4. GDNStaking (UUPS proxy)
 * 5. Treasury (UUPS proxy)
 * 6. GordonVaultETH × 4 (UUPS proxies) — Crypto, Sport, Finance, Politic
 * 7. Wire everything: register vaults in staking, authorize vaults in treasury, set treasury in staking
 * 8. Seed: mint USDC to deployer
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");

  // ─── 1. MockUSDC ───
  console.log("\n--- 1. MockUSDC ---");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const usdc = await MockUSDC.deploy();
  await usdc.waitForDeployment();
  const usdcAddr = await usdc.getAddress();
  console.log("MockUSDC:", usdcAddr);

  // ─── 2. GDNToken ───
  console.log("\n--- 2. GDNToken ---");
  const GDNToken = await ethers.getContractFactory("GDNToken");
  const gdn = await GDNToken.deploy(deployer.address); // treasury = deployer for now
  await gdn.waitForDeployment();
  const gdnAddr = await gdn.getAddress();
  console.log("GDNToken:", gdnAddr);

  // ─── 3. GDNPriceFeed ───
  console.log("\n--- 3. GDNPriceFeed ---");
  const PriceFeed = await ethers.getContractFactory("GDNPriceFeed");
  const priceFeed = await PriceFeed.deploy(
    deployer.address, // oracle = deployer (keeper-pushed Phase 1)
    ethers.parseUnits("0.10", 8) // $0.10 initial price
  );
  await priceFeed.waitForDeployment();
  const priceFeedAddr = await priceFeed.getAddress();
  console.log("GDNPriceFeed:", priceFeedAddr);

  // ─── 4. GDNStaking (proxy) ───
  console.log("\n--- 4. GDNStaking ---");
  const Staking = await ethers.getContractFactory("GDNStaking");
  // Initialize with deployer as treasury (will update after Treasury deploy)
  const staking = await upgrades.deployProxy(Staking, [
    gdnAddr,
    priceFeedAddr,
    deployer.address, // temporary treasury
  ], { kind: "uups" });
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log("GDNStaking (proxy):", stakingAddr);

  // ─── 5. MockDEXRouter (testnet only) ───
  console.log("\n--- 5. MockDEXRouter ---");
  const MockDEX = await ethers.getContractFactory("MockDEXRouter");
  const dex = await MockDEX.deploy(usdcAddr, gdnAddr);
  await dex.waitForDeployment();
  const dexAddr = await dex.getAddress();
  console.log("MockDEXRouter:", dexAddr);

  // Fund DEX with GDN for swaps
  const dexFunding = ethers.parseUnits("20000000", 18); // 20M GDN
  await (await gdn.transfer(dexAddr, dexFunding)).wait();
  console.log("  Funded DEX with 20M GDN");

  // ─── 6. Treasury (proxy) ───
  console.log("\n--- 6. Treasury ---");
  const TreasuryFactory = await ethers.getContractFactory("Treasury");
  const treasury = await upgrades.deployProxy(TreasuryFactory, [
    usdcAddr,
    gdnAddr,
    stakingAddr,
    dexAddr,
    deployer.address, // keeper = deployer for now
  ], { kind: "uups" });
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log("Treasury (proxy):", treasuryAddr);

  // Update staking treasury
  await (await staking.setTreasury(treasuryAddr)).wait();
  console.log("  Updated staking treasury →", treasuryAddr);

  // ─── 7. GordonVaultETH × 4 ───
  const vaults = [
    { name: "Gordon Crypto Vault", slug: "crypto" },
    { name: "Gordon Sport Vault", slug: "sport" },
    { name: "Gordon Finance Vault", slug: "finance" },
    { name: "Gordon Politic Vault", slug: "politic" },
  ];

  const vaultAddresses: string[] = [];
  const VaultFactory = await ethers.getContractFactory("GordonVaultETH");

  for (let i = 0; i < vaults.length; i++) {
    const v = vaults[i];
    console.log(`\n--- 7.${i + 1}. ${v.name} ---`);
    const vault = await upgrades.deployProxy(VaultFactory, [
      usdcAddr,
      v.name,
      v.slug,
      deployer.address, // keeper
      deployer.address, // bridgeAdmin
      treasuryAddr,
      stakingAddr,
    ], { kind: "uups" });
    await vault.waitForDeployment();
    const addr = await vault.getAddress();
    vaultAddresses.push(addr);
    console.log(`${v.name} (proxy):`, addr);
  }

  // ─── 8. Wire: register vaults ───
  console.log("\n--- 8. Wiring ---");
  for (let i = 0; i < vaultAddresses.length; i++) {
    await (await staking.registerVault(vaultAddresses[i])).wait();
    console.log(`  Registered vault ${vaults[i].slug} in staking`);

    await (await treasury.authorizeSource(vaultAddresses[i])).wait();
    console.log(`  Authorized vault ${vaults[i].slug} in treasury`);
  }

  // ─── 9. Seed: mint USDC ───
  console.log("\n--- 9. Seed ---");
  const mintAmount = ethers.parseUnits("1000000", 6); // 1M USDC
  await (await usdc.mint(deployer.address, mintAmount)).wait();
  console.log("  Minted 1M USDC to deployer");

  // ─── Summary ───
  console.log("\n" + "=".repeat(60));
  console.log("DEPLOYMENT SUMMARY — Sepolia");
  console.log("=".repeat(60));
  console.log("MockUSDC:        ", usdcAddr);
  console.log("GDNToken:        ", gdnAddr);
  console.log("GDNPriceFeed:    ", priceFeedAddr);
  console.log("GDNStaking:      ", stakingAddr);
  console.log("MockDEXRouter:   ", dexAddr);
  console.log("Treasury:        ", treasuryAddr);
  for (let i = 0; i < vaults.length; i++) {
    console.log(`Vault ${vaults[i].slug.padEnd(12)}:`, vaultAddresses[i]);
  }
  console.log("=".repeat(60));
  console.log("\nDeployer:", deployer.address);
  console.log("Network: Sepolia (chainId 11155111)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
