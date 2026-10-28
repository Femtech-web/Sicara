import {createPublicClient,http,parseAbi,parseEventLogs,type Hex,type Transport} from 'viem';
import {sepolia} from 'viem/chains';

export type SettlementBinding={pool:Hex;chain_loan_id:Hex;wallet:Hex;deposit_commitment:Hex;policy_hash:Hex;registration_tx:Hex;registration_block_hash:Hex;settlement_tx:Hex};
export type SettlementProof={tx:Hex;block:number;blockHash:Hex};
export interface SettlementVerifier {verify(binding:SettlementBinding):Promise<SettlementProof|null>}
export class SettlementMismatch extends Error {}
const abi=parseAbi([
 'function loanState(bytes32 id) view returns (address borrower,bytes32 capacity,bytes32 debt,bytes32 borrowed,bytes32 repaid,bytes32 settlementHandle,bool settled)',
 'function consumedDeposit(bytes32 commitment) view returns (bool)',
 'function policyHash() view returns (bytes32)',
 'event LoanSettled(bytes32 indexed loanId)',
]);
/** Trusts configured Sepolia RPC transport, validates canonical receipts and deployed contract state.
 * The CONTRACT verifies the FHE KMS proof. A user-supplied "paid" flag is never accepted.
 */
export class SepoliaSettlementVerifier implements SettlementVerifier {
  constructor(private rpc:string,private transport?:Transport){}
  async verify(binding:SettlementBinding):Promise<SettlementProof|null>{
    const client=createPublicClient({chain:sepolia,transport:this.transport??http(this.rpc,{timeout:15_000,retryCount:1})});
    if(await client.getChainId()!==11155111)throw new SettlementMismatch('Wrong settlement network');
    const tip=await client.getBlockNumber();
    const receipt=await client.getTransactionReceipt({hash:binding.settlement_tx}).catch(error=>{
      if(error instanceof Error && error.name==='TransactionReceiptNotFoundError')return null;
      throw error;
    });
    if(!receipt)return null;
    if(receipt.status!=='success'||receipt.to?.toLowerCase()!==binding.pool.toLowerCase())throw new SettlementMismatch('Settlement transaction failed or target differs');
    if(tip<receipt.blockNumber+11n)return null;
    const canonical=await client.getBlock({blockNumber:receipt.blockNumber});
    if(canonical.hash!==receipt.blockHash)throw new SettlementMismatch('Settlement receipt reorganized');
    const registration=await client.getTransactionReceipt({hash:binding.registration_tx});
    const registrationBlock=await client.getBlock({blockNumber:registration.blockNumber});
    if(registration.status!=='success'||registration.blockHash!==binding.registration_block_hash||registrationBlock.hash!==registration.blockHash||registration.to?.toLowerCase()!==binding.pool.toLowerCase()||tip<registration.blockNumber+11n)throw new SettlementMismatch('Registration is no longer canonical');
    const events=parseEventLogs({abi,logs:receipt.logs.filter(log=>log.address.toLowerCase()===binding.pool.toLowerCase()),eventName:'LoanSettled',strict:true});
    if(events.filter(event=>event.args.loanId===binding.chain_loan_id).length!==1)throw new SettlementMismatch('Loan settlement event missing');
    const [loan,consumed,policy]=await Promise.all([
      client.readContract({address:binding.pool,abi,functionName:'loanState',args:[binding.chain_loan_id],blockNumber:receipt.blockNumber}),
      client.readContract({address:binding.pool,abi,functionName:'consumedDeposit',args:[binding.deposit_commitment],blockNumber:receipt.blockNumber}),
      client.readContract({address:binding.pool,abi,functionName:'policyHash',blockNumber:receipt.blockNumber}),
    ]);
    if(loan[0].toLowerCase()!==binding.wallet.toLowerCase()||!loan[6]||/^0x0+$/.test(loan[5])||!consumed||policy!==binding.policy_hash)throw new SettlementMismatch('Settled borrower/commitment/policy mismatch');
    return {tx:binding.settlement_tx,block:Number(receipt.blockNumber),blockHash:receipt.blockHash};
  }
}
