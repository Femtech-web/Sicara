/** Offline collateral-lock kit: real v6 Ironwood transactions over a fixture tree. No env, wallet, network or sends. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,open,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';

async function main(){
 const root=resolve(import.meta.dirname,'../..');
 const target=resolve(process.env.SICARA_PRIVACY_TARGET_DIR??join(root,'.local/privacy-native-target'));
 const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  const {stdout}=await promisify(execFile)('cargo',['run','--offline','--locked','--release','--features','lock-kit','--manifest-path',join(root,'experiments/private-collateral/native/Cargo.toml'),'--target-dir',target,'--','--lock-kit'],{cwd:root,signal:controller.signal,timeout:600_000,maxBuffer:500_000,encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,CARGO_HOME:process.env.CARGO_HOME,RAYON_NUM_THREADS:'2',CARGO_BUILD_JOBS:'2'}});
  const report=JSON.parse(stdout);
  const d=report.default,r=report.release;
  const required=[d.proofAndSignaturesVerified,d.finalSequenceRejected,d.unacceptedRootRejected,d.secondDefaultForKeyRejected,d.underpaymentRejected,d.overpaymentRejected,!d.finalAtMaturity,d.finalAfterMaturity,!d.cosignerSawPlaintext,r.proofAndSignaturesVerified,r.unpaidRejected,r.afterCutoffRejected,r.otherNoteRejected,r.expiryBeyondMaturityRejected,r.duplicateRejected,r.spendsLockedNoteSoDefaultBecomesInvalid,!r.cosignerSawPlaintext,!r.lenderCanDecryptRelease,report.custody.singleSignersRejected];
  const durable=report.durability;
  if(report.scope!=='real-v6-ironwood-transactions-over-fixture-tree'||!required.every(v=>v===true)||report.broadcast!==false||report.readyForFundedTest!==false||!durable||![durable.defaultReservedBeforeSigning,durable.releaseReservedBeforeSigning,durable.reopenPreservesDefault,durable.reusedLenderInputRejected,durable.restartDuplicateReleaseRejected].every(v=>v===true)||durable.liveSettlementVerified!==false)throw new Error('Lock kit did not produce the expected bounded result');
  const folder=join(root,'.local/evidence');await mkdir(folder,{recursive:true,mode:0o700});const destination=join(folder,'collateral-lock-kit.json');const temp=`${destination}.${randomUUID()}.tmp`;
  const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(report,null,2));await file.sync();}finally{await file.close();}await rename(temp,destination);
  const parent=await open(folder,'r');try{await parent.sync();}finally{await parent.close();}
  console.log(JSON.stringify(report,null,2));
  if(process.argv.includes('--require-live'))process.exitCode=2;
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
void main().catch(()=>{console.error('Offline lock kit failed. No wallet access, broadcast or funds were involved.');process.exitCode=1;});
