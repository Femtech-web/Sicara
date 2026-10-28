import {parseAbi,type Address} from 'viem';
import type {BorrowAssetId} from '@/features/lending/model/assets';
// Only verified deployments belong here. ZEC collateral admission is a separate gate.
export const markets:Record<BorrowAssetId,{pool?:Address;token:Address;fromBlock:bigint}>={
 cusdc:{token:'0x6060Af7f2a5D02AA4ACD1183aC7182Ff1EdFe62A',pool:'0x9f64452Cee00181BaFB52900DA691c71b4bd2E78',fromBlock:12_015_172n},
 'demo-zama':{token:'0x0000000000000000000000000000000000000000',fromBlock:0n},
};
export const marketAbi=parseAbi([
 'function loanByBorrower(address borrower) view returns (bytes32)',
 'function maximumPrincipal() view returns (uint64)',
 'function borrow(bytes32 id,bytes32 amount,bytes proof)',
 'function repay(bytes32 id,bytes32 amount,bytes proof)',
 'function requestSettlement(bytes32 id) returns (bytes32)',
 'function finalizeSettlement(bytes32 id,bool repaid,bytes proof)',
 'function commonCeiling() view returns (uint64)',
 'function minimumCollateralZats() view returns (uint64)',
 'function interestBps() view returns (uint16)',
 'function repaymentCutoff() view returns (uint64)',
 'function supply(bytes32 offerId,bytes32 amount,bytes proof)',
 'function withdraw(bytes32 offerId,bytes32 amount,bytes proof)',
 'function withdrawAll(bytes32 offerId)',
 'function positionState(bytes32 id) view returns (address lender,bytes32 loanId,bytes32 available,bytes32 earned)',
 'function loanState(bytes32 id) view returns (address borrower,bytes32 capacity,bytes32 debt,bytes32 borrowed,bytes32 repaid,bytes32 settlementHandle,bool settled)',
 'function resolution(bytes32 id) view returns (uint8)',
 'event Supplied(bytes32 indexed offerId,address indexed lender)',
]);
export const confidentialTokenAbi=parseAbi([
 'function setOperator(address operator,uint48 until)',
 'function isOperator(address holder,address spender) view returns (bool)',
 'function confidentialBalanceOf(address holder) view returns (bytes32)',
]);
