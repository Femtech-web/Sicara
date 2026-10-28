#!/usr/bin/env node
// Protocol-only fixture. No cryptography, wallet, network or real transactions.
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
const dataDir = args[args.indexOf("--data-dir") + 1] ?? "";
const address = "utest15re965qrdvxun9399eps75cca8n9cakfh6anznck7evwrdsvusj00r2kpr9eddzvadex8xx4yrlnk5ahemu0jf495yhz5zz7eqglrjmm";
if (args[args.indexOf("--network") + 1] !== "test") process.exit(2);
console.log(JSON.stringify({ event: "ready", network: dataDir.endsWith("wrong-network") ? "main" : "test", address, tip: 109, viewOnly: false }));
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "send") {
    const memo = request.params?.outputs?.[0]?.memoHex;
    if (memo !== "f6" + "00".repeat(511) && !(typeof memo === 'string' && /^[a-f0-9]{1024}$/.test(memo) && Buffer.from(memo, 'hex').toString('utf8').startsWith('Sicara testnet refund '))) {
      console.log(JSON.stringify({ id: request.id, ok: false, error: { code: "BadRequest", message: "Memo must be 512 bytes" } }));
      return;
    }
    process.exit(1);
  } // Outcome must remain unknown to the caller.
  const responses = {
    address: { address }, newAddress: { address },
    poll: { notes: [], tip: 109, stale: false },
    sync: { tip: 109, fullyScanned: 109 },
    info: { network: "test", tip: 109, syncError: null, lastSyncMsAgo: dataDir.endsWith("stale") ? 60000 : 0 },
    ledger: { entries: [], tip: 109 }, balance: { spendable: "100000000" },
  };
  const result = responses[request.method] ?? {};
  console.log(JSON.stringify({ id: request.id, ok: true, result }));
});
