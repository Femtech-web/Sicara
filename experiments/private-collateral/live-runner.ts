/** Local experimental CLI. No env loading, key printing, web API, or implicit broadcasts. */
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';

const stages = ['create', 'audit', 'audit-note', 'scan', 'prepare-return'] as const;
async function main() {
  const [stage, session, scenario, ...extra] = process.argv.slice(2).filter(arg => arg !== '--trusted-test-source');
  if (!process.argv.includes('--trusted-test-source') || !stages.includes(stage as typeof stages[number]) || extra.length) throw new Error('Use create, audit SESSION, audit-note SESSION, scan SESSION SCENARIO, or prepare-return SESSION, with --trusted-test-source');
  if (stage === 'create' ? !!session || !!scenario : !session || !/^[a-f0-9]{32}$/.test(session)) throw new Error('Invalid session');
  if (stage === 'scan' ? !['funding', 'release', 'default', 'recovery'].includes(scenario ?? '') : !!scenario) throw new Error('Invalid scenario');
  const root = resolve(import.meta.dirname, '../..');
  const binary = resolve(root, '.local/privacy-native-target/release/sicara-private-collateral-probe');
  await new Promise<void>((accept, reject) => {
    const child = spawn(binary, ['--live-session', '--trusted-test-source'], {cwd: root, stdio:['pipe','pipe','pipe'], env:{PATH:process.env.PATH,RAYON_NUM_THREADS:'2'}});
    let output = ''; let failed = false;
    const stop = () => { failed = true; child.kill('SIGTERM'); };
    const timer = setTimeout(stop, 130_000);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    child.stderr.resume(); // Native diagnostics must never be forwarded with key material.
    child.stdout.on('data', chunk => {output += chunk.toString(); if(output.length > 20_000) stop();});
    child.stdin.on('error', stop);
    child.once('error', () => {failed = true;});
    child.once('close', code => {
      clearTimeout(timer); process.removeListener('SIGINT',stop); process.removeListener('SIGTERM',stop);
      if(code !== 0 || failed) {reject(new Error('Native stage failed; preserve the session and inspect local state. No automatic retry.')); return;}
      try {
        const report = JSON.parse(output);
        if(report.broadcastEnabled !== false || /fvk|spendingKey|keyPackage|rawTransaction/i.test(output)) throw new Error('Unsafe stage output');
        console.log(JSON.stringify(report, null, 2)); accept();
      } catch {reject(new Error('Invalid native public report'));}
    });
    child.stdin.end(JSON.stringify({action:stage,...(session?{session}:{}),...(scenario?{scenario}:{})}));
  });
}
void main().catch(error => {console.error(error instanceof Error ? error.message : 'Live stage failed'); process.exitCode=1;});
