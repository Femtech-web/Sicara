import "server-only";
import { Pool } from "pg";
import type { Database } from "./types";
import { connectionOptions } from "./connection-options";

const globalDatabase = globalThis as typeof globalThis & { sicaraPool?: Pool };

export function database(): Database {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_UNAVAILABLE");
  const pool = globalDatabase.sicaraPool ??= new Pool({
    ...connectionOptions(process.env.DATABASE_URL),
    max: 3,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  const db: Database = {
    query: (text, values) => db.transaction(sql => sql.query(text, values)),
    async transaction(run) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE sicara_backend");
        const result = await run(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
  };
  return db;
}
