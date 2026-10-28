import test from 'node:test';
import assert from 'node:assert/strict';
import {custom,encodeAbiParameters,encodeEventTopics,parseAbi,parseAbiParameters,toHex,type Hex} from 'viem';
import {SepoliaSettlementVerifier,SettlementMismatch,type SettlementBinding} from '../services/settlement/sepolia-settlement';

const hash=(n:number)=>`0x${n.toString(16).padStart(64,'0')}` as Hex;
const address=(n:number)=>`0x${n.toString(16).padStart(40,'0')}` as Hex;
const binding:SettlementBinding={pool:address(1),wallet:address(2),chain_loan_id:hash(3),deposit_commitment:hash(4),policy_hash:hash(5),registration_tx:hash(6),registration_block_hash:hash(7),settlement_tx:hash(8)};
type Mode='valid'|'pending'|'wrong-chain'|'failed'|'wrong-pool'|'settlement-reorg'|'registration-reorg'|'wrong-loan'|'wrong-borrower'|'unsettled'|'unconsumed'|'wrong-policy'|'offline';
function verifier(mode:Mode){
 let call=0;
 return new SepoliaSettlementVerifier('unused',custom({request:async({method,params})=>{
  if(mode==='offline')throw new Error('RPC unavailable');
  if(method==='eth_chainId')return toHex(mode==='wrong-chain'?1:11155111);
  if(method==='eth_blockNumber')return toHex(mode==='pending'?110:111);
  if(method==='eth_getTransactionReceipt'){
   const registration=(params as [Hex])[0]===binding.registration_tx;
   return {transactionHash:registration?binding.registration_tx:binding.settlement_tx,blockHash:registration?binding.registration_block_hash:hash(9),blockNumber:toHex(registration?90:100),transactionIndex:'0x0',from:binding.wallet,to:mode==='wrong-pool'&&!registration?address(20):binding.pool,cumulativeGasUsed:'0x100',gasUsed:'0x100',effectiveGasPrice:'0x1',status:mode==='failed'&&!registration?'0x0':'0x1',type:'0x2',logsBloom:`0x${'00'.repeat(256)}`,logs:registration?[]:[{address:binding.pool,topics:encodeEventTopics({abi:parseAbi(['event LoanSettled(bytes32 indexed loanId)']),eventName:'LoanSettled',args:{loanId:mode==='wrong-loan'?hash(30):binding.chain_loan_id}}),data:'0x',blockNumber:'0x64',transactionHash:binding.settlement_tx,transactionIndex:'0x0',blockHash:hash(9),logIndex:'0x0',removed:false}]};
  }
  if(method==='eth_getBlockByNumber'){
   const registration=(params as [Hex])[0]==='0x5a';
   return {hash:registration?(mode==='registration-reorg'?hash(40):binding.registration_block_hash):(mode==='settlement-reorg'?hash(41):hash(9)),number:registration?'0x5a':'0x64',transactions:[]};
  }
  if(method==='eth_call'){
   const index=call++;
   if(index===0)return encodeAbiParameters(parseAbiParameters('address,bytes32,bytes32,bytes32,bytes32,bytes32,bool'),[mode==='wrong-borrower'?address(50):binding.wallet,hash(10),hash(11),hash(12),hash(13),hash(14),mode!=='unsettled']);
   if(index===1)return encodeAbiParameters(parseAbiParameters('bool'),[mode!=='unconsumed']);
   return encodeAbiParameters(parseAbiParameters('bytes32'),[mode==='wrong-policy'?hash(51):binding.policy_hash]);
  }
  throw new Error(`Unexpected RPC method ${method}`);
 }},{retryCount:0}));
}
test('canonical settled receipt must bind the registered borrower, commitment, policy and twelve confirmations',async()=>{
 assert.deepEqual(await verifier('valid').verify(binding),{tx:binding.settlement_tx,block:100,blockHash:hash(9)});
 assert.equal(await verifier('pending').verify(binding),null);
 for(const mode of ['wrong-chain','failed','wrong-pool','settlement-reorg','registration-reorg','wrong-loan','wrong-borrower','unsettled','unconsumed','wrong-policy'] as const){
  await assert.rejects(verifier(mode).verify(binding),SettlementMismatch,mode);
 }
 await assert.rejects(verifier('offline').verify(binding));
});
