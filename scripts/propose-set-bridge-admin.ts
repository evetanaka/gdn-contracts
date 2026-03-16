import { ethers } from 'ethers';
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

// setBridgeAdmin(address) — set to Safe itself
const iface = new ethers.Interface(['function setBridgeAdmin(address _admin)']);
const calldata = iface.encodeFunctionData('setBridgeAdmin', [SAFE_ADDRESS]);

function decryptDeployerKey(): string {
  const data = JSON.parse(fs.readFileSync('/data/.openclaw/secure/gordon-deployer.json', 'utf8'));
  const key = Buffer.from(data.key, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(data.tag, 'hex'));
  let result = decipher.update(data.encrypted, 'hex', 'utf8');
  result += decipher.final('utf8');
  return result;
}

// Safe EIP-712 domain and types
const EIP712_DOMAIN = {
  chainId: CHAIN_ID,
  verifyingContract: SAFE_ADDRESS,
};

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

async function main() {
  const pk = decryptDeployerKey();
  const signer = new ethers.Wallet(pk);
  console.log(`Signer: ${signer.address}`);

  // Get current nonce from Safe
  const nonceRes = await fetch(`${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/`);
  const safeInfo = await nonceRes.json();
  let nonce = safeInfo.nonce;
  console.log(`Safe nonce: ${nonce}`);

  for (const vault of VAULTS) {
    console.log(`\nProposing setBridgeAdmin for ${vault.name} vault (${vault.address})...`);

    const safeTxData = {
      to: vault.address,
      value: BigInt(0),
      data: calldata,
      operation: 0,
      safeTxGas: BigInt(0),
      baseGas: BigInt(0),
      gasPrice: BigInt(0),
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: BigInt(nonce),
    };

    // Sign EIP-712 typed data (produces correct v=27/28)
    const signature = await signer.signTypedData(
      EIP712_DOMAIN,
      EIP712_TYPES,
      safeTxData,
    );

    // Compute the safeTxHash for the API
    const safeTxHash = ethers.TypedDataEncoder.hash(
      EIP712_DOMAIN,
      EIP712_TYPES,
      safeTxData,
    );

    console.log(`SafeTxHash: ${safeTxHash}`);
    console.log(`Signature: ${signature.substring(0, 20)}...`);

    // Verify recovery
    const recovered = ethers.verifyTypedData(EIP712_DOMAIN, EIP712_TYPES, safeTxData, signature);
    console.log(`Recovered: ${recovered} (match: ${recovered.toLowerCase() === signer.address.toLowerCase()})`);

    // POST to Safe Transaction Service
    const body = {
      to: vault.address,
      value: '0',
      data: calldata,
      operation: 0,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: nonce,
      contractTransactionHash: safeTxHash,
      sender: signer.address,
      signature: signature,
    };

    const res = await fetch(`${SAFE_TX_SERVICE}/api/v1/safes/${SAFE_ADDRESS}/multisig-transactions/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.status === 201 || res.status === 200) {
      console.log(`✅ ${vault.name}: Proposal submitted (nonce ${nonce})`);
    } else {
      const err = await res.text();
      console.log(`❌ ${vault.name}: Failed — ${res.status} ${err}`);
    }

    nonce++;
  }

  console.log('\n🎯 All 4 proposals submitted. Réda needs to co-sign in the Safe app.');
  console.log(`Safe: https://app.safe.global/transactions/queue?safe=eth:${SAFE_ADDRESS}`);
}

main().catch(console.error);
