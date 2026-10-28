import { execFileSync } from "node:child_process";
import { mkdir, copyFile, chmod, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const commit = "0767b30f645be6e7083c1f4e3cb01c19728f1ef9";
const source = resolve(process.env.SICARA_ZCASH_SOURCE || ".local/zcash/upstream");
if (!existsSync(source)) {
  execFileSync("git", ["clone", "--no-checkout", "https://github.com/mrnetwork0001/Silicr.git", source], { stdio: "inherit" });
  execFileSync("git", ["-C", source, "checkout", "--detach", commit], { stdio: "inherit" });
}
const actual = execFileSync("git", ["-C", source, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (actual !== commit) throw new Error(`Expected upstream commit ${commit}. Check out this exact commit before building.`);
if (execFileSync("git", ["-C", source, "status", "--porcelain"], { encoding: "utf8" }).trim()) throw new Error("Refusing modified upstream checkout");
execFileSync("cargo", ["build", "--locked", "--release"], { cwd: join(source, "zec-sidecar"), stdio: "inherit" });
const destination = resolve(".local/zcash/bin");
await mkdir(destination, { recursive: true, mode: 0o700 });
await copyFile(join(source, "zec-sidecar/target/release/zec-sidecar"), join(destination, "zec-sidecar"));
await chmod(join(destination, "zec-sidecar"), 0o700);
await copyFile(join(source, "LICENSE-MIT"), join(destination, "LICENSE-Silicr-MIT"));
await writeFile(join(destination, "upstream.json"), JSON.stringify({ repository: "https://github.com/mrnetwork0001/Silicr", commit, modified: false }, null, 2));
console.log("Pinned testnet sidecar prepared. No wallet seeds or funds were created.");
