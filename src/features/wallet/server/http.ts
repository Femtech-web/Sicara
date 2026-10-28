import "server-only";
import { cookies } from "next/headers";
import { database } from "../../../../services/database/postgres";
import { AuthError, WalletAuth } from "./auth";

const SESSION = "sicara_session";
const CHALLENGE = "sicara_challenge";
export function appOrigin() {
  const origin = process.env.SICARA_APP_ORIGIN;
  if (!origin || new URL(origin).origin !== origin || (process.env.NODE_ENV === "production" && !origin.startsWith("https://"))) throw new Error("AUTH_CONFIGURATION_UNAVAILABLE");
  return origin;
}
export function assertSameOrigin(request: Request) {
  if (request.headers.get("origin") !== appOrigin()) throw new AuthError("Open Sicara in its configured browser origin and try again.");
}
export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "Vary": "Cookie", "X-Content-Type-Options": "nosniff" } });
}
export async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new AuthError("Expected a JSON request.");
  // Bound the streamed body too; Content-Length is optional and untrusted.
  const reader = request.body?.getReader();
  if (!reader) throw new AuthError("Missing request.");
  let text = "";
  let length = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) { await reader.cancel(); throw new AuthError("Request too large."); }
      text += decoder.decode(value, { stream: true });
    }
    const value = JSON.parse(text + decoder.decode());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    throw new AuthError("Invalid JSON request.");
  } finally { reader.releaseLock(); }
}
export async function currentWallet() {
  return new WalletAuth(database(), appOrigin()).session((await cookies()).get(SESSION)?.value);
}
export async function authRequest(request: Request, action: string) {
  try {
    if (request.method === "POST") assertSameOrigin(request);
    const auth = new WalletAuth(database(), appOrigin());
    const jar = await cookies();
    const options = { httpOnly: true, secure: appOrigin().startsWith("https://"), sameSite: "strict" as const, path: "/" };
    if (request.method === "GET" && action === "session") {
      const session = await auth.session(jar.get(SESSION)?.value);
      return json({ session: session && { wallet: session.wallet, expiresAt: session.expires_at } });
    }
    if (request.method !== "POST") return json({ error: "Unknown endpoint." }, 404);
    if (action === "logout") {
      await auth.logout(jar.get(SESSION)?.value);
      jar.set(SESSION, "", { ...options, maxAge: 0 });
      jar.set(CHALLENGE, "", { ...options, maxAge: 0, path: "/api/auth" });
      return json({ ok: true });
    }
    const data = await body(request);
    if (action === "challenge") {
      if (typeof data.address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(data.address)) throw new AuthError("Invalid wallet address.");
      const result = await auth.challenge(data.address);
      jar.set(CHALLENGE, result.browserToken, { ...options, expires: result.expiresAt, path: "/api/auth" });
      return json({ id: result.id, message: result.message });
    }
    if (action === "verify") {
      if (typeof data.id !== "string" || typeof data.signature !== "string" || !data.signature.startsWith("0x")) throw new AuthError("Invalid signature request.");
      const session = await auth.verify(data.id, data.signature as `0x${string}`, jar.get(CHALLENGE)?.value ?? "", jar.get(SESSION)?.value);
      jar.set(SESSION, session.token, { ...options, expires: session.expiresAt });
      jar.set(CHALLENGE, "", { ...options, maxAge: 0, path: "/api/auth" });
      return json({ session: { wallet: session.wallet, expiresAt: session.expiresAt } });
    }
    return json({ error: "Unknown endpoint." }, 404);
  } catch (error) {
    return json({ error: error instanceof AuthError ? error.message : "Sign-in service unavailable. Check the server database configuration and migration." }, error instanceof AuthError ? 400 : 503);
  }
}
