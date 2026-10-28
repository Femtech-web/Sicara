import { authRequest } from "@/features/wallet/server/http";

export const runtime = "nodejs";
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, context: Context) {
  return authRequest(request, (await context.params).action);
}
export async function POST(request: Request, context: Context) {
  return authRequest(request, (await context.params).action);
}
