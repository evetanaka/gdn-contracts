# gdn-contracts

Smart contracts for the [Gordon.fi](https://gordon.fi) protocol.

## Contracts

| Contract | Upgradeable | Description |
|----------|-------------|-------------|
| `GDNToken` | ❌ No | ERC-20 governance token — 100M fixed supply |
| `GDNPriceFeed` | ❌ No | Oracle adapter for $GDN/USD price |
| `GDNStaking` | ✅ UUPS | Lock staking with boost, rewards, and early unstake slash |
| `GordonVault` | ✅ UUPS | ERC-4626 vault for Polymarket copy trading |
| `Treasury` | ✅ UUPS | Fee collection, buyback & burn, staker rewards |

## Setup

```bash
npm install
cp .env.example .env  # Fill in your keys
```

## Commands

```bash
npm run compile        # Compile contracts
npm test               # Run tests
npm run test:gas       # Run tests with gas reporting
npm run deploy:testnet # Deploy to Polygon Amoy
npm run deploy:mainnet # Deploy to Polygon PoS
```

## Architecture

```
Users ──► GordonVault (×4) ──► Treasury ──► Buyback & Burn $GDN
  │              │                 └──────► Staker Rewards ($GDN)
  │              │
  │              └──► Polymarket (via keeper)
  │
  └──► GDNStaking ◄── GDNPriceFeed (oracle)
```

## License

MIT
