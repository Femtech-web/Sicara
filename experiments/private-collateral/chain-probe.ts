/** Explicit read-only public testnet observation. No env, wallet, keys or sends. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,open,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';

async function main(){
 const root=resolve(import.meta.dirname,'../..');
 const target=resolve(process.env.SICARA_PRIVACY_TARGET_DIR??join(root,'.local/privacy-native-target'));
 const trustedTest=process.argv.includes('--trusted-test-source');
 const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{
  const {stdout}=await promisify(execFile)('cargo',['run','--offline','--locked','--release','--features','chain-observer','--manifest-path',join(root,'experiments/private-collateral/native/Cargo.toml'),'--target-dir',target,'--','--chain-snapshot',...(trustedTest?['--trusted-test-source']:[])],{cwd:root,signal:controller.signal,timeout:180_000,maxBuffer:500_000,encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,CARGO_HOME:process.env.CARGO_HOME,RAYON_NUM_THREADS:'2',CARGO_BUILD_JOBS:'2'}});
  const report=JSON.parse(stdout);
  if(report.kind!==(trustedTest?'trusted-single-server-test-only':'cross-checked-trusted-rpc')||report.network!=='zcash-testnet'||report.pool!=='ironwood'||report.canonicalConsensusProven!==false||report.readyForFundedTest!==false||report.independentOperators<(trustedTest?1:2))throw new Error('Invalid observer result');
  const folder=join(root,'.local/evidence');await mkdir(folder,{recursive:true,mode:0o700});const destination=join(folder,trustedTest?'testnet-trusted-test-snapshot.json':'testnet-chain-snapshot.json');const temp=`${destination}.${randomUUID()}.tmp`;
  const file=await open(temp,'wx',0o600);try{await file.writeFile(JSON.stringify(report,null,2));await file.sync();}finally{await file.close();}await rename(temp,destination);
  const parent=await open(folder,'r');try{await parent.sync();}finally{await parent.close();}
  console.log(JSON.stringify(report,null,2));
 }finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
void main().catch(()=>{console.error('Testnet snapshot could not be cross-checked. No fallback approval, wallet access or send occurred.');process.exitCode=1;});
