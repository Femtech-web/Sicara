/** Exercise upstream note constraints and offline one-use admission. No application env or wallet access. */
import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, open, rename, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FixtureNoteClaimGate, noteProof, type NoteProof, type FixtureSnapshot} from './note-claims';

const execute = promisify(execFile);
async function main() {
  const root = resolve(import.meta.dirname,'../..');
  const target = resolve(process.env.SICARA_PRIVACY_TARGET_DIR ?? join(root,'.local/privacy-native-target'));
  const binary = join(target,'release/sicara-private-collateral-probe');
  const env = {PATH:process.env.PATH,HOME:process.env.HOME,CARGO_HOME:process.env.CARGO_HOME,NODE_ENV:'test',RAYON_NUM_THREADS:'2',CARGO_BUILD_JOBS:'2'};
  const controller = new AbortController(); const stop = () => controller.abort();
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  const directory = await mkdtemp(join(tmpdir(),'sicara-note-claims-'));
  try {
    console.log('Checking upstream note constraints and one-use fixture admission offline (two proving threads).');
    const start = performance.now();
    const {stdout} = await execute('cargo',['run','--offline','--locked','--release','--manifest-path',join(root,'experiments/private-collateral/native/Cargo.toml'),'--target-dir',target,'--','--note-eligibility','--export-fixture'],{cwd:root,env,signal:controller.signal,timeout:180_000,maxBuffer:1_000_000,encoding:'utf8'});
    const native = JSON.parse(stdout);
    assert.equal(native.scope,'upstream-note-relation-synthetic-root'); assert.equal(native.proofVerified,true); assert.equal(native.loanLockEnforced,false);
    const fixture = noteProof(native.fixture); const reblinded = noteProof(native.reblindedFixture);
    delete native.fixture; delete native.reblindedFixture;
    const verify = async (proof: NoteProof) => {
      const result = spawnSync(binary,['--verify-note-eligibility'],{env,input:JSON.stringify(proof),encoding:'utf8',timeout:30_000,maxBuffer:4000});
      assert.equal(result.status,0,'Fixed native note verifier rejected proof');
      const checked = JSON.parse(result.stdout);
      assert.equal(checked.circuitId,proof.circuitId); assert.equal(checked.relationVerified,true); assert.equal(checked.loanLockEnforced,false);
    };
    await verify(fixture); await verify(reblinded);
    const now = Date.now();
    const snapshot:FixtureSnapshot = {kind:'synthetic-snapshot',network:'zcash-testnet',pool:'ironwood',root:fixture.publicInputs[0],approvedKeyX:fixture.publicInputs[1],approvedKeyY:fixture.publicInputs[2],height:1000,tipHeight:1009,observedAt:now};
    const gate = new FixtureNoteClaimGate(snapshot,join(directory,'claims'),verify);
    const laterSnapshot:FixtureSnapshot = {...snapshot,root:reblinded.publicInputs[0],height:1001,tipHeight:1010};
    const laterGate = new FixtureNoteClaimGate(laterSnapshot,join(directory,'claims'),verify);
    const wrong = {circuitId:fixture.circuitId,proof:fixture.proof,publicInputs:[...fixture.publicInputs]};
    wrong.publicInputs[6] = '00'.repeat(32); // changed commitment, valid envelope, same policy
    await assert.rejects(gate.reserve(wrong,fixture.publicInputs[7],9_999n,now));
    await assert.rejects(gate.reserve(fixture,reblinded.publicInputs[7],9_999n,now));
    await assert.rejects(gate.reserve(fixture,fixture.publicInputs[7],9_998n,now));
    for (const change of [{root:'00'.repeat(32)},{approvedKeyX:'00'.repeat(32)},{tipHeight:1008},{observedAt:now-60_001},{observedAt:now+1},{pool:'orchard'},{network:'zcash-mainnet'}]) {
      const bad = new FixtureNoteClaimGate({...snapshot,...change} as FixtureSnapshot,join(directory,'claims'),verify);
      await assert.rejects(bad.reserve(fixture,fixture.publicInputs[7],9_999n,now));
    }
    // Different valid proofs, different salt/context, SAME canonical claim.
    assert.equal(fixture.publicInputs[5],reblinded.publicInputs[5]);
    assert.notEqual(fixture.publicInputs[6],reblinded.publicInputs[6]);
    assert.notEqual(fixture.publicInputs[0],reblinded.publicInputs[0]);
    const results = await Promise.allSettled([
      gate.reserve(fixture,fixture.publicInputs[7],9_999n,now),
      laterGate.reserve(reblinded,reblinded.publicInputs[7],9_999n,now),
    ]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const loser = results.find(r=>r.status==='rejected'); assert.ok(loser && loser.status==='rejected');
    assert.equal(loser.reason.message,'Note claim already reserved');
    const reopened = new FixtureNoteClaimGate(snapshot,join(directory,'claims'),verify);
    await assert.rejects(reopened.reserve(fixture,fixture.publicInputs[7],9_999n,now),/already reserved/);
    await assert.rejects(new FixtureNoteClaimGate(laterSnapshot,join(directory,'claims'),verify).reserve(reblinded,reblinded.publicInputs[7],9_999n,now),/already reserved/);
    const report = {scope:'isolated-note-membership-and-claim-fixture',native,independentFixedVerifier:true,pinnedSnapshotPolicyChecked:true,syntheticSnapshotOnly:true,invalidProofRejected:true,unconfirmedStaleWrongPoolAndKeyRejected:true,concurrentReblindedReplayRejected:true,replayAcrossDifferentRootsRejected:true,reopenedJournalReplayRejected:true,localDurableClaimConsumption:true,elapsedMs:Math.round(performance.now()-start),readyForFundedTest:false,loanLockEnforced:false,newTransactions:0};
    const folder = join(root,'.local/evidence'); await mkdir(folder,{recursive:true,mode:0o700});
    const dest = join(folder,'note-eligibility-feasibility.json'); const temp = `${dest}.${randomUUID()}.tmp`;
    const file = await open(temp,'wx',0o600);try {await file.writeFile(JSON.stringify(report,null,2));await file.sync();} finally {await file.close();}
    await rename(temp,dest);const parent=await open(folder,'r');try {await parent.sync();}finally {await parent.close();}
    console.log(JSON.stringify(report,null,2));
    if(process.argv.includes('--require-live')) process.exitCode=2;
  } finally {await rm(directory,{recursive:true,force:true});process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
void main().catch(()=>{console.error('Offline note proof check failed. No live funds or wallet access; private details omitted.');process.exitCode=1;});
