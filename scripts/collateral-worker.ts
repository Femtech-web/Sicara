import { resolve, join } from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { connectWorker } from "../services/database/worker-connection";
import { TestnetWallet } from "../services/zcash/sidecar-client";
import { SidecarWorkerWallet } from "../services/zcash/worker-wallet";
import { OperationJournal } from "../services/zcash/operation-journal";
import { CollateralWorker } from "../services/zcash/collateral-worker";
import { zatoshis } from "../services/zcash/protocol";
import {ReleaseWorker} from '../services/settlement/release-worker';
import {SepoliaSettlementVerifier} from '../services/settlement/sepolia-settlement';

function pause(signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) return resolve();
    const end = () => { clearTimeout(timer); signal.removeEventListener("abort", end); resolve(); };
    const timer = setTimeout(end, 15_000);
    signal.addEventListener("abort", end, { once: true });
  });
}
async function main() {
  const connection = process.env.DATABASE_WORKER_URL;
  if (!connection) throw new Error("Set DATABASE_WORKER_URL using the direct/session pooler URL, then run pnpm db:migrate.");
  const validator = resolve(process.env.SICARA_ADDRESS_VALIDATOR ?? ".local/zcash/native-target/release/sicara-address-check");
  const binary = resolve(process.env.SICARA_ZCASH_BINARY ?? ".local/zcash/bin/zec-sidecar");
  const dataDir = resolve(process.env.SICARA_ZCASH_WALLET_DIR ?? ".local/zcash/wallet");
  const feeReserve = zatoshis(process.env.SICARA_OPERATOR_RESERVE_ZATS ?? "1000000");
  await access(validator, constants.X_OK);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let wallet: TestnetWallet | undefined;
  let database: Awaited<ReturnType<typeof connectWorker>> | undefined;
  try {
    database = await connectWorker(connection, stop);
    // Do not create a new wallet by accident. The existing custody seed stays on this host.
    wallet = await TestnetWallet.start({ binary, dataDir, signal: controller.signal });
    const gateway=new SidecarWorkerWallet(wallet,validator);
    const journal=new OperationJournal(join(dataDir,'sicara-operations'));
    const releases=new ReleaseWorker(database.database,gateway,journal,new SepoliaSettlementVerifier(process.env.SICARA_SEPOLIA_RPC_URL??'https://ethereum-sepolia-rpc.publicnode.com'),feeReserve);
    const worker = new CollateralWorker(database.database,gateway,journal,feeReserve,snapshot=>releases.tick(snapshot));
    await worker.initialize();
    while (!controller.signal.aborted) {
      const result = await worker.tick();
      console.log(JSON.stringify({ event: "collateral-worker-tick", ...result }));
      if (process.argv.includes("--once")) break;
      await pause(controller.signal);
    }
  } finally {
    await wallet?.close();
    await database?.close(); // Connection close releases the session advisory lock.
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
void main().catch(() => {
  console.error("Collateral worker stopped. Check database migration/session URL, native validator and protected wallet. Resolve pending operations from the journal/ledger; never retry a send manually. No credentials or wallet data were logged.");
  process.exitCode = 1;
});
