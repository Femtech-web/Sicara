import type { DepositSnapshot } from "./protocol";
import { integer, object, testnetAddress, zatoshis } from "./protocol";
import { TestnetWallet } from "./sidecar-client";
import { validateShieldedReturn } from "./address-validator";

export const REFUND_CHUNK_ZATOSHIS = 1_000_000n;
export function refundMemo(id: string) {
  return returnMemo(id,'refund');
}
export function returnMemo(id:string,kind:'refund'|'release') {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid refund identity");
  const memo = Buffer.alloc(512);
  memo.write(`Sicara testnet ${kind} ${id}`, "utf8");
  return memo.toString("hex");
}
export type SentPayment = { txid: string; height: number; destination: string; amount: bigint; memo: string };
export interface WorkerWallet {
  address(): Promise<string>;
  validate(address: string): Promise<string>;
  newAddress(): Promise<string>;
  scan(): Promise<DepositSnapshot>;
  sent(): Promise<{ tip: number; payments: SentPayment[] }>;
  spendable(): Promise<bigint>;
  inspectShielded(txid: string): Promise<boolean>;
  sendRefund(destination: string, amount: bigint, operationId: string): Promise<string>;
  sendRelease(destination: string, amount: bigint, operationId: string): Promise<string>;
}

export class SidecarWorkerWallet implements WorkerWallet {
  constructor(private wallet: TestnetWallet, private validator: string) {}
  address() { return this.wallet.address(); }
  validate(address: string) { return validateShieldedReturn(this.validator, address); }
  newAddress() { return this.wallet.newAddress(); }
  async scan() {
    const sync = await this.wallet.sync();
    if (sync.fullyScanned !== sync.tip) throw new Error("Wallet is not fully scanned to the current tip");
    const snapshot = await this.wallet.deposits(0);
    const info = await this.wallet.info();
    if (snapshot.stale || info.network !== "test" || info.syncError !== null || typeof info.lastSyncMsAgo !== 'number' || info.lastSyncMsAgo > 30_000 || info.tip !== snapshot.tip) throw new Error("Wallet scan is stale or changed during observation");
    return snapshot;
  }
  async sent() {
    const ledger = await this.wallet.ledger();
    if (!Array.isArray(ledger.entries)) throw new Error("Invalid wallet ledger");
    const payments: SentPayment[] = [];
    for (const value of ledger.entries) {
      const entry = object(value);
      if (entry.direction !== "sent") continue;
      if (entry.valuePool !== "ironwood" || typeof entry.txid !== 'string' || !/^[a-f0-9]{64}$/.test(entry.txid) || typeof entry.memoHex !== 'string' || !/^[a-f0-9]{1024}$/.test(entry.memoHex)) throw new Error("Unsupported outgoing wallet ledger entry");
      payments.push({ txid: entry.txid, height: integer(entry.height, "outgoing height"), destination: testnetAddress(entry.address), amount: zatoshis(entry.zats), memo: entry.memoHex });
    }
    return { tip: integer(ledger.tip, "ledger tip"), payments };
  }
  async spendable() { return zatoshis((await this.wallet.balance()).spendable); }
  async inspectShielded(txid: string) {
    const tx = await this.wallet.inspect(txid);
    const t = object(tx.transparent), s = object(tx.sapling), o = object(tx.orchard), i = object(tx.ironwood);
    return tx.complete === true && t.inputs === 0 && t.outputs === 0 && s.spends === 0 && s.outputs === 0 && o.actions === 0 && typeof i.actions === 'number' && i.actions > 0;
  }
  async sendRefund(destination: string, amount: bigint, id: string) {
    return this.send(destination,amount,returnMemo(id,'refund'));
  }
  async sendRelease(destination:string,amount:bigint,id:string) {
    return this.send(destination,amount,returnMemo(id,'release'));
  }
  private async send(destination:string,amount:bigint,memo:string) {
    const result = await this.wallet.sendRefund(destination, amount, memo);
    if (typeof result.txid !== 'string' || !/^[a-f0-9]{64}$/.test(result.txid)) throw new Error("Invalid refund result; reconcile before retrying");
    return result.txid;
  }
}
