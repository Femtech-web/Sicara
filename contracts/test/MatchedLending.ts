import {expect} from 'chai';
import assert from 'node:assert/strict';
import {ethers,fhevm} from 'hardhat';
import {FhevmType} from '@fhevm/hardhat-plugin';

describe('Matched lender accounting (FHEVM mock; collateral eligibility fixture)',function(){
 before(function(){if(!fhevm.isMock)this.skip();});
 async function setup(){
  const [operator,lender,borrower,other,stranger]=await ethers.getSigners();
  const token=await ethers.deployContract('ConfidentialTestUSDC',[operator.address]);
  const now=(await ethers.provider.getBlock('latest'))!.timestamp;
  const pool=await ethers.deployContract('MatchedLendingPool',[await token.getAddress(),operator.address,100_000,now+600,now+900,200]);
  const address=await pool.getAddress();
  await token.mint(lender.address,1_000_000);await token.mint(other.address,1_000_000);await token.mint(borrower.address,1_000_000);
  for(const user of [lender,other,borrower])await token.connect(user).setOperator(address,now+1200);
  const h=()=>ethers.hexlify(ethers.randomBytes(32));
  const encrypted=async(user:typeof lender,amount:bigint)=>fhevm.createEncryptedInput(address,user.address).add64(amount).encrypt();
  const supply=async(user:typeof lender,amount:bigint)=>{const id=h(),i=await encrypted(user,amount);await pool.connect(user).supply(id,i.handles[0],i.inputProof);return id;};
  const decrypt=async(handle:string,user=borrower)=>fhevm.userDecryptEuint(FhevmType.euint64,handle,address,user);
  const match=async(id:string)=>{
   const time=(await ethers.provider.getBlock('latest'))!.timestamp;
   const a={loanId:h(),borrower:borrower.address,claim:h(),custodyKey:h(),root:h(),snapshotBlock:h(),snapshotHeight:1000,proofHash:h(),validUntil:time+110};
   const fields=[['loanId','bytes32'],['borrower','address'],['claim','bytes32'],['custodyKey','bytes32'],['root','bytes32'],['snapshotBlock','bytes32'],['snapshotHeight','uint64'],['proofHash','bytes32'],['validUntil','uint64']].map(([name,type])=>({name,type}));
   const sig=await operator.signTypedData({name:'SicaraCommonCeiling',version:'1',chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:address},{Eligibility:fields},a);
   await expect(pool.connect(borrower).registerEligibleLoan(a,sig)).to.be.revertedWithCustomError(pool,'MatchRequired');
   await pool.connect(borrower).registerAndMatch(a,sig,id);return a.loanId;
  };
  const act=async(method:'borrow'|'repay',id:string,amount:bigint)=>{const i=await encrypted(borrower,amount);await pool.connect(borrower)[method](id,i.handles[0],i.inputProof);};
  const withdraw=async(user:typeof lender,id:string,amount:bigint)=>{const i=await encrypted(user,amount);return pool.connect(user).withdraw(id,i.handles[0],i.inputProof);};
  return {operator,lender,borrower,other,stranger,token,pool,address,now,encrypted,supply,decrypt,match,act,withdraw};
 }
 it('pays required interest only from actual repayments; isolates lender offers, locks funds and settles before withdrawal',async()=>{
  const s=await setup();const offer=await s.supply(s.lender,50_000n);const other=await s.supply(s.other,40_000n);const id=await s.match(offer);
  await s.act('borrow',id,60_000n);expect(await s.decrypt((await s.pool.loanState(id)).debt)).to.equal(0);
  await s.act('borrow',id,49_020n);expect(await s.decrypt((await s.pool.loanState(id)).debt)).to.equal(0);
  await s.act('borrow',id,25_000n);expect(await s.decrypt((await s.pool.loanState(id)).debt)).to.equal(25_500);
  await s.act('borrow',id,25_000n);expect(await s.decrypt((await s.pool.loanState(id)).debt)).to.equal(25_500);
  expect(await s.decrypt((await s.pool.positionState(other)).available,s.other)).to.equal(40_000);
  await expect(s.withdraw(s.lender,offer,1n)).to.be.revertedWithCustomError(s.pool,'PositionLocked');
  await s.act('repay',id,10_000n);expect(await s.decrypt((await s.pool.positionState(offer)).earned,s.lender)).to.equal(0);
  await s.act('repay',id,15_000n);expect(await s.decrypt((await s.pool.loanState(id)).debt)).to.equal(500);
  await s.act('repay',id,10_000n);expect(await s.decrypt((await s.pool.positionState(offer)).earned,s.lender)).to.equal(500);
  expect(await s.decrypt((await s.pool.positionState(offer)).available,s.lender)).to.equal(50_500);
  const privateBalance=(await s.pool.positionState(offer)).available;
  await assert.rejects(()=>s.decrypt(privateBalance,s.stranger));
  await s.pool.connect(s.borrower).requestSettlement(id);const handle=(await s.pool.loanState(id)).settlementHandle;
  const proof=await fhevm.publicDecrypt([handle]);await s.pool.finalizeSettlement(id,true,proof.decryptionProof);
  const before=await fhevm.userDecryptEuint(FhevmType.euint64,await s.token.confidentialBalanceOf(s.lender.address),await s.token.getAddress(),s.lender);
  await s.withdraw(s.lender,offer,1_000_000n);
  const after=await fhevm.userDecryptEuint(FhevmType.euint64,await s.token.confidentialBalanceOf(s.lender.address),await s.token.getAddress(),s.lender);
  expect(after-before).to.equal(50_500);expect(await s.decrypt((await s.pool.positionState(offer)).available,s.lender)).to.equal(0);
  expect(await s.decrypt((await s.pool.positionState(other)).available,s.other)).to.equal(40_000);
 });
 it('does not borrow another lender’s money when the matched offer transferred zero; allows unmatched withdrawal after cutoff',async()=>{
  const s=await setup();const empty=await s.supply(s.lender,60_000n);const other=await s.supply(s.other,40_000n);const id=await s.match(empty);
  await s.act('borrow',id,30_000n);expect(await s.decrypt((await s.pool.loanState(id)).debt)).to.equal(0);
  await expect(s.withdraw(s.stranger,other,40_000n)).to.be.revertedWithCustomError(s.pool,'NotLender');
  await ethers.provider.send('evm_setNextBlockTimestamp',[s.now+901]);await ethers.provider.send('evm_mine',[]);
  await s.pool.connect(s.other).withdrawAll(other);expect(await s.decrypt((await s.pool.positionState(other)).available,s.other)).to.equal(0);
  await s.pool.requestResolution(id);const h=await s.pool.resolutionHandle(id),proof=await fhevm.publicDecrypt([h]);await s.pool.finalizeResolution(id,true,proof.decryptionProof);
  await s.withdraw(s.lender,empty,1n);
 });
});
