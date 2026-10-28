import { execFile } from "node:child_process";
import { testnetAddress } from "./protocol";

/** Native checksum/network/receiver check; the child receives no wallet or application secrets. */
export async function validateShieldedReturn(binary: string, input: string): Promise<string> {
  testnetAddress(input);
  return new Promise((resolve, reject) => {
    const child = execFile(binary, [], {
      timeout: 5_000, maxBuffer: 2048, encoding: "utf8", env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV },
    }, (error, stdout) => {
      if (error) { reject(new Error("Shielded testnet address validation failed.")); return; }
      try { resolve(testnetAddress(stdout.trim())); }
      catch { reject(new Error("Invalid native address validator response.")); }
    });
    child.stdin?.on("error", () => { /* execFile callback reports child failure. */ });
    child.stdin?.end(input + "\n");
  });
}
