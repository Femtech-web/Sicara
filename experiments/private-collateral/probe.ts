/** Run the isolated crypto experiments. Does not load env files, open wallets or send funds. */
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm,mkdir,open,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes,randomUUID} from 'node:crypto';
import {FixtureCredentialIssuer,FixtureCredentialRedeemer,newIssuerKeys,prepareCredential,finishCredential,signRedemption,FIXTURE_POOL} from './credentials';

const execute=promisify(execFile);
const opaque=()=>randomBytes(32).toString('hex');
async function main(){
 const root=resolve(import.meta.dirname,'../..');
 const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const directory=await mkdtemp(join(tmpdir(),'sicara-privacy-probe-'));
 try{
  console.log('Running real note-encryption, threshold-signature and Halo2 range-proof experiments (offline).');
  const target=resolve(process.env.SICARA_PRIVACY_TARGET_DIR??join(root,'.local/privacy-native-target'));
  // No app secrets or wallet settings are passed to the native child.
  const result=await execute('cargo',['run','--offline','--locked','--release','--manifest-path',join(root,'experiments/private-collateral/native/Cargo.toml'),'--target-dir',target],{
   cwd:root,signal:controller.signal,timeout:180_000,maxBuffer:2_000_000,encoding:'utf8',
   env:{PATH:process.env.PATH,HOME:process.env.HOME,CARGO_HOME:process.env.CARGO_HOME,NODE_ENV:'test',RAYON_NUM_THREADS:'2',CARGO_BUILD_JOBS:'2'},
  });
  const native=JSON.parse(result.stdout.trim());
  if(native.scope!=='offline-real-cryptography-synthetic-note'||native.clientDecrypts!==true||native.privateRangeProofVerified!==true||native.eitherPartySigningAloneRejected!==true||native.independentNoteRangeMismatchDemonstrated!==true||native.endToEndOperatorBlind!==false)throw new Error('Native probe did not produce the expected bounded result');
  console.log('Testing blind credentials with independent synthetic issuances and reordered redemptions.');
  const keys=await newIssuerKeys();const issuerDir=join(directory,'issuer');const redeemerDir=join(directory,'redeemer');
  const issuer=new FixtureCredentialIssuer(keys,issuerDir);
  const clients=await Promise.all([prepareCredential(keys.publicKey),prepareCredential(keys.publicKey),prepareCredential(keys.publicKey)]);
  const credentials=[];
  for(const client of clients)credentials.push(await finishCredential(keys.publicKey,client,await issuer.issue(opaque(),client.blinded)));
  const challenge=opaque();const borrower='0x1111111111111111111111111111111111111111';
  const redeemer=new FixtureCredentialRedeemer(keys.publicKey,FIXTURE_POOL,challenge,redeemerDir);
  const authorization=await signRedemption(credentials[1],clients[1],borrower,FIXTURE_POOL,challenge);
  await redeemer.redeem(credentials[1],authorization);
  let replayRejected=false;
  try{await new FixtureCredentialRedeemer(keys.publicKey,FIXTURE_POOL,challenge,redeemerDir).redeem(credentials[1],authorization);}catch(error){replayRejected=error instanceof Error&&error.message==='Credential already redeemed';}
  if(!replayRejected)throw new Error('Credential replay check failed');
  const report={
   schema:1,scope:'isolated-offline-feasibility',createdAt:new Date().toISOString(),
   native,
   credentials:{library:'@cloudflare/blindrsa-ts@0.4.4',variant:'RSABSSA-SHA384-PSS-Randomized',rsaBits:3072,syntheticIssuances:3,reorderedRedemptionVerified:true,replayAfterJournalReopenRejected:true,realCollateralVerified:false,networkUnlinkabilityProven:false},
   milestones:{tinyRealDepositLocked:false,completeCustodyAmountBlindnessProven:false,privateArithmeticRangeProven:true,realCollateralEligibilityAndNonReuseProven:false,zamaPlaintextBindingProven:false,repaymentGatedPrivateReleaseProven:false,credentialCryptographyExercised:true,endToEndBorrowerUnlinkabilityProven:false},
   blockers:[
    'Canonical Zcash note and actual threshold-controlled lock are not bound to the private arithmetic proof.',
    'The same hidden collateral-derived amount is not proven equal to the plaintext of the Zama encrypted input.',
    'An amount-blind co-signer has no verified proof-gated release/default/recovery policy.',
    'Credential issuance assumes synthetic eligibility; end-to-end association and traffic correlation remain unproven.',
   ],
   readyForFundedTest:false,publicIntakeEnabled:false,newTransactions:0,
  };
  const folder=join(root,'.local/evidence');await mkdir(folder,{recursive:true,mode:0o700});
  const destination=join(folder,'private-collateral-feasibility.json');const temp=`${destination}.${randomUUID()}.tmp`;
  const handle=await open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(report,null,2));await handle.sync();}finally{await handle.close();}await rename(temp,destination);
  const parent=await open(folder,'r');try{await parent.sync();}finally{await parent.close();}
  console.log(JSON.stringify(report,null,2));
  if(process.argv.includes('--require-live'))process.exitCode=2;
 }finally{await rm(directory,{recursive:true,force:true});process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
void main().catch(()=>{console.error('Private collateral probe failed. No live custody changes or transactions were requested. No secrets logged.');process.exitCode=1;});
