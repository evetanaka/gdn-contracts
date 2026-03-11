import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import * as dotenv from "dotenv";

dotenv.config();

const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY || "0x" + "00".repeat(32);
const SEPOLIA_RPC = process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org";
const POLYGON_RPC = process.env.POLYGON_RPC_URL || "";
const AMOY_RPC = process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY || "";
const POLYGONSCAN_KEY = process.env.POLYGONSCAN_API_KEY || "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "cancun",
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
    },
    sepolia: {
      url: SEPOLIA_RPC,
      chainId: 11155111,
      accounts: [DEPLOYER_KEY],
    },
    amoy: {
      url: AMOY_RPC,
      chainId: 80002,
      accounts: [DEPLOYER_KEY],
    },
    polygon: {
      url: POLYGON_RPC,
      chainId: 137,
      accounts: [DEPLOYER_KEY],
    },
  },
  etherscan: {
    apiKey: {
      sepolia: ETHERSCAN_KEY,
      polygon: POLYGONSCAN_KEY,
      polygonAmoy: POLYGONSCAN_KEY,
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
  },
};

export default config;
