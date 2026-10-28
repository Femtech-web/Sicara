/** Node-only adapter. Never import into a browser bundle or expose as an unauthenticated API. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, chmod, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { createInterface } from "node:readline";
import { object, testnetAddress, integer, parseDeposits, type JsonObject } from "./protocol";
import { zcashUpstream } from "./upstream";

export class OutcomeUnknownError extends Error {
  constructor() { super("Return transaction outcome is unknown. Reconcile the existing intent; do not submit another send."); this.name = "OutcomeUnknownError"; }
}
export class SidecarRequestError extends Error {
  constructor(readonly method: string, readonly code: string) { super(`Zcash ${method} rejected (${code}); inspect local wallet state before retrying.`); this.name = "SidecarRequestError"; }
}

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string };
export interface WalletOptions { binary: string; dataDir: string; server?: string; create?: boolean; startupTimeoutMs?: number; signal?: AbortSignal }

export class TestnetWallet {
  private child: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private ended = false;
  private readyResolve!: (value: JsonObject) => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<JsonObject>;
  private constructor(options: WalletOptions) {
    const args = ["serve", "--network", "test", "--server", options.server ?? zcashUpstream.defaultServer, "--data-dir", options.dataDir, "--untrusted-confirmations", "10"];
    if (options.create) args.push("--create");
    this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
    // Do not inherit application secrets or upstream mainnet/proxy settings.
    this.child = spawn(options.binary, args, { stdio: ["pipe", "pipe", "pipe"], signal: options.signal, env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV, RUST_LOG: "warn" } });
    this.child.stderr.resume();
    this.child.stdin.on("error", () => this.fail(new Error("Zcash input stream failed")));
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        if (line.length > 1_000_000) throw new Error("Oversized sidecar response");
        const message = object(JSON.parse(line));
        if (message.event === "ready") {
          if (message.network !== "test" || message.viewOnly === true) throw new Error("Sidecar is not a spending-capable testnet wallet");
          testnetAddress(message.address); integer(message.tip, "startup tip");
          this.readyResolve(message);
        } else if (message.event === "fatal") { this.fail(new Error("Zcash sidecar failed to initialize")); }
        else if (typeof message.id === "number") {
          const request = this.pending.get(message.id);
          if (!request) return;
          this.pending.delete(message.id); clearTimeout(request.timer);
          if (message.ok === true) request.resolve(message.result);
          else {
            const body = message.error;
            const code = body && typeof body === "object" && "code" in body && typeof body.code === "string" && /^[A-Za-z]{1,40}$/.test(body.code) ? body.code : "Unknown";
            request.reject(new SidecarRequestError(request.method, code));
          }
        }
      } catch { this.fail(new Error("Invalid or incompatible Zcash sidecar response")); this.child.kill("SIGTERM"); }
    });
    this.child.on("error", () => this.fail(new Error("Could not start the configured Zcash sidecar")));
    this.child.on("exit", () => this.fail(new Error("Zcash sidecar exited")));
  }
  static async start(options: WalletOptions) {
    await access(options.binary, constants.X_OK);
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await chmod(options.dataDir, 0o700);
    const wallet = new TestnetWallet(options);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([wallet.ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Zcash startup timed out")), options.startupTimeoutMs ?? 120_000); })]);
      return wallet;
    } catch (error) { await wallet.close(); throw error; }
    finally { clearTimeout(timer); }
  }
  private fail(error: Error) {
    this.ended = true; this.readyReject(error);
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(request.method === "send" ? new OutcomeUnknownError() : error); }
    this.pending.clear();
  }
  private request(method: string, params: JsonObject = {}, timeoutMs = 60_000): Promise<unknown> {
    if (this.ended) return Promise.reject(new Error("Zcash wallet is closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(method === "send" ? new OutcomeUnknownError() : new Error(`Zcash ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (error && this.pending.has(id)) { clearTimeout(timer); this.pending.delete(id); reject(method === "send" ? new OutcomeUnknownError() : new Error("Zcash request write failed")); }
      });
    });
  }
  async address() { return testnetAddress(object(await this.request("address")).address); }
  async newAddress() { return testnetAddress(object(await this.request("newAddress")).address); }
  async info() { return object(await this.request("info")); }
  async ledger() { return object(await this.request("ledger")); }
  async balance() { return object(await this.request("balance")); }
  async deposits(sinceHeight = 0) { integer(sinceHeight, "scan start"); return parseDeposits(await this.request("poll", { sinceHeight })); }
  async sync() { return object(await this.request("sync", {}, 300_000)); }
  async inspect(txid: string) {
    if (!/^[a-f0-9]{64}$/.test(txid)) throw new Error("Invalid transaction id");
    return object(await this.request("inspectTx", { txid }));
  }
  /** Caller must persist an exclusive return intent BEFORE invoking. Never automatically retry. */
  async sendTestnet(to: string, amount: bigint) {
    testnetAddress(to);
    if (amount <= 0n || amount > 1_000_000n) throw new Error("Spike sends are capped at 0.01 testnet ZEC");
    return object(await this.request("send", { outputs: [{ to, zats: amount.toString(), memoHex: "f6" + "00".repeat(511) }] }, 300_000));
  }
  /** Worker-only journalled installment, capped at 0.01 TAZ. Never retry on any error. */
  async sendRefund(to: string, amount: bigint, memoHex: string) {
    testnetAddress(to);
    if (amount <= 0n || amount > 1_000_000n || !/^[a-f0-9]{1024}$/.test(memoHex)) throw new Error("Invalid bounded testnet refund");
    return object(await this.request("send", { outputs: [{ to, zats: amount.toString(), memoHex }] }, 300_000));
  }
  async close() {
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 2000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}
