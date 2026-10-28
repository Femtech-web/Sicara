import { ethers, network, fhevm } from "hardhat";
async function main() {
  if (network.name !== "sepolia") throw new Error("Run this check on Sepolia only");
  const [signer] = await ethers.getSigners();
  if (!signer) throw new Error("Set SEPOLIA_PRIVATE_KEY in contracts/.env locally. Do not share it in chat.");
  const chain = await ethers.provider.getNetwork();
  if (chain.chainId !== 11155111n) throw new Error("Configured RPC is not Sepolia");
  const balance = await ethers.provider.getBalance(signer.address);
  console.log(`Sepolia test account: ${signer.address}`);
  console.log(`Test ETH for gas: ${ethers.formatEther(balance)}`);
  if (balance === 0n) throw new Error("Fund this account with valueless Sepolia ETH before deployment.");
  console.log("RPC, signer and nonzero gas balance verified. No transaction sent.");
  await fhevm.initializeCLIApi();
  if (fhevm.isMock) throw new Error("Expected live Sepolia FHEVM, received mock configuration");
  console.log("Live FHEVM host contracts and relayer initialized. No transaction sent.");
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "Sepolia configuration check failed"); process.exitCode = 1; });
