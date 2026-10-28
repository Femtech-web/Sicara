export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid sidecar object");
  return value as JsonObject;
}
export function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}
export function zatoshis(value: unknown): bigint {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Expected non-negative decimal-string zatoshis");
  const amount = BigInt(value);
  if (amount > 2_100_000_000_000_000n) throw new Error("Amount exceeds Zcash money range");
  return amount;
}
export function testnetAddress(value: unknown): string {
  // Preliminary format guard only. The Rust library validates the UA checksum and Orchard receiver at send time.
  if (typeof value !== "string" || !/^utest1[023456789acdefghjklmnpqrstuvwxyz]{50,500}$/.test(value)) throw new Error("Expected a shielded Zcash testnet unified address");
  return value;
}
export interface DepositNote { txid: string; index: number; height: number | null; address: string; zatoshis: bigint; valuePool: "ironwood"; source: "wallet" | "mempool" }
export interface DepositSnapshot { tip: number; stale: boolean; notes: DepositNote[] }
export function parseDeposits(value: unknown): DepositSnapshot {
  const result = object(value);
  if (!Array.isArray(result.notes) || typeof result.stale !== "boolean") throw new Error("Invalid deposit snapshot");
  const tip = integer(result.tip, "chain tip");
  const notes = result.notes.map((entry): DepositNote => {
    const note = object(entry);
    if (typeof note.txid !== "string" || !/^[a-f0-9]{64}$/.test(note.txid)) throw new Error("Invalid txid");
    if (note.valuePool !== "ironwood" || (note.source !== "wallet" && note.source !== "mempool")) throw new Error("Unsupported pool or note source");
    return { txid: note.txid, index: integer(note.index, "note index"), height: note.height === null ? null : integer(note.height, "note height"), address: testnetAddress(note.toAddress), zatoshis: zatoshis(note.zats), valuePool: note.valuePool, source: note.source };
  });
  return { tip, stale: result.stale, notes };
}

/** Read-only candidate assessment, not an authorization to issue a loan. Rejects stale scans. */
export function assessDeposit(snapshot: DepositSnapshot, address: string, required: bigint, minConfirmations = 10) {
  testnetAddress(address);
  if (required <= 0n || !Number.isSafeInteger(minConfirmations) || minConfirmations < 1) throw new Error("Invalid deposit policy");
  if (snapshot.stale) return { status: "stale" as const, confirmed: 0n, pending: 0n, noteIds: [] as string[] };
  const seen = new Set<string>();
  let confirmed = 0n;
  let pending = 0n;
  const noteIds: string[] = [];
  for (const note of snapshot.notes) {
    if (note.address !== address) continue;
    const identity = `${note.txid}:${note.valuePool}:${note.index}`;
    if (seen.has(identity)) throw new Error("Duplicate note in wallet snapshot");
    seen.add(identity);
    const confirmations = note.height !== null && note.height <= snapshot.tip ? snapshot.tip - note.height + 1 : 0;
    if (note.source === "wallet" && note.height !== null && confirmations >= minConfirmations) {
      confirmed += note.zatoshis; noteIds.push(identity);
    } else { pending += note.zatoshis; }
  }
  return { status: confirmed >= required ? "confirmed" as const : confirmed + pending >= required ? "confirming" as const : "awaiting-deposit" as const, confirmed, pending, noteIds };
}
