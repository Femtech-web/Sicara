/** Isolated valueless cUSDC loan backed by the native frozen-default evidence.
 * No Zcash viewing material or note amount is read by this Sepolia runner.
 */
import {ethers,fhevm,network,deployments} from 'hardhat';
import {FhevmType} from '@fhevm/hardhat-plugin';
import {open,readFile,rename,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import type {TransactionRequest,Wallet} from 'ethers';
import type {Hex} from 'viem';
type Evidence={version:number;session:string;scenario:string|undefined;pool:string;token:string;runtimeCodeHash:string;borrower:string;loanId:string;offerId:string;custodyKey:string;transactions:Record<string,{hash:string;block:number;blockHash:string}>;completed:boolean;supplyVerified?:boolean;registered?:boolean;borrowVerified?:boolean;repayVerified?:boolean;settlementVerified?:boolean;interestDeliveryVerified?:boolean;eligibility?:{loanId:string;borrower:string;claim:string;custodyKey:string;root:string;snapshotBlock:string;snapshotHeight:number;proofHash:string;validUntil:number}};

async function read(path:string){return JSON.parse(await readFile(path,'utf8'));}
async function durable(path:string,value:unknown){const temp=`${path}.tmp`;const f=await open(temp,'w',0o600);try{await f.writeFile(JSON.stringify(value,null,2));await f.sync();}finally{await f.close();}await rename(temp,path);const d=await open(resolve(path,'..'),'r');try{await d.sync();}finally{await d.close();}}
async function main(){
 const session=process.env.SICARA_ISOLATED_SESSION,scenario=process.env.SICARA_ISOLATED_SCENARIO,step=process.env.SICARA_ISOLATED_STEP;
 if(network.name!=='sepolia'||(await ethers.provider.getNetwork()).chainId!==11155111n||!session||!/^[a-f0-9]{32}$/.test(session)||!['release','default','recovery'].includes(scenario??'')||!['supply','register','borrow','repay','settle','withdraw'].includes(step??''))throw new Error('Explicit isolated Sepolia session/scenario/step required');
 const base=resolve('../.local/isolated-live',session),path=join(base,'public',`${scenario}-sepolia.json`),packets=join(base,'client',`${scenario}-evm-packets`);
 await mkdir(packets,{recursive:true,mode:0o700});
 const frozen=await read(join(base,'public',`${scenario}-frozen-default.json`));
 if(frozen.session!==session||frozen.scenario!==scenario||frozen.state!=='live-default-frozen-not-borrowed'||frozen.commonMinimumVerified!==true||frozen.independentOperators!==false)throw new Error('Verified native default required before any loan');
 const key=process.env.SEPOLIA_PRIVATE_KEY;if(!key)throw new Error('Dedicated Sepolia test signer required');
 const borrower=new ethers.Wallet(key,ethers.provider);
 const poolDeployment=await deployments.get('MatchedLendingPool'),tokenDeployment=await deployments.get('ConfidentialTestUSDC');
 const pool=await ethers.getContractAt('MatchedLendingPool',poolDeployment.address,borrower),token=await ethers.getContractAt('ConfidentialTestUSDC',tokenDeployment.address,borrower);
 const runtimeHash=ethers.keccak256(await ethers.provider.getCode(poolDeployment.address));
 if(poolDeployment.address.toLowerCase()!=='0x9f64452cee00181bafb52900da691c71b4bd2e78'||runtimeHash!=='0xff9ccc08e4cf6653d1402e52ded3b93301ad5a4704ef642cf381867eff5b4304'||(await pool.owner()).toLowerCase()!==borrower.address.toLowerCase()||await pool.commonCeiling()!==50_000n||await pool.interestBps()!==200n)throw new Error('Pinned isolated market mismatch');
 await fhevm.initializeCLIApi();if(fhevm.isMock)throw new Error('Live FHEVM required');await fhevm.assertCoprocessorInitialized(pool,'Private collateral test loan');
 let report:Evidence;try{report=await read(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;report={version:1,session,scenario,pool:poolDeployment.address,token:tokenDeployment.address,runtimeCodeHash:runtimeHash,borrower:borrower.address,loanId:ethers.hexlify(ethers.randomBytes(32)),offerId:ethers.hexlify(ethers.randomBytes(32)),custodyKey:`0x${frozen.custodyKey}`,transactions:{},completed:false};await durable(path,report);}
 if(report.pool.toLowerCase()!==poolDeployment.address.toLowerCase()||report.borrower.toLowerCase()!==borrower.address.toLowerCase()||report.custodyKey!==`0x${frozen.custodyKey}`)throw new Error('Saved run changed');
 const lock=await open(join(packets,'running.lock'),'wx',0o600);
 try{
 let lenderKey;const lenderFile=join(base,'lender','evm-test-wallet.json');
 try{lenderKey=(await read(lenderFile)).privateKey;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const wallet=ethers.Wallet.createRandom();lenderKey=wallet.privateKey;const file=await open(lenderFile,'wx',0o600);try{await file.writeFile(JSON.stringify({network:'sepolia',privateKey:lenderKey}));await file.sync();}finally{await file.close();}}
 const lender=new ethers.Wallet(lenderKey,ethers.provider);
 async function receipt(hash:string){for(let i=0;i<30;i++){const r=await ethers.provider.getTransactionReceipt(hash);if(r){if(r.status!==1||(await ethers.provider.getBlock(r.blockNumber))?.hash!==r.blockHash)throw new Error('Receipt failed or reorganized');return r;}await new Promise(done=>setTimeout(done,4000));}throw new Error('Unknown outcome; preserve exact packet');}
 async function tx(stage:string,signer:Wallet,to:string,data:string,value=0n){
  const file=join(packets,`${stage}.json`);let packet;
  try{packet=await read(file);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
   const request:TransactionRequest={to,data,value};const gas=(await signer.estimateGas(request))*12n/10n+100_000n;if(gas>25_000_000n)throw new Error('Gas exceeds isolated ceiling');
   const raw=await signer.signTransaction(await signer.populateTransaction({...request,gasLimit:gas}));packet={raw,hash:ethers.keccak256(raw)};await durable(file,packet);}
  const parsed=ethers.Transaction.from(packet.raw);
  if(parsed.chainId!==11155111n||parsed.from?.toLowerCase()!==signer.address.toLowerCase()||parsed.to?.toLowerCase()!==to.toLowerCase()||parsed.data!==data||parsed.value!==value||ethers.keccak256(packet.raw)!==packet.hash)throw new Error('Exact packet binding changed');
  let found=await ethers.provider.getTransactionReceipt(packet.hash);
  if(!found){try{await ethers.provider.broadcastTransaction(packet.raw);}catch{/* reconcile the exact pre-signed hash only */}found=await receipt(packet.hash);}
  if(found.status!==1||(await ethers.provider.getBlock(found.blockNumber))?.hash!==found.blockHash)throw new Error('Noncanonical transaction');
  report.transactions[stage]={hash:packet.hash,block:found.blockNumber,blockHash:found.blockHash};await durable(path,report);console.log(`${stage} confirmed: ${packet.hash}`);return found;
 }
 async function amount(handle:string,contract:string,signer:Wallet,expected:bigint){for(let i=0;i<12;i++){try{if(await fhevm.userDecryptEuint(FhevmType.euint64,handle,contract,signer)===expected)return;}catch{/* bounded live coprocessor/KMS readiness */}await new Promise(done=>setTimeout(done,5000));}throw new Error('Private accounting not verified');}
 const poolAddress=poolDeployment.address,tokenAddress=tokenDeployment.address;
 if(step==='supply'){
  await tx('fundLenderGas',borrower,lender.address,'0x',ethers.parseEther('0.01'));
  await tx('mintLenderTestTokens',borrower,tokenAddress,token.interface.encodeFunctionData('mint',[lender.address,50_000n]));
  const until=(await ethers.provider.getBlock('latest'))!.timestamp+1800;
  // Pin permission timestamp before constructing its signed packet.
  const permissionMeta=join(packets,'permission-until.json');let permissionUntil:number;try{permissionUntil=(await read(permissionMeta)).until;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;permissionUntil=Number(until);await durable(permissionMeta,{until:permissionUntil});}
  await tx('lenderPermission',lender,tokenAddress,token.interface.encodeFunctionData('setOperator',[poolAddress,permissionUntil]));
  let encoded;const suppliedPacket=join(packets,'supply.json');try{encoded=ethers.Transaction.from((await read(suppliedPacket)).raw).data;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const input=await fhevm.createEncryptedInput(poolAddress,lender.address).add64(50_000n).encrypt();encoded=pool.interface.encodeFunctionData('supply',[report.offerId,input.handles[0],input.inputProof]);}
  await tx('supply',lender,poolAddress,encoded);await amount((await pool.positionState(report.offerId)).available,poolAddress,lender,50_000n);report.supplyVerified=true;
 }else if(step==='register'){
  if(report.supplyVerified!==true)throw new Error('Verified lender supply required');
  let encoded;try{encoded=ethers.Transaction.from((await read(join(packets,'register.json'))).raw).data;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;
   const now=(await ethers.provider.getBlock('latest'))!.timestamp;
   const a={loanId:report.loanId,borrower:borrower.address,claim:ethers.hexlify(ethers.randomBytes(32)),custodyKey:report.custodyKey,root:`0x${frozen.root}`,snapshotBlock:`0x${frozen.anchorHash}`,snapshotHeight:frozen.anchorHeight,proofHash:ethers.sha256(ethers.toUtf8Bytes(JSON.stringify(frozen))),validUntil:now+110};
   const types={Eligibility:[['loanId','bytes32'],['borrower','address'],['claim','bytes32'],['custodyKey','bytes32'],['root','bytes32'],['snapshotBlock','bytes32'],['snapshotHeight','uint64'],['proofHash','bytes32'],['validUntil','uint64']].map(([name,type])=>({name,type}))};
   const signature=await borrower.signTypedData({name:'SicaraCommonCeiling',version:'1',chainId:11155111,verifyingContract:poolAddress},types,a);report.eligibility=a;await durable(path,report);encoded=pool.interface.encodeFunctionData('registerAndMatch',[a,signature,report.offerId]);}
  const r=await tx('register',borrower,poolAddress,encoded);
  const binding={pool:poolAddress,runtimeCodeHash:runtimeHash,loanId:report.loanId,borrower:borrower.address,claim:report.eligibility!.claim,custodyKey:report.custodyKey,policy:await pool.policyHash(),registrationTx:r.hash,registrationBlockHash:r.blockHash,repaymentCutoff:Number(await pool.repaymentCutoff()),settlementCutoff:Number(await pool.settlementCutoff())};
  await durable(join(base,'public',`${scenario}-loan-binding.json`),binding);report.registered=true;
 }else if(step==='borrow'||step==='repay'){
  if(report.registered!==true)throw new Error('Verified registration required');
  if(step==='repay'){
   await tx('mintInterestTestTokens',borrower,tokenAddress,token.interface.encodeFunctionData('mint',[borrower.address,200n]));
   const permit=join(packets,'borrower-permission-until.json');let until;try{until=(await read(permit)).until;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;until=(await ethers.provider.getBlock('latest'))!.timestamp+1800;await durable(permit,{until});}
   await tx('borrowerPermission',borrower,tokenAddress,token.interface.encodeFunctionData('setOperator',[poolAddress,until]));
  }
  let encoded;try{encoded=ethers.Transaction.from((await read(join(packets,`${step}.json`))).raw).data;}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const input=await fhevm.createEncryptedInput(poolAddress,borrower.address).add64(step==='borrow'?10_000n:10_200n).encrypt();encoded=step==='borrow'?pool.interface.encodeFunctionData('borrow',[report.loanId,input.handles[0],input.inputProof]):pool.interface.encodeFunctionData('repay',[report.loanId,input.handles[0],input.inputProof]);}
  await tx(step,borrower,poolAddress,encoded);await amount((await pool.loanState(report.loanId)).debt,poolAddress,borrower,step==='borrow'?10_200n:0n);report[`${step}Verified`]=true;
 }else if(step==='settle'){
  if(report.repayVerified!==true)throw new Error('Verified full repayment required');
  await tx('requestSettlement',borrower,poolAddress,pool.interface.encodeFunctionData('requestSettlement',[report.loanId]));
  const state=await pool.loanState(report.loanId);const proof=await fhevm.publicDecrypt([state.settlementHandle]);
  if(proof.clearValues[state.settlementHandle as Hex]!==true)throw new Error('KMS has not established zero debt');
  const r=await tx('finalizeSettlement',borrower,poolAddress,pool.interface.encodeFunctionData('finalizeSettlement',[report.loanId,true,proof.decryptionProof]));
  const binding=await read(join(base,'public',`${scenario}-loan-binding.json`));binding.settlementTx=r.hash;await durable(join(base,'public',`${scenario}-loan-binding.json`),binding);report.settlementVerified=(await pool.loanState(report.loanId)).settled;
 }else if(step==='withdraw'){
  if(!(await pool.loanState(report.loanId)).settled)throw new Error('Verified settlement required');
  const position=await pool.positionState(report.offerId);await amount(position.earned,poolAddress,lender,200n);await amount(position.available,poolAddress,lender,50_200n);
  await tx('withdrawPrincipalAndInterest',lender,poolAddress,pool.interface.encodeFunctionData('withdrawAll',[report.offerId]));await amount((await pool.positionState(report.offerId)).available,poolAddress,lender,0n);report.interestDeliveryVerified=true;
 }
 await durable(path,report);console.log(JSON.stringify({session,scenario,step,verified:true,privateCollateralReturnVerified:false,publicDepositsEnabled:false}));
 }finally{await lock.close();const {unlink}=await import('node:fs/promises');await unlink(join(packets,'running.lock'));}
}
void main().catch(()=>{console.error('Isolated private loan stopped. Preserve packets and reconcile exact hashes before retrying.');process.exitCode=1;});
