import { ethers, fhevm } from "hardhat";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FhevmType } from "@fhevm/hardhat-plugin";
async function main() {
  await fhevm.initializeCLIApi();
  if (fhevm.isMock || (await ethers.provider.getNetwork()).chainId !== 11155111n) throw new Error("Live Sepolia only");
  const directory = resolve(__dirname, "../../.local/evidence");
  const names = (await readdir(directory)).filter((name) => /^sepolia-[0-9a-f]{64}\.json$/.test(name));
  if (names.length !== 1) throw new Error("Expected exactly one spike run to inspect");
  const evidence = JSON.parse(await readFile(resolve(directory, names[0]), "utf8"));
  const [signer] = await ethers.getSigners();
  const pool = await ethers.getContractAt("ConfidentialLoanSpike", evidence.pool, signer);
  const token = await ethers.getContractAt("DemoZama", evidence.token, signer);
  await fhevm.assertCoprocessorInitialized(pool, "Sicara spike");
  const state = await pool.loanState(evidence.loanId);
  const capacity = await fhevm.userDecryptEuint(FhevmType.euint64, state.capacity, evidence.pool, signer);
  const debt = await fhevm.userDecryptEuint(FhevmType.euint64, state.debt, evidence.pool, signer);
  const balance = await fhevm.userDecryptEuint(FhevmType.euint64, await token.confidentialBalanceOf(signer.address), evidence.token, signer);
  const borrowed = await fhevm.userDecryptEbool(state.borrowed, evidence.pool, signer);
  const receipts = {} as Record<string, unknown>;
  for (const [stage, hash] of Object.entries(evidence.transactions)) {
    const receipt = await ethers.provider.getTransactionReceipt(hash as string);
    receipts[stage] = receipt ? { hash, status: receipt.status, block: receipt.blockNumber } : null;
  }
  const observation = { syntheticSpike: true, capacity: capacity.toString(), debt: debt.toString(), borrowerTokenBalance: balance.toString(), borrowed, settled: state.settled, receipts };
  await writeFile(resolve(directory, "sepolia-inspection.json"), JSON.stringify(observation, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(observation, null, 2));
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message.split("\n")[0].slice(0, 300) : "Inspection failed"); process.exitCode = 1; });
