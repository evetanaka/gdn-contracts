import { ethers, upgrades } from "hardhat";

/**
 * Upgrade all 4 GordonVaultETH proxies to V2.
 * Then call initializeV2() with each vault's Polygon mirror wallet address.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-vaults-v2.ts --network sepolia
 *
 * Prerequisites:
 *   - Mirror wallets must be generated first (via admin API)
 *   - Update MIRROR_WALLETS below with actual Polygon EOA addresses
 */

const VAULT_PROXIES: Record<string, string> = {
  crypto:  "0x8514c5A9C9F1eD0CaeE4179F96e4CC8f506F3896",
  sport:   "0xC12f28655c0434497EC80782689775E85C34BA5d",
  finance: "0x064f757efdf2b284C1D3c3088b38469275E78f4C",
  politic: "0x2BF448256217E713C569d52015a8E4ed237F19fb",
};

const MIRROR_WALLETS: Record<string, string> = {
  crypto:  "0x5598A8ae361b70A8096198f93985E99c3cC82A9A",
  sport:   "0x16BD7D71d70Efa2Ce0cac3008649ae2C5a83D3e1",
  finance: "0x8DC6636be711104f332095962e2A03c331bB5C62",
  politic: "0xC20764388eb003a155B763f7AE7B04C9Ce5C2Af8",
};

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Upgrading with:", deployer.address);

  const V2Factory = await ethers.getContractFactory("GordonVaultETHV2");

  for (const [slug, proxyAddr] of Object.entries(VAULT_PROXIES)) {
    const mirror = MIRROR_WALLETS[slug];
    if (!mirror) {
      console.log(`⚠️  Skipping ${slug} — no mirror wallet address set`);
      continue;
    }

    console.log(`\n--- Upgrading ${slug} vault ---`);
    console.log(`  Proxy: ${proxyAddr}`);
    console.log(`  Mirror: ${mirror}`);

    // Step 0: Force-import if not already registered
    const V1Factory = await ethers.getContractFactory("GordonVaultETH");
    try {
      await upgrades.forceImport(proxyAddr, V1Factory, { kind: "uups" });
      console.log(`  ✓ Force-imported V1 proxy`);
    } catch (e: any) {
      if (!e.message?.includes("already registered")) throw e;
      console.log(`  ℹ Already registered`);
    }

    // Step 1: Upgrade proxy to V2
    const upgraded = await upgrades.upgradeProxy(proxyAddr, V2Factory);
    await upgraded.waitForDeployment();
    console.log(`  ✓ Upgraded to V2`);

    // Step 2: Initialize V2 with mirror wallet
    const tx = await upgraded.initializeV2(mirror);
    await tx.wait();
    console.log(`  ✓ initializeV2 called — mirror set to ${mirror}`);

    // Step 3: Verify
    const storedMirror = await upgraded.getMirrorWallet();
    console.log(`  ✓ Verified on-chain mirror: ${storedMirror}`);

    if (storedMirror.toLowerCase() !== mirror.toLowerCase()) {
      console.error(`  ❌ MISMATCH! Expected ${mirror}, got ${storedMirror}`);
      process.exit(1);
    }
  }

  console.log("\n" + "=".repeat(50));
  console.log("All vaults upgraded to V2 ✅");
  console.log("=".repeat(50));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
