/** Read-only admission for the common-ceiling experiment. Never signs or sends.
 * Trusts the configured Sepolia RPC; no plaintext amount or custody key is used.
 */
import {createPublicClient, http, keccak256, parseAbi, parseEventLogs, type Hex, type Transport} from 'viem';
import {sepolia} from 'viem/chains';

export const commonSettlementAbi = parseAbi([
 'function loanState(bytes32 id) view returns (address borrower,bytes32 capacity,bytes32 debt,bytes32 borrowed,bytes32 repaid,bytes32 settlementHandle,bool settled)',
 'function consumedClaim(bytes32 claim) view returns (bool)',
 'function consumedCustodyKey(bytes32 key) view returns (bool)',
 'function policyHash() view returns (bytes32)',
 'function repaymentCutoff() view returns (uint64)',
 'function settlementCutoff() view returns (uint64)',
 'function resolution(bytes32 id) view returns (uint8)',
 'function resolutionHandle(bytes32 id) view returns (bytes32)',
 'event EligibilityConsumed(bytes32 indexed loanId,bytes32 indexed claim,bytes32 indexed custodyKey)',
 'event LoanSettled(bytes32 indexed loanId)',
 'event LoanResolved(bytes32 indexed loanId,bool debtFree)',
]);
export type CommonSettlementBinding = {
 pool: Hex; runtimeCodeHash: Hex; loanId: Hex; borrower: Hex; claim: Hex; custodyKey: Hex; policy: Hex;
 registrationTx: Hex; registrationBlockHash: Hex; settlementTx: Hex;
 repaymentCutoff: number; settlementCutoff: number;
};
export type ConfirmedDefault = {
 kind:'verified-unsettled-after-cutoff'; binding: Omit<CommonSettlementBinding,'settlementTx'>;
 observedBlock: bigint; observedBlockHash: Hex; tip: bigint;
};
export type ConfirmedSettlement = {
 kind:'verified-common-ceiling-settlement'; binding: CommonSettlementBinding;
 settlementBlock: bigint; settlementBlockHash: Hex; tip: bigint;
};

/** No caller-supplied repaid boolean. Receipt, canonical blocks, immutable code,
 * registration event, consumed claim/key, borrower and KMS-verified settled state
 * must all agree. Twelve confirmations are required, followed by a reorg recheck.
 */
