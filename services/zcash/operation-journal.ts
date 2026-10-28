import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type Operation = {
  version: 1;
  binding: Record<string, string>;
  state: "prepared" | "allocating" | "allocated" | "submitting" | "broadcast";
  address?: string;
  txid?: string;
};

/** Local write-ahead journal. Keep it with the backed-up wallet, not on ephemeral web storage.
 * The worker must hold the wallet OS lock and database worker lock before calling this class.
 */
export class OperationJournal {
  constructor(readonly directory: string) {}
  private path(key: string) {
    if (!/^(manifest|(allocation|refund|issuance|release)-[a-f0-9-]{36})$/.test(key)) throw new Error("Invalid operation journal key");
    return join(this.directory, key + ".json");
  }
  async get(key: string): Promise<Operation | null> {
    try {
      const parsed: Operation = JSON.parse(await readFile(this.path(key), "utf8"));
      if (parsed.version !== 1 || !parsed.binding || typeof parsed.binding !== 'object' || !['prepared','allocating','allocated','submitting','broadcast'].includes(parsed.state)) throw new Error("Corrupt wallet operation journal");
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async bind(key: string, binding: Record<string, string>) {
    const existing = await this.get(key);
    if (existing) {
      if (JSON.stringify(existing.binding) !== JSON.stringify(binding)) throw new Error("Wallet journal binding mismatch; reconciliation required");
      return existing;
    }
    const operation: Operation = { version: 1, binding, state: "prepared" };
    await this.save(key, operation);
    return operation;
  }
  async keys() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    return (await readdir(this.directory)).filter(name => /^(allocation|refund|issuance|release)-[a-f0-9-]{36}\.json$/.test(name)).map(name => name.slice(0, -5));
  }
  async save(key: string, operation: Operation) {
    const path = this.path(key);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(operation)); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const directory = await open(this.directory, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
