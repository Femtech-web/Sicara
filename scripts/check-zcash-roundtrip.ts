import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TestnetWallet } from "../services/zcash/sidecar-client";
import { assessDeposit, object } from "../services/zcash/protocol";
async function main() {
  const binary = resolve(".local/zcash/bin/zec-sidecar");
  const intent = JSON.parse(await readFile(resolve(".local/zcash/wallet/return-intents/phase0-shielded-return-20261028-v2.json"), "utf8"));
  if (intent.state !== "broadcast" || !intent.result?.txid) throw new Error("Expected an existing broadcast return intent; this checker never sends funds");
  const sender = await TestnetWallet.start({ binary, dataDir: resolve(".local/zcash/wallet") });
  try {
    const receiver = await TestnetWallet.start({ binary, dataDir: resolve(".local/zcash/return-wallet") });
    try {
      const sourceAddress = await sender.address(), returnAddress = await receiver.address();
      if (returnAddress !== intent.recipient) throw new Error("Return receiver does not match the saved intent");
      const source = await sender.deposits(), received = await receiver.deposits();
      if (source.stale || received.stale) throw new Error("Wallet scan stale; do not mark round trip verified");
      const tx = await sender.inspect(intent.result.txid);
      const transparent = object(tx.transparent), sapling = object(tx.sapling), orchard = object(tx.orchard), ironwood = object(tx.ironwood);
      const fullyShielded = tx.complete === true && transparent.inputs === 0 && transparent.outputs === 0 && sapling.spends === 0 && sapling.outputs === 0 && orchard.actions === 0 && typeof ironwood.actions === "number" && ironwood.actions > 0;
      const notes = received.notes.filter((note) => note.txid === intent.result.txid && note.address === returnAddress);
      const assessment = assessDeposit({ ...received, notes }, returnAddress, BigInt(intent.zatoshis));
      const confirmationCounts = notes.map((note) => note.height !== null && note.height <= received.tip ? received.tip - note.height + 1 : 0);
      const evidence = { network: "test", sourceAddress, returnAddress, sourceTip: source.tip, returnTip: received.tip, sourceDepositNotes: source.notes.filter((note) => note.address === sourceAddress), returnTransaction: intent.result, inspection: tx, returnNotes: notes, confirmationCounts, assessment, fullyShielded, completed: fullyShielded && assessment.status === "confirmed", reopenedFromPersistentWallets: true, checkedAt: new Date().toISOString() };
      await mkdir(resolve(".local/evidence"), { recursive: true, mode: 0o700 });
      await writeFile(resolve(".local/evidence/zcash-roundtrip.json"), JSON.stringify(evidence, (_, value) => typeof value === "bigint" ? value.toString() : value, 2), { mode: 0o600 });
      console.log(JSON.stringify({ txid: intent.result.txid, fullyShielded, confirmations: confirmationCounts, status: assessment.status, completed: evidence.completed }));
      return evidence.completed;
    } finally { await receiver.close(); }
  } finally { await sender.close(); }
}
async function run() {
  const wait = process.argv.includes("--wait");
  for (let attempt = 0; attempt < (wait ? 24 : 1); attempt++) {
    if (await main() || !wait) return;
    await new Promise((resolve) => setTimeout(resolve, 20_000));
  }
  throw new Error("Confirmation wait exceeded eight minutes; recorded evidence remains pending.");
}
run().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Zcash verification failed"); process.exitCode = 1; });
