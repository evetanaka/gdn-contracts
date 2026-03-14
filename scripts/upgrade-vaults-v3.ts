import { ethers, upgrades } from "hardhat";

/**
 * Upgrade all 4 GordonVaultETH proxies from V2 to V3.
 * Then call initializeV3() to set hwmSharePrice and mgmtFeeBps.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-vaults-v3.ts --network sepolia
 */

const VAULT_PROXIES: Record<string, string> = {
  crypto:  "0x8514c5A9C9F1eD0CaeE4179F96e4CC8f506F3896",
  sport:   "0xC12f28655c0434497EC80782689775E85C34BA5d",
  finance: "0x064f757efdf2b284C1D3c3088b38469275E78f4C",
  politic: "0x2BF448256217E713C569d52015a8E4ed237F19fb",
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Upgrading with:", deployer.address);

  const V2Factory = await ethers.getContractFactory("GordonVaultETHV2");
  const V3Factory = await ethers.getContractFactory("GordonVaultETHV3");

  for (const [slug, proxyAddr] of Object.entries(VAULT_PROXIES)) {
    console.log(`\n--- Upgrading ${slug} vault to V3 ---`);
    console.log(`  Proxy: ${proxyAddr}`);

    // Force-import as V2 if not registered
    try {
      await upgrades.forceImport(proxyAddr, V2Factory, { kind: "uups" });
      console.log(`  ✓ Force-imported V2 proxy`);
    } catch (e: any) {
      if (!e.message?.includes("already registered")) throw e;
      console.log(`  ℹ Already registered`);
    }

    // Upgrade to V3
    const upgraded = await upgrades.upgradeProxy(proxyAddr, V3Factory);
    await upgraded.waitForDeployment();
    console.log(`  ✓ Upgraded to V3`);

    await sleep(5000);

    // Check if already initialized
    try {
      const hwm = await upgraded.hwmSharePrice();
      if (hwm > 0n) {
        console.log(`  ℹ Already initialized (hwmSharePrice=${hwm})`);
        continue;
      }
    } catch {}

    // Initialize V3
    const tx = await upgraded.initializeV3();
    await tx.wait();
    console.log(`  ✓ initializeV3 called`);

    await sleep(5000);

    // Verify
    const hwm = await upgraded.hwmSharePrice();
    const mgmt = await upgraded.mgmtFeeBps();
    console.log(`  ✓ hwmSharePrice=${hwm}, mgmtFeeBps=${mgmt}`);
  }

  // Final verification
  console.log("\n" + "=".repeat(50));
  console.log("VERIFICATION");
  console.log("=".repeat(50));

  for (const [slug, proxyAddr] of Object.entries(VAULT_PROXIES)) {
    const v3 = await ethers.getContractAt("GordonVaultETHV3", proxyAddr);
    try {
      const [currentPrice, hwm, mgmt, perf, pendingMgmt, pendingPerf, lastColl, nextEligible] =
        await v3.feeStatus();
      console.log(`${slug}:`);
      console.log(`  sharePrice=${currentPrice} hwm=${hwm} mgmt=${mgmt}bps perf=${perf}bps`);
      console.log(`  pendingMgmt=${pendingMgmt} shares, pendingPerf=$${Number(pendingPerf) / 1e6}`);
    } catch (e: any) {
      console.log(`${slug}: feeStatus() failed — ${e.message?.slice(0, 60)}`);
    }
  }

  console.log("\nAll vaults upgraded to V3 ✅");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
