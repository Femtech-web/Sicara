import { Pool } from "pg";
import { applyMigrations } from "../services/database/migrate";
import { connectionOptions } from "../services/database/connection-options";

async function main() {
  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) throw new Error("Set DATABASE_MIGRATION_URL in root .env.local. See .env.example.");
  const pool = new Pool({ ...connectionOptions(connectionString), max: 1, connectionTimeoutMillis: 10_000 });
  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const applied = await applyMigrations(client);
      await client.query("COMMIT");
    console.log(applied ? "Applied pending Sicara database migrations." : "Database already up to date.");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  } catch {
    console.error("Migration failed and was rolled back. Check your migration connection, TLS certificate and database privileges. Connection details are not logged.");
    process.exitCode = 1;
  } finally { await pool.end(); }

}
void main().catch(() => { console.error("Migration configuration unavailable. Check DATABASE_MIGRATION_URL and the configured CA file in root .env or .env.local."); process.exitCode = 1; });
