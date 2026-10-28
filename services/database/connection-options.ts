import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Certificate-verified TLS, including for dashboard URLs without sslmode parameters. */
export function connectionOptions(connectionString: string) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error("Invalid PostgreSQL URL");
  const mode = url.searchParams.get("sslmode");
  if (mode === 'disable' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return { connectionString };
  if (mode && !['verify-full', 'require'].includes(mode)) throw new Error("Use verified TLS for remote database connections");
  if (url.searchParams.has('sslcert') || url.searchParams.has('sslkey')) throw new Error("Client certificate authentication is not configured");
  const fallback = resolve(".local/supabase-ca.crt");
  const isSupabase = url.hostname.endsWith('.supabase.com') || url.hostname.endsWith('.supabase.co');
  const certificate = url.searchParams.get('sslrootcert') || process.env.DATABASE_SSL_CA_FILE || (isSupabase && existsSync(fallback) ? fallback : undefined);
  // Serverless hosts do not have this Mac's private .local certificate path.
  // Accept the public CA certificate directly as a server-only PEM environment
  // variable. Explicit file configuration still takes precedence and fails if absent.
  const certificatePem = process.env.DATABASE_SSL_CA?.replace(/\\n/g, '\n').trim();
  if (certificatePem && (!certificatePem.startsWith('-----BEGIN CERTIFICATE-----') || !certificatePem.endsWith('-----END CERTIFICATE-----') || certificatePem.includes('PRIVATE KEY'))) throw new Error('DATABASE_SSL_CA must contain a public PEM certificate');
  // pg otherwise lets URL SSL options overwrite the explicitly verified SSL object.
  for (const key of ['ssl', 'sslmode', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
  return {
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true, ...(certificate ? { ca: readFileSync(resolve(certificate), 'utf8') } : certificatePem ? { ca: certificatePem } : {}) },
  };
}
