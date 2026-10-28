import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { TestnetWallet, SidecarRequestError } from "../services/zcash/sidecar-client";
import { assessDeposit, zatoshis } from "../services/zcash/protocol";

async function main() {
  const [command = "status", ...args] = process.argv.slice(2);
  const supported = ["init", "status", "address", "deposit", "return", "inspect"];
  if (!supported.includes(command)) throw new Error(`Choose: ${supported.join(", ")}`);
  const dataDir = resolve(process.env.SICARA_ZCASH_DATA_DIR || ".local/zcash/wallet");
  const wallet = await TestnetWallet.start({ binary: resolve(process.env.SICARA_ZCASH_BINARY || ".local/zcash/bin/zec-sidecar"), dataDir, create: command === "init" });
  try {
    if (command === "init" || command === "status") {
      console.log(JSON.stringify({ network: "test", address: await wallet.address(), info: await wallet.info(), balance: await wallet.balance() }, null, 2));
    } else if (command === "address") { console.log(await wallet.newAddress()); }
    else if (command === "deposit") {
      const [address, required] = args;
      if (!address || !required) throw new Error("Usage: deposit <testnet-UA> <required-zatoshis>");
      const assessment = assessDeposit(await wallet.deposits(), address, zatoshis(required));
      console.log(JSON.stringify(assessment, (_, value) => typeof value === "bigint" ? value.toString() : value, 2));
    } else if (command === "inspect") {
      console.log(JSON.stringify(await wallet.inspect(args[0] || ""), null, 2));
    } else if (command === "return") {
      const [id, recipient, value] = args;
      if (!id || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || !recipient || !value) throw new Error("Usage: return <unique-intent-id> <testnet-UA> <zatoshis>");
      const amount = zatoshis(value);
      if (amount <= 0n || amount > 1_000_000n) throw new Error("Spike return must be positive and at most 0.01 testnet ZEC");
      const directory = join(dataDir, "return-intents");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `${id}.json`);
      const intent = { id, recipient, zatoshis: value, state: "outcome-unknown", createdAt: new Date().toISOString() };
      // Exclusive and fsynced before broadcast. Existing intents must be reconciled, never resent.
      const file = await open(path, "wx", 0o600);
      await file.writeFile(JSON.stringify(intent, null, 2)); await file.sync(); await file.close();
      let result;
      try { result = await wallet.sendTestnet(recipient, amount); }
      catch (error) {
        if (error instanceof SidecarRequestError && error.code === "BadRequest") {
          await writeFile(path, JSON.stringify({ ...intent, state: "rejected-before-broadcast", errorCode: error.code }, null, 2), { mode: 0o600 });
        }
        throw error;
      }
      if (typeof result.txid !== "string" || !/^[a-f0-9]{64}$/.test(result.txid)) throw new Error("Unrecognized send result. Reconcile persisted intent before any retry.");
      const temporary = `${path}.tmp`;
      await writeFile(temporary, JSON.stringify({ ...intent, state: "broadcast", result }, null, 2), { mode: 0o600 });
      await rename(temporary, path);
      console.log(JSON.stringify({ state: "broadcast", txid: result.txid, intent: id }));
    }
  } finally { await wallet.close(); }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Zcash spike failed"); process.exitCode = 1; });
