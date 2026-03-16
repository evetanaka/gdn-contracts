import { ethers } from 'hardhat';
import * as crypto from 'crypto';
import * as fs from 'fs';

const SAFE_ADDRESS = '0xEF1A70A1C4F7A0f7aEc481dF3E87E7B6ff9A6432';
const SAFE_TX_SERVICE = 'https://safe-transaction-mainnet.safe.global';
const CHAIN_ID = 1;

const VAULTS = [
  { name: 'Crypto', address: '0x7Ee4a1E4204769d6c501020d1D97E88dD99825c1' },
  { name: 'Sport', address: '0x041B9cA5b2b4c2584A1243a0ce90d92469917BD1' },
  { name: 'Finance', address: '0x3Fda04A7E9c2f4a985F9e6FD27E9AFE212E07eF1' },
  { name: 'Politic', address: '0x437Aa5A56Cb30DA951771E3734B5aB6dEB62FC27' },
];

const EIP712_DOMAIN = { chainId: CHAIN_ID, verifyingContract: SAFE_ADDRESS };
const EIP712_TYPES = {
  SafeTx: [
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'data', type: 'bytes' },
    { name: 'operation', type: 'uint8' },
    { name: 'safeTxGas', type: 'uint256' },
    { name: 'baseGas', type: 'uint256' },
    { name: 'gasPrice', type: 'uint256' },
    { name: 'gasToken', type: 'address' },
    { name: 'refundReceiver', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

function decryptDeployerKey(): string {
  const data = JSON.parse(fs.readFileSync('/data/.openclaw/secure/gordon-deployer.json', 'utf8'));
  const key = Buffer.from(data.key, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
  let result = decipher.update(data.encrypted, 'hex', 'utf8');
  result += decipher.final('utf8');
  return result;
}

async function main() {
  // 1. Deploy the new V4 implementation
  console.log('Deploying GordonVaultETHV4 implementation...');
  const V4Factory = await ethers.getContractFactory('GordonVaultETHV4');
  const v4Impl = await V4Factory.deploy();
  await v4Impl.waitForDeployment();
  const implAddress = await v4Impl.getAddress();
  console.log(`✅ V4 implementation deployed at: ${implAddress}`);

  // 2. Encode upgradeToAndCall(newImpl, initializeV4())
  const v4Interface = V4Factory.interface;
  const initData = v4Interface.encodeFunctionData('initializeV4', []);

  // UUPS upgrade call: upgradeToAndCall(address newImplementation, bytes data)
  const proxyInterface = new ethers.Interface([
    'function upgradeToAndCall(address newImplementation, bytes memory data) external',
  ]);

  // 3. Get deployer signer
  const pk = decryptDeployerKey();
  const signer = new ethers.Wallet(pk);
  console.log(`Signer: ${signer.address}`);

  // 4. Get Safe nonce (accounting for queued txs)
  const safeRes = await fetch(`${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/`);
  const safeInfo = await safeRes.json();
  let nonce = safeInfo.nonce;

  const queueRes = await fetch(
    `${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/multisig-transactions/?ordering=-nonce&limit=1&executed=false`
  );
  if (queueRes.ok) {
    const queueData = await queueRes.json();
    if (queueData.results?.length > 0) {
      nonce = Math.max(nonce, queueData.results[0].nonce + 1);
    }
  }
  console.log(`Safe nonce: ${nonce}`);

  // 5. Propose upgrade for each vault
  for (const vault of VAULTS) {
    console.log(`\nProposing V4 upgrade for ${vault.name} (${vault.address})...`);

    const upgradeCalldata = proxyInterface.encodeFunctionData('upgradeToAndCall', [implAddress, initData]);

    const safeTxData = {
      to: vault.address,
      value: BigInt(0),
      data: upgradeCalldata,
      operation: 0,
      safeTxGas: BigInt(0),
      baseGas: BigInt(0),
      gasPrice: BigInt(0),
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: BigInt(nonce),
    };

    const signature = await signer.signTypedData(EIP712_DOMAIN, EIP712_TYPES, safeTxData);
    const safeTxHash = ethers.TypedDataEncoder.hash(EIP712_DOMAIN, EIP712_TYPES, safeTxData);

    const body = {
      to: vault.address,
      value: '0',
      data: upgradeCalldata,
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce,
      contractTransactionHash: safeTxHash,
      sender: signer.address,
      signature,
    };

    const res = await fetch(`${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/multisig-transactions/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 201 || res.status === 200) {
      console.log(`✅ ${vault.name}: Upgrade proposal submitted (nonce ${nonce})`);
    } else {
      const err = await res.text();
      console.log(`❌ ${vault.name}: Failed — ${res.status} ${err}`);
    }

    nonce++;
  }

  console.log(`\n🎯 V4 implementation: ${implAddress}`);
  console.log(`Sign upgrades at: https://app.safe.global/transactions/queue?safe=eth:${SAFE_ADDRESS}`);
}

main().catch(console.error);
