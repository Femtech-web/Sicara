import { Client } from "pg";
import type { Database } from "./types";
import { connectionOptions } from "./connection-options";

/** Dedicated direct/session-pooler connection: a transaction pooler loses this lock. */
export async function connectWorker(connectionString: string, onDisconnect: () => void = () => {}) {
  if (new URL(connectionString).port === "6543") throw new Error("Worker requires a direct/session connection, not the transaction pooler");
  const client = new Client({ ...connectionOptions(connectionString), connectionTimeoutMillis: 10_000, statement_timeout: 15_000 });
  let disconnected = false;
  client.on("error", () => { disconnected = true; onDisconnect(); });
  try {
    await client.connect();
    await client.query("SET ROLE sicara_worker");
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(736422002) AS locked");
    if (!lock.rows[0].locked) throw new Error("Another collateral worker owns this database");
  } catch (error) { await client.end(); throw error; }
  const database: Database = {
    async query(text, values) {
      if (disconnected) throw new Error("Worker database connection lost");
      return client.query(text, values);
    },
    async transaction(run) {
      if (disconnected) throw new Error("Worker database connection lost");
      await client.query("BEGIN");
      try {
        const result = await run(client);
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
    },
  };
  return { database, close: () => client.end() };
}
