import {ethers,fhevm,network,deployments} from 'hardhat';
import {config as loadEnv} from 'dotenv';
import {readFile,mkdir,open,rename} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {Hex} from 'viem';
import {FhevmType} from '@fhevm/hardhat-plugin';
import {connectWorker} from '../../services/database/worker-connection';
import {AuthorizationRepository} from '../../services/issuance/authorization-repository';
import {IssuanceTransactions,type IssuanceStage} from '../../services/issuance/transaction-repository';
import {trackRelease} from '../../services/settlement/release-worker';
import {SepoliaSettlementVerifier} from '../../services/settlement/sepolia-settlement';

const root=resolve(__dirname,'../..');
async function save(path:string,value:unknown){
 const dir=resolve(path,'..');await mkdir(dir,{recursive:true,mode:0o700});const temp=`${path}.${randomUUID()}.tmp`;const file=await open(temp,'wx',0o600);
 try{await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}await rename(temp,path);
 const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
}
async function optional(path:string){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function main(){
 if(network.name!=='sepolia'||(await ethers.provider.getNetwork()).chainId!==11155111n)throw new Error('Sepolia only');
 loadEnv({path:resolve(root,'.env'),quiet:true});loadEnv({path:resolve(root,'.env.local'),override:true,quiet:true});process.chdir(root);
 const proof=JSON.parse(await readFile('.local/evidence/attested-issuance.json','utf8'));
 if(!proof.completed||!proof.borrowerVerified||!process.env.DATABASE_WORKER_URL||!process.env.SEPOLIA_PRIVATE_KEY)throw new Error('Verified issued test loan required');
 await fhevm.initializeCLIApi();if(fhevm.isMock)throw new Error('Live FHE required');
 const [signer]=await ethers.getSigners();const rawSigner=new ethers.Wallet(process.env.SEPOLIA_PRIVATE_KEY,ethers.provider);
 const deployment=await deployments.get('AttestedLoanPilot');if(deployment.address!==proof.pool)throw new Error('Pool mismatch');
 const pool=await ethers.getContractAt('AttestedLoanPilot',deployment.address,signer);const token=await ethers.getContractAt('DemoZama',await pool.token(),signer);
 const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 const connection=await connectWorker(process.env.DATABASE_WORKER_URL,stop);
 try{
  const repository=new AuthorizationRepository(connection.database);const row=await repository.get(proof.loanId);
  if(row.wallet!==signer.address.toLowerCase()||row.pool!==deployment.address.toLowerCase()||row.chain_loan_id!==proof.chainLoanId)throw new Error('Borrower/loan binding mismatch');
  const transactions=new IssuanceTransactions(connection.database);const file=resolve('.local/evidence/repaid-release.json');
  const evidence=await optional(file)??{loanId:row.loan_id,chainLoanId:row.chain_loan_id,pool:row.pool,transactions:{}};
  if(evidence.loanId!==row.loan_id||evidence.chainLoanId!==row.chain_loan_id||evidence.pool!==row.pool)throw new Error('Saved repayment identity mismatch');
  async function record(stage:IssuanceStage,target:string,build:()=>Promise<string>,confirmations=1){
   let intent=await transactions.get(row.loan_id,stage);const packetFile=resolve(`.local/issuance/${row.loan_id}-${stage}.json`);const backup=await optional(packetFile);
   if(backup&&(!intent||intent.tx_hash!==backup.hash||intent.raw_transaction!==backup.raw))throw new Error('Signed packet/SQL mismatch');
   if(!intent){
    const data=await build();const gas=(await rawSigner.estimateGas({to:target,data}))*12n/10n+100_000n;if(gas>25_000_000n)throw new Error('Gas cap exceeded');
    const raw=await rawSigner.signTransaction(await rawSigner.populateTransaction({to:target,data,gasLimit:gas}));
    intent=await transactions.prepare(row.loan_id,stage,raw as Hex,data as Hex,(await token.getAddress()) as Hex);
   }
   if(!backup)await save(packetFile,{hash:intent.tx_hash,raw:intent.raw_transaction});
   const tx=ethers.Transaction.from(intent.raw_transaction);
   if(tx.from?.toLowerCase()!==row.wallet||tx.to?.toLowerCase()!==target.toLowerCase()||tx.chainId!==11155111n||tx.value!==0n||tx.hash!==intent.tx_hash)throw new Error('Saved repayment transaction invalid');
   let receipt=await ethers.provider.getTransactionReceipt(intent.tx_hash);
   if(!receipt){if(intent.state==='confirmed')throw new Error('Confirmed repayment receipt disappeared');try{await ethers.provider.broadcastTransaction(intent.raw_transaction);}catch{/* reconcile known hash */}}
   for(let attempt=0;attempt<60;attempt++){
    if(controller.signal.aborted)throw new Error('Stopped');
    receipt=await ethers.provider.getTransactionReceipt(intent.tx_hash);
    if(receipt&&(receipt.status===0||await receipt.confirmations()>=confirmations))break;
    if(attempt%6===0)console.log(`Waiting for ${stage} confirmations (${attempt+1}/60)`);
    await new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,5000);controller.signal.addEventListener('abort',done,{once:true});});
   }
   if(!receipt||receipt.status!==1||await receipt.confirmations()<confirmations)throw new Error('Repayment stage not confirmed; reconcile existing hash');
   const canonical=await ethers.provider.getBlock(receipt.blockNumber);
   if(canonical?.hash!==receipt.blockHash||intent.block_hash&&intent.block_hash!==receipt.blockHash)throw new Error('Repayment receipt reorganized');
   await transactions.confirm(row.loan_id,stage,intent.tx_hash,receipt.blockNumber,receipt.blockHash as Hex);evidence.transactions[stage]=intent.tx_hash;await save(file,evidence);
   console.log(`${stage} confirmed: ${intent.tx_hash}`);return receipt;
  }
  if(!process.argv.includes('--verify-only')&&process.env.SICARA_REPAY_VERIFY_ONLY!=='1'){
   await record('approve',await token.getAddress(),async()=>token.interface.encodeFunctionData('setOperator',[deployment.address,(await ethers.provider.getBlock('latest'))!.timestamp+3600]));
   await record('repay',deployment.address,async()=>{const amount=await fhevm.createEncryptedInput(deployment.address,signer.address).add64(250_000n).encrypt();return pool.interface.encodeFunctionData('repay',[row.chain_loan_id,amount.handles[0],amount.inputProof]);});
   const requested=await record('request_settlement',deployment.address,async()=>pool.interface.encodeFunctionData('requestSettlement',[row.chain_loan_id]));
   await record('settle',deployment.address,async()=>{
    const handle=(await pool.loanState(row.chain_loan_id,{blockTag:requested.blockNumber})).settlementHandle;
    const decrypted=await fhevm.publicDecrypt([handle]);
    return pool.interface.encodeFunctionData('finalizeSettlement',[row.chain_loan_id,true,decrypted.decryptionProof]);
   },12);
   await record('revoke',await token.getAddress(),async()=>token.interface.encodeFunctionData('setOperator',[deployment.address,0]));
  }
  const settled=await transactions.get(row.loan_id,'settle');if(!settled||settled.state!=='confirmed')throw new Error('Confirmed settlement required');
  const verifier=new SepoliaSettlementVerifier(process.env.SEPOLIA_RPC_URL!);
  const current=await repository.get(row.loan_id);
  const canonical=await verifier.verify({pool:current.pool as Hex,wallet:current.wallet as Hex,chain_loan_id:current.chain_loan_id,deposit_commitment:current.deposit_commitment,policy_hash:current.policy_hash,registration_tx:current.registration_tx as Hex,registration_block_hash:current.registration_block_hash as Hex,settlement_tx:settled.tx_hash});
  if(!canonical)throw new Error('Settlement finality pending');
  let zero=false;for(let i=0;i<12;i++){try{zero=await fhevm.userDecryptEuint(FhevmType.euint64,(await pool.loanState(row.chain_loan_id)).debt,deployment.address,signer)===0n;if(zero)break;}catch{/* KMS readiness */}await new Promise(resolve=>setTimeout(resolve,5000));}
  if(!zero||await token.isOperator(signer.address,deployment.address))throw new Error('Debt/permission cleanup unverified');
  // Track only; a separate custody-worker process must verify the chain proof again before sending ZEC.
  await trackRelease(connection.database,row.loan_id,settled.tx_hash);
  evidence.repaidVerified=true;evidence.settlementTx=settled.tx_hash;await save(file,evidence);
  console.log('Repayment proof verified. Release recorded; no Zcash send in this process.');
 }finally{await connection.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
void main().catch(()=>{console.error('Repayment/release preparation stopped. Preserve signed packets and SQL; reconcile existing hashes. No credentials logged.');process.exitCode=1;});
