import { createHash, randomBytes, randomUUID } from "node:crypto";
import { getAddress, verifyMessage, type Hex } from "viem";
import { createSiweMessage, parseSiweMessage } from "viem/siwe";
import type { Database } from "../../../../services/database/types";

export class AuthError extends Error {}
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const secret = () => randomBytes(32).toString("hex");
export function walletAddress(address: string) { return getAddress(address).toLowerCase(); }
export const validToken = (token: string | undefined): token is string => !!token && /^[a-f0-9]{64}$/.test(token);

export class WalletAuth {
  constructor(private db: Database, private origin: string) {
    if (new URL(origin).origin !== origin) throw new Error("Expected canonical application origin");
  }

  async challenge(address: string) {
    const wallet = walletAddress(address);
    const id = randomUUID();
    const browserToken = secret();
    // Short transactions; no signature verification or external calls while holding locks.
    return this.db.transaction(async sql => {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [wallet]);
      const recent = await sql.query<{ count: string }>("SELECT count(*)::text AS count FROM sicara.auth_challenges WHERE wallet=$1 AND created_at > clock_timestamp() - interval '1 minute'", [wallet]);
      if (Number(recent.rows[0].count) >= 5) throw new AuthError("Too many sign-in attempts. Wait a minute and try again.");
      const clock = await sql.query<{ now: Date }>("SELECT clock_timestamp() AS now");
      const issuedAt = new Date(clock.rows[0].now);
      const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
      const message = createSiweMessage({
        address: getAddress(wallet), chainId: 11155111, domain: new URL(this.origin).host,
        uri: this.origin, version: "1", nonce: secret(), issuedAt, expirationTime: expiresAt,
        statement: "Sign in to Sicara. This does not authorize a transaction or transfer funds.",
      });
      await sql.query("INSERT INTO sicara.auth_challenges(id,wallet,browser_hash,message,expires_at) VALUES($1,$2,$3,$4,$5)", [id, wallet, hashToken(browserToken), message, expiresAt]);
      return { id, message, browserToken, expiresAt };
    });
  }

  async verify(id: string, signature: Hex, browserToken: string, oldSession?: string) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !validToken(browserToken) || !/^0x[a-fA-F0-9]{130}$/.test(signature)) throw new AuthError("Invalid sign-in request.");
    const found = await this.db.query<{ wallet: Hex; message: string }>("SELECT wallet,message FROM sicara.auth_challenges WHERE id=$1 AND browser_hash=$2 AND consumed_at IS NULL AND expires_at > clock_timestamp()", [id, hashToken(browserToken)]);
    const challenge = found.rows[0];
    // EOA personal_sign only for this milestone; never claim contract-wallet support.
    if (!challenge) throw new AuthError("Sign-in expired or signature invalid. Please try again.");
    const parsed = parseSiweMessage(challenge.message);
    if (parsed.domain !== new URL(this.origin).host || parsed.uri !== this.origin || parsed.chainId !== 11155111 || parsed.address?.toLowerCase() !== challenge.wallet) throw new AuthError("Sign-in domain or wallet mismatch.");
    let valid = false;
    try { valid = await verifyMessage({ address: challenge.wallet, message: challenge.message, signature }); } catch { /* Invalid signatures fail closed. */ }
    if (!valid) throw new AuthError("Sign-in expired or signature invalid. Please try again.");
    const token = secret();
    return this.db.transaction(async sql => {
      const consumed = await sql.query("UPDATE sicara.auth_challenges SET consumed_at=clock_timestamp() WHERE id=$1 AND browser_hash=$2 AND consumed_at IS NULL AND expires_at > clock_timestamp() RETURNING id", [id, hashToken(browserToken)]);
      if (!consumed.rows.length) throw new AuthError("This sign-in request has already been used or expired.");
      if (validToken(oldSession)) await sql.query("DELETE FROM sicara.sessions WHERE token_hash=$1", [hashToken(oldSession)]);
      const session = await sql.query<{ expires_at: Date }>("INSERT INTO sicara.sessions(token_hash,wallet,expires_at) VALUES($1,$2,clock_timestamp()+interval '8 hours') RETURNING expires_at", [hashToken(token), challenge.wallet]);
      return { token, wallet: challenge.wallet, expiresAt: new Date(session.rows[0].expires_at) };
    });
  }

  async session(token?: string) {
    if (!validToken(token)) return null;
    const result = await this.db.query<{ wallet: string; expires_at: Date }>("SELECT wallet,expires_at FROM sicara.sessions WHERE token_hash=$1 AND expires_at > clock_timestamp()", [hashToken(token)]);
    return result.rows[0] ?? null;
  }
  async logout(token?: string) {
    if (validToken(token)) await this.db.query("DELETE FROM sicara.sessions WHERE token_hash=$1", [hashToken(token)]);
  }
}
