import { readFile } from "node:fs/promises";
import type { Sql } from "./types";

/** Caller owns the transaction and privileged migration connection. */
export async function applyMigrations(sql: Sql) {
  await sql.query("SELECT pg_advisory_xact_lock(736422001)");
  await sql.query("CREATE TABLE IF NOT EXISTS public.sicara_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())");
  await sql.query("REVOKE ALL ON public.sicara_migrations FROM PUBLIC");
  await sql.query("ALTER TABLE public.sicara_migrations ENABLE ROW LEVEL SECURITY");
  let changed = false;
  for (const [version, filename] of [[1, "001_wallet_loans.sql"], [2, "002_wallet_worker.sql"], [3, "003_collateral_authorizations.sql"], [4, "004_confirmed_borrow_retries.sql"], [5, "005_settlement_release.sql"]] as const) {
    const applied = await sql.query("SELECT version FROM public.sicara_migrations WHERE version=$1", [version]);
    if (applied.rows.length) continue;
    const migration = await readFile(new URL(`./migrations/${filename}`, import.meta.url), "utf8");
    await sql.query(migration);
    await sql.query("INSERT INTO public.sicara_migrations(version) VALUES($1)", [version]);
    changed = true;
  }
  return changed;
}