export class CommonCeilingSettlementVerifier {
 constructor(private rpc: string, private transport?: Transport) {}
 async verify(b: CommonSettlementBinding): Promise<ConfirmedSettlement> {
  if(![b.pool,b.borrower].every(v=>/^0x[0-9a-fA-F]{40}$/.test(v)) ||
   ![b.runtimeCodeHash,b.loanId,b.claim,b.custodyKey,b.policy,b.registrationTx,b.registrationBlockHash,b.settlementTx].every(v=>/^0x[0-9a-fA-F]{64}$/.test(v)&&!/^0x0+$/.test(v)) ||
   !Number.isSafeInteger(b.repaymentCutoff)||!Number.isSafeInteger(b.settlementCutoff)||b.repaymentCutoff<1||b.settlementCutoff-b.repaymentCutoff<120)throw new Error('Invalid pinned settlement binding');
  const c=createPublicClient({chain:sepolia,transport:this.transport??http(this.rpc,{timeout:15_000,retryCount:0})});
  if(await c.getChainId()!==11155111)throw new Error('Wrong settlement network');
  const tip=await c.getBlockNumber();
  const registration=await c.getTransactionReceipt({hash:b.registrationTx});
  const settlement=await c.getTransactionReceipt({hash:b.settlementTx});
  for(const receipt of [registration,settlement]){
   if(receipt.status!=='success'||receipt.to?.toLowerCase()!==b.pool.toLowerCase()||tip<receipt.blockNumber+11n)throw new Error('Receipt failed, wrong pool or insufficient confirmations');
  }
  if(registration.blockHash!==b.registrationBlockHash||registration.blockNumber>settlement.blockNumber)throw new Error('Registration binding changed');
  const registered=parseEventLogs({abi:commonSettlementAbi,eventName:'EligibilityConsumed',logs:registration.logs.filter(l=>l.address.toLowerCase()===b.pool.toLowerCase()),strict:true});
  const relevant=registered.filter(e=>e.args.loanId===b.loanId);
  if(relevant.length!==1||relevant[0].args.claim!==b.claim||relevant[0].args.custodyKey!==b.custodyKey)throw new Error('Registered claim/key mismatch');
  const settled=parseEventLogs({abi:commonSettlementAbi,eventName:'LoanSettled',logs:settlement.logs.filter(l=>l.address.toLowerCase()===b.pool.toLowerCase()),strict:true});
  if(settled.filter(e=>e.args.loanId===b.loanId).length!==1)throw new Error('Settlement event missing');
  const registrationBlock=await c.getBlock({blockNumber:registration.blockNumber});
  const settlementBlock=await c.getBlock({blockNumber:settlement.blockNumber});
  if(registrationBlock.hash!==registration.blockHash||settlementBlock.hash!==settlement.blockHash)throw new Error('Reorganized settlement');
  const code=await c.getCode({address:b.pool,blockNumber:settlement.blockNumber});
  if(!code||keccak256(code)!==b.runtimeCodeHash)throw new Error('Unapproved runtime code');
  const read={address:b.pool,abi:commonSettlementAbi,blockNumber:settlement.blockNumber} as const;
  const [loan,claim,key,policy,payCutoff,settleCutoff,resolution,resolutionHandle]=await Promise.all([
   c.readContract({...read,functionName:'loanState',args:[b.loanId]}),
   c.readContract({...read,functionName:'consumedClaim',args:[b.claim]}),
   c.readContract({...read,functionName:'consumedCustodyKey',args:[b.custodyKey]}),
   c.readContract({...read,functionName:'policyHash'}),
   c.readContract({...read,functionName:'repaymentCutoff'}),
   c.readContract({...read,functionName:'settlementCutoff'}),
   c.readContract({...read,functionName:'resolution',args:[b.loanId]}),
   c.readContract({...read,functionName:'resolutionHandle',args:[b.loanId]}),
  ]);
  if(loan[0].toLowerCase()!==b.borrower.toLowerCase()||!loan[6]||/^0x0+$/.test(loan[5])||!claim||!key||policy!==b.policy||payCutoff!==BigInt(b.repaymentCutoff)||settleCutoff!==BigInt(b.settlementCutoff))throw new Error('Unsettled or mismatched common policy');
  if(settlementBlock.timestamp>=BigInt(b.settlementCutoff)){
   const resolved=parseEventLogs({abi:commonSettlementAbi,eventName:'LoanResolved',logs:settlement.logs.filter(l=>l.address.toLowerCase()===b.pool.toLowerCase()),strict:true});
   if(resolution!==1||resolutionHandle!==loan[5]||resolved.filter(e=>e.args.loanId===b.loanId&&e.args.debtFree).length!==1)throw new Error('Late settlement lacks verified zero-debt recovery');
  }
  // Recheck after the state calls; a changed block is never treated as payment.
  for(const receipt of [registration,settlement]){
   if((await c.getBlock({blockNumber:receipt.blockNumber})).hash!==receipt.blockHash)throw new Error('Settlement changed during verification');
  }
  return {kind:'verified-common-ceiling-settlement',binding:{...b},settlementBlock:settlement.blockNumber,settlementBlockHash:settlement.blockHash,tip};
 }
 /** Unsettled alone is NOT default. Require the immutable KMS-verified nonzero
  * debt decision after repayments closed. Pending proof delivery holds escrow.
  */
 async verifyUnsettledAfterCutoff(b: Omit<CommonSettlementBinding,'settlementTx'>): Promise<ConfirmedDefault> {
  if(![b.pool,b.borrower].every(v=>/^0x[0-9a-fA-F]{40}$/.test(v)) ||
   ![b.runtimeCodeHash,b.loanId,b.claim,b.custodyKey,b.policy,b.registrationTx,b.registrationBlockHash].every(v=>/^0x[0-9a-fA-F]{64}$/.test(v)&&!/^0x0+$/.test(v)) ||
   !Number.isSafeInteger(b.repaymentCutoff)||!Number.isSafeInteger(b.settlementCutoff)||b.repaymentCutoff<1||b.settlementCutoff-b.repaymentCutoff<120)throw new Error('Invalid pinned settlement binding');
  const c=createPublicClient({chain:sepolia,transport:this.transport??http(this.rpc,{timeout:15_000,retryCount:0})});
  if(await c.getChainId()!==11155111)throw new Error('Wrong settlement network');
  const tip=await c.getBlockNumber();
  const registration=await c.getTransactionReceipt({hash:b.registrationTx});
  if(registration.status!=='success'||registration.to?.toLowerCase()!==b.pool.toLowerCase()||registration.blockHash!==b.registrationBlockHash||tip<registration.blockNumber+11n)throw new Error('Registration failed, changed or unconfirmed');
  const registered=parseEventLogs({abi:commonSettlementAbi,eventName:'EligibilityConsumed',logs:registration.logs.filter(l=>l.address.toLowerCase()===b.pool.toLowerCase()),strict:true}).filter(e=>e.args.loanId===b.loanId);
  if(registered.length!==1||registered[0].args.claim!==b.claim||registered[0].args.custodyKey!==b.custodyKey)throw new Error('Registered claim/key mismatch');
  const observed=await c.getBlock({blockNumber:tip-11n});
  if(observed.timestamp<BigInt(b.settlementCutoff))throw new Error('Settlement window still open');
  const code=await c.getCode({address:b.pool,blockNumber:observed.number});
  if(!code||keccak256(code)!==b.runtimeCodeHash)throw new Error('Unapproved runtime code');
  const read={address:b.pool,abi:commonSettlementAbi,blockNumber:observed.number} as const;
  const [loan,claim,key,policy,payCutoff,settleCutoff,resolution,resolutionHandle]=await Promise.all([
   c.readContract({...read,functionName:'loanState',args:[b.loanId]}),
   c.readContract({...read,functionName:'consumedClaim',args:[b.claim]}),
   c.readContract({...read,functionName:'consumedCustodyKey',args:[b.custodyKey]}),
   c.readContract({...read,functionName:'policyHash'}),
   c.readContract({...read,functionName:'repaymentCutoff'}),
   c.readContract({...read,functionName:'settlementCutoff'}),
   c.readContract({...read,functionName:'resolution',args:[b.loanId]}),
   c.readContract({...read,functionName:'resolutionHandle',args:[b.loanId]}),
  ]);
  if(loan[0].toLowerCase()!==b.borrower.toLowerCase()||loan[6]||!claim||!key||policy!==b.policy||payCutoff!==BigInt(b.repaymentCutoff)||settleCutoff!==BigInt(b.settlementCutoff))throw new Error('Loan settled or policy mismatched');
  if(resolution!==2||/^0x0+$/.test(resolutionHandle))throw new Error('Verified nonzero-debt resolution required; pending is not default');
  for(const [number,hash] of [[registration.blockNumber,registration.blockHash],[observed.number,observed.hash]] as const){
   if((await c.getBlock({blockNumber:number})).hash!==hash)throw new Error('Observation changed during verification');
  }
  return {kind:'verified-unsettled-after-cutoff',binding:{...b},observedBlock:observed.number,observedBlockHash:observed.hash,tip};
 }
}
