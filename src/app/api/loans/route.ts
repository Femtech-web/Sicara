import { database } from "../../../../services/database/postgres";
import { LoanRepository } from "@/features/lending/server/loan-repository";
import { currentWallet, json } from "@/features/wallet/server/http";

export const runtime = "nodejs";
export async function GET() {
  try {
    const session = await currentWallet();
    if (!session) return json({ error: "Sign in to view your loans." }, 401);
    return json({ loans: await new LoanRepository(database()).list(session.wallet) });
  } catch { return json({ error: "Loan service unavailable. Please try again later." }, 503); }
}
