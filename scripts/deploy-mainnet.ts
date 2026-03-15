import { ethers, upgrades } from "hardhat";

/**
 * Deploy GordonVaultETH (mainnet merged contract) as UUPS proxy.
 * Deploys 4 vaults: crypto, sport, finance, politic.
 *
 * After deployment, ownership is transferred to the Gnosis Safe multisig.
 *
 * Prerequisites:
 * - Deployer wallet funded with ETH for gas
 * - Staking contract deployed (or use placeholder)
 * - USDC mainnet address
 */

const SAFE = "0xEF1A70A1C4F7A0f7aEc481dF3E87E7B6ff9A6432";
const USDC_MAINNET = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Mirror wallets (Polygon EOAs, already generated)
const MIRRORS = {
  crypto: "0x5598A8ae361b70A8096198f93985E99c3cC82A9A",
  sport: "0x16BD7D71d70Efa2Ce0cac3008649ae2C5a83D3e1",
  finance: "0x8DC6636be711104f332095962e2A03c331bB5C62",
  politic: "0xC20764388eb003a155B763f7AE7B04C9Ce5C2Af8",
};

// Vault configs
const VAULTS = [
  { name: "Gordon Crypto Vault", slug: "crypto", mirror: MIRRORS.crypto },
  { name: "Gordon Sport Vault", slug: "sport", mirror: MIRRORS.sport },
  { name: "Gordon Finance Vault", slug: "finance", mirror: MIRRORS.finance },
  { name: "Gordon Politic Vault", slug: "politic", mirror: MIRRORS.politic },
];

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("Safe:", SAFE);
  console.log("USDC:", USDC_MAINNET);
  console.log("");

  // NOTE: Staking contract must exist on mainnet.
  // For initial deployment, we can use a placeholder that returns tier 0 for everyone.
  // Replace this address once the real staking contract is deployed.
  const STAKING_PLACEHOLDER = deployer.address; // TODO: deploy MockStaking or real staking first

  const Factory = await ethers.getContractFactory("GordonVaultETHMainnet");

  const results: Record<string, string> = {};

  for (const vault of VAULTS) {
    console.log(`\n─── Deploying ${vault.name} ───`);

    const proxy = await upgrades.deployProxy(
      Factory,
      [
        USDC_MAINNET,
        vault.name,
        vault.slug,
        deployer.address,   // keeper (temporary, will be set properly later)
        deployer.address,   // bridgeAdmin (temporary)
        SAFE,                // treasury → Safe receives fees
        STAKING_PLACEHOLDER, // staking
        vault.mirror,        // Polygon mirror wallet
      ],
      {
        initializer: "initialize",
        kind: "uups",
      }
    );

    await proxy.waitForDeployment();
    const proxyAddr = await proxy.getAddress();
    console.log(`  Proxy: ${proxyAddr}`);

    // Transfer ownership to Safe
    console.log(`  Transferring ownership to Safe...`);
    const tx = await proxy.transferOwnership(SAFE);
    await tx.wait();
    console.log(`  ✓ Owner = ${SAFE}`);

    results[vault.slug] = proxyAddr;
  }

  // Get implementation address (same for all proxies)
  const implAddr = await upgrades.erc1967.getImplementationAddress(results.crypto);
  console.log(`\n═══ Implementation: ${implAddr}`);

  console.log("\n═══ Proxy Addresses ═══");
  for (const [slug, addr] of Object.entries(results)) {
    console.log(`  ${slug}: ${addr}`);
  }

  console.log("\n═══ Next Steps ═══");
  console.log("1. Update backend .env with new proxy addresses");
  console.log("2. Set proper keeper via Safe: vault.setKeeper(keeperAddress)");
  console.log("3. Set proper bridgeAdmin via Safe: vault.setBridgeAdmin(bridgeAdminAddress)");
  console.log("4. Deploy staking contract and update via Safe: vault.setStakingContract(stakingAddress)");
  console.log("5. Fund mirrors with POL + USDC.e on Polygon");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
