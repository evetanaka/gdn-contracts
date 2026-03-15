import { ethers, upgrades } from "hardhat";

/**
 * Deploy full Gordon.fi ecosystem on Ethereum mainnet:
 * 1. GDNToken (100M to Safe)
 * 2. GDNPriceFeed (keeper-pushed oracle)
 * 3. GDNStaking (UUPS proxy)
 * 4. 4x GordonVaultETHMainnet (UUPS proxies)
 * 5. Register vaults in staking
 * 6. Transfer all ownerships to Gnosis Safe
 */

const SAFE = "0xEF1A70A1C4F7A0f7aEc481dF3E87E7B6ff9A6432";
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Initial $GDN price: $0.01 (8 decimals) — placeholder until DEX listing
const INITIAL_GDN_PRICE = 1_000_000; // $0.01 in 8 decimals

// Mirror wallets (Polygon EOAs)
const MIRRORS = {
  crypto: "0x5598A8ae361b70A8096198f93985E99c3cC82A9A",
  sport: "0x16BD7D71d70Efa2Ce0cac3008649ae2C5a83D3e1",
  finance: "0x8DC6636be711104f332095962e2A03c331bB5C62",
  politic: "0xC20764388eb003a155B763f7AE7B04C9Ce5C2Af8",
};

const VAULTS = [
  { name: "Gordon Crypto Vault", slug: "crypto", mirror: MIRRORS.crypto },
  { name: "Gordon Sport Vault", slug: "sport", mirror: MIRRORS.sport },
  { name: "Gordon Finance Vault", slug: "finance", mirror: MIRRORS.finance },
  { name: "Gordon Politic Vault", slug: "politic", mirror: MIRRORS.politic },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("═══════════════════════════════════════════");
  console.log("  Gordon.fi Mainnet Deployment");
  console.log("═══════════════════════════════════════════");
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("Safe:", SAFE);
  console.log("");

  // ─── 1. GDN Token ──────────────────────────────────
  console.log("─── 1. Deploying GDNToken ───");
  const GDNToken = await ethers.getContractFactory("GDNToken");
  const gdnToken = await GDNToken.deploy(SAFE); // 100M minted to Safe
  await gdnToken.waitForDeployment();
  const gdnTokenAddr = await gdnToken.getAddress();
  console.log(`  GDNToken: ${gdnTokenAddr}`);
  console.log(`  100M $GDN minted to Safe`);

  // ─── 2. GDN Price Feed ─────────────────────────────
  console.log("\n─── 2. Deploying GDNPriceFeed ───");
  const PriceFeed = await ethers.getContractFactory("GDNPriceFeed");
  const priceFeed = await PriceFeed.deploy(
    deployer.address,    // oracle = deployer initially (keeper pushes prices)
    INITIAL_GDN_PRICE    // $0.01
  );
  await priceFeed.waitForDeployment();
  const priceFeedAddr = await priceFeed.getAddress();
  console.log(`  PriceFeed: ${priceFeedAddr}`);
  console.log(`  Initial price: $${INITIAL_GDN_PRICE / 1e8}`);

  // Increase staleness to 7 days for initial period (no active oracle yet)
  const setStaleTx = await priceFeed.setMaxStaleness(7 * 24 * 3600);
  await setStaleTx.wait();
  console.log(`  Max staleness set to 7 days (initial grace period)`);

  // Transfer ownership to Safe
  const pfOwnerTx = await priceFeed.transferOwnership(SAFE);
  await pfOwnerTx.wait();
  console.log(`  ✓ PriceFeed owner → Safe`);

  // ─── 3. GDN Staking ────────────────────────────────
  console.log("\n─── 3. Deploying GDNStaking (UUPS proxy) ───");
  const Staking = await ethers.getContractFactory("GDNStaking");
  const staking = await upgrades.deployProxy(
    Staking,
    [gdnTokenAddr, priceFeedAddr, SAFE], // treasury = Safe
    { initializer: "initialize", kind: "uups" }
  );
  await staking.waitForDeployment();
  const stakingAddr = await staking.getAddress();
  console.log(`  Staking proxy: ${stakingAddr}`);

  // ─── 4. Vault Proxies ──────────────────────────────
  console.log("\n─── 4. Deploying 4 Vault Proxies ───");
  const VaultFactory = await ethers.getContractFactory("GordonVaultETHMainnet");
  const vaultAddresses: Record<string, string> = {};

  for (const vault of VAULTS) {
    console.log(`\n  Deploying ${vault.name}...`);
    const proxy = await upgrades.deployProxy(
      VaultFactory,
      [
        USDC_MAINNET,
        vault.name,
        vault.slug,
        deployer.address,   // keeper (deployer initially, changed via Safe later)
        deployer.address,   // bridgeAdmin (deployer initially)
        SAFE,                // treasury
        stakingAddr,         // staking contract
        vault.mirror,        // Polygon mirror wallet
      ],
      { initializer: "initialize", kind: "uups" }
    );
    await proxy.waitForDeployment();
    const proxyAddr = await proxy.getAddress();
    vaultAddresses[vault.slug] = proxyAddr;
    console.log(`  Proxy: ${proxyAddr}`);
  }

  // ─── 5. Register vaults in staking ─────────────────
  console.log("\n─── 5. Registering vaults in staking ───");
  for (const [slug, addr] of Object.entries(vaultAddresses)) {
    const tx = await staking.registerVault(addr);
    await tx.wait();
    console.log(`  ✓ ${slug}: ${addr}`);
  }

  // ─── 6. Transfer ownerships to Safe ────────────────
  console.log("\n─── 6. Transferring ownerships to Safe ───");

  // Staking
  const stakingOwnerTx = await staking.transferOwnership(SAFE);
  await stakingOwnerTx.wait();
  console.log("  ✓ Staking → Safe");

  // Vaults
  for (const [slug, addr] of Object.entries(vaultAddresses)) {
    const vault = VaultFactory.attach(addr);
    const tx = await vault.transferOwnership(SAFE);
    await tx.wait();
    console.log(`  ✓ ${slug} vault → Safe`);
  }

  // ─── Summary ───────────────────────────────────────
  const implAddr = await upgrades.erc1967.getImplementationAddress(vaultAddresses.crypto);
  const stakingImplAddr = await upgrades.erc1967.getImplementationAddress(stakingAddr);

  console.log("\n═══════════════════════════════════════════");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("═══════════════════════════════════════════");
  console.log(`  GDN Token:        ${gdnTokenAddr}`);
  console.log(`  Price Feed:       ${priceFeedAddr}`);
  console.log(`  Staking Proxy:    ${stakingAddr}`);
  console.log(`  Staking Impl:     ${stakingImplAddr}`);
  console.log(`  Vault Impl:       ${implAddr}`);
  console.log("");
  console.log("  Vault Proxies:");
  for (const [slug, addr] of Object.entries(vaultAddresses)) {
    console.log(`    ${slug.padEnd(10)} ${addr}`);
  }
  console.log("");
  console.log("  Owner (all):      ", SAFE);
  console.log("  Keeper (temp):    ", deployer.address);
  console.log("  Bridge Admin:     ", deployer.address);
  console.log("  Treasury:         ", SAFE);
  console.log("");
  console.log("═══ Next Steps ═══");
  console.log("1. Update backend .env with all addresses above");
  console.log("2. Via Safe: setKeeper() on each vault to the backend keeper wallet");
  console.log("3. Via Safe: setBridgeAdmin() on each vault to Réda's wallet");
  console.log("4. Fund mirrors with POL + USDC.e on Polygon");
  console.log("5. Fund deployer/keeper with small ETH for gas (updatePositionsValue, collectFees)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
