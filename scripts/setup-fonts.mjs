import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
// Fontshare allows app self-hosting but not distribution in a public repository.
// Download each developer/deployer's own official copy, without altering the font.
const temporary = await mkdtemp(join(tmpdir(), 'sicara-font-'));
try {
  const response = await fetch('https://api.fontshare.com/v2/fonts/download/satoshi', {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Fontshare download failed (${response.status}).`);
  const archive = join(temporary, 'satoshi.zip');
  await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  const destination = new URL('../src/app/fonts/', import.meta.url);
  await mkdir(destination, { recursive: true });
  for (const [source, target] of [
    ['Satoshi_Complete/Fonts/WEB/fonts/Satoshi-Variable.woff2', 'Satoshi-Variable.woff2'],
    ['Satoshi_Complete/License/FFL.txt', 'Satoshi-LICENSE.txt'],
  ]) {
    const bytes = execFileSync('unzip', ['-p', archive, source]);
    await writeFile(new URL(target, destination), bytes);
  }
  console.log('Satoshi installed from Fontshare. Font binary stays git-ignored.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
