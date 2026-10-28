/** One owner-authorized funding transfer ONLY; never opens threshold custody shares. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile,open,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {TestnetWallet} from '../../services/zcash/sidecar-client';
import {OperationJournal} from '../../services/zcash/operation-journal';
import {refundMemo} from '../../services/zcash/worker-wallet';

async function immutable(file:string, value:unknown) {
  const data=JSON.stringify(value,null,2);
  let handle;
  try {handle=await open(file,'wx',0o600);} catch(error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    if(await readFile(file,'utf8')!==data)throw new Error('Conflicting immutable funding authorization');
    return;
  }
  try {await handle.writeFile(data);await handle.sync();} finally {await handle.close();}
  const parent=await open(resolve(file,'..'),'r');try{await parent.sync();}finally{await parent.close();}
}
let checkpoint='arguments';
async function main() {
  const [session,mode,...extra]=process.argv.slice(2);
  if(!session||!/^[a-f0-9]{32}$/.test(session)||!['--check','--send'].includes(mode)||extra.length)throw new Error('Use SESSION --check or SESSION --send');
  const root=resolve(import.meta.dirname,'../..');const directory=join(root,'.local/isolated-live',session);
  const native=join(root,'.local/privacy-native-target/release/sicara-private-collateral-probe');
  checkpoint='native-key-audit';
  const audit=JSON.parse(execFileSync(native,['--live-session','--trusted-test-source'],{cwd:root,input:JSON.stringify({action:'audit',session}),encoding:'utf8',timeout:15_000,stdio:['pipe','pipe','ignore'],env:{PATH:process.env.PATH,RAYON_NUM_THREADS:'2'}}));
  if(audit.state!=='local-key-audit-passed'||audit.session!==session)throw new Error('Session key audit required');
  checkpoint='bounded-funder-checksum';
  const build=JSON.parse(await readFile(join(root,'.local/zcash/isolated-funder-build.json'),'utf8'));
  const binary=join(root,'.local/privacy-native-target/release/zec-sidecar');
  const digest=createHash('sha256').update(await readFile(binary)).digest('hex');
  const patchDigest=createHash('sha256').update(await readFile(join(root,'services/zcash/patches/isolated-funding-budget.patch'))).digest('hex');
  if(build.binarySha256!==digest||build.patchSha256!==patchDigest||build.maximumDebitZats!==1_000_000||build.commit!=='0767b30f645be6e7083c1f4e3cb01c19728f1ef9')throw new Error('Pinned debit-limited funder build required');
  const receiver=JSON.parse(await readFile(join(directory,'public/funding.json'),'utf8')).address;
  if(typeof receiver!=='string'||!receiver.startsWith('utest1'))throw new Error('Invalid fresh receiver');
  const journal=new OperationJournal(join(root,'.local/isolated-live/funding-journal'));
  await mkdir(join(directory,'public'),{recursive:true,mode:0o700});
  const amount='900000';const memoId='bd1a70e6-1569-4d48-a81c-277ae48f38b9';const memo=refundMemo(memoId);
  let wallet:TestnetWallet|undefined;
  const controller=new AbortController();const stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    checkpoint='test-wallet-startup';
    wallet=await TestnetWallet.start({binary,dataDir:join(root,'.local/zcash/wallet'),startupTimeoutMs:120_000,signal:controller.signal});
    const returnAddress=await wallet.address();
    if(returnAddress===receiver)throw new Error('Fresh funding wallet must differ from old wallet');
    checkpoint='test-wallet-balance';
    const balance=await wallet.balance();
    const authorization={version:1,session,network:'zcash-testnet',returnAddress,fundingAddress:receiver,amountZats:amount,maximumDebitZats:1_000_000,maximumFeeZats:100_000,oldWalletUsedForFundingOnly:true};
    if(mode==='--check') {
      console.log(JSON.stringify({session,state:'funding-preflight-passed',sufficientSpendable:BigInt(String(balance.spendable))>=1_000_000n,maximumDebitZats:1_000_000,amountZats:amount,maximumFeeZats:100_000,broadcast:false}));return;
    }
    // Global binding: the same grant cannot fund another session, even after restart.
    checkpoint='funding-reservation';
    let intent=await journal.bind('refund-bd1a70e6-1569-4d48-a81c-277ae48f38b9',{kind:'isolated-test-funding',loan:session,to:receiver,amount});
    await immutable(join(directory,'public/funding-authorization.json'),authorization);
    if(intent.state==='prepared') {
      if(balance.synced!==true||BigInt(String(balance.spendable))<1_000_000n)throw new Error('Current spendable fee reserve required');
      intent={...intent,state:'submitting'};await journal.save('refund-bd1a70e6-1569-4d48-a81c-277ae48f38b9',intent);
      // Dedicated patched sidecar rejects amount + selected ZIP317 fee > 0.01 TAZ
      // BEFORE deriving spending keys, proving, signing or broadcasting.
      checkpoint='bounded-funding-send';
      const result=await wallet.sendRefund(receiver,BigInt(amount),memo);
      if(typeof result.txid!=='string'||!/^[a-f0-9]{64}$/.test(result.txid)||typeof result.feeZats!=='string'||BigInt(result.feeZats)>100_000n)throw new Error('Funding outcome needs reconciliation');
      intent={...intent,state:'broadcast',txid:result.txid};await journal.save('refund-bd1a70e6-1569-4d48-a81c-277ae48f38b9',intent);
      await immutable(join(directory,'public/funding-receipt.json'),{session,txid:result.txid,amountZats:amount,feeZats:result.feeZats,totalDebitZats:(BigInt(amount)+BigInt(result.feeZats)).toString()});
    }
    let hasReceipt=false;
    try {const receipt=JSON.parse(await readFile(join(directory,'public/funding-receipt.json'),'utf8'));if(receipt.session!==session||receipt.txid!==intent.txid||receipt.amountZats!==amount||BigInt(receipt.totalDebitZats)>1_000_000n)throw new Error('Invalid funding receipt');hasReceipt=true;} catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    if(!intent.txid||!hasReceipt) {
      const entries=(await wallet.ledger()).entries;
      if(!Array.isArray(entries))throw new Error('Funding ledger unavailable; never resend');
      const matches=entries.filter((v):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&v.direction==='sent'&&v.address===receiver&&v.zats===amount&&v.memoHex===memo);
      if(matches.length!==1||typeof matches[0].txid!=='string'||typeof matches[0].feeZats!=='string'||BigInt(matches[0].feeZats)>100_000n)throw new Error('Funding outcome unknown; no resend allowed');
      intent={...intent,state:'broadcast',txid:matches[0].txid};await journal.save('refund-bd1a70e6-1569-4d48-a81c-277ae48f38b9',intent);
      await immutable(join(directory,'public/funding-receipt.json'),{session,txid:matches[0].txid,amountZats:amount,feeZats:matches[0].feeZats,totalDebitZats:(BigInt(amount)+BigInt(matches[0].feeZats)).toString()});
    }
    console.log(JSON.stringify({session,state:'funding-broadcast-awaiting-confirmations',txid:intent.txid,maximumTotalDebitZats:1_000_000,collateralLocked:false,publicDepositsEnabled:false}));
  } finally {await wallet?.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
void main().catch(()=>{console.error(`Isolated funding stopped at ${checkpoint}. Preserve funding records and reconcile any submitting intent; do not resend or remove its journal.`);process.exitCode=1;});
