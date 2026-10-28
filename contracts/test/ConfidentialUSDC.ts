import {expect} from 'chai';
import assert from 'node:assert/strict';
import {ethers,fhevm} from 'hardhat';
import {FhevmType} from '@fhevm/hardhat-plugin';
describe('Sicara cUSDC (valueless six-decimal test token)',function(){
 before(function(){if(!fhevm.isMock)this.skip();});
 it('funds a decimal-correct faucet and completes confidential borrowing and repayment in an isolated pool',async()=>{
  const [operator,borrower,stranger]=await ethers.getSigners();
  const token=await ethers.deployContract('ConfidentialTestUSDC',[operator.address]);
  expect(await token.decimals()).to.equal(6);
  const faucet=await ethers.deployContract('DemoTokenFaucet',[await token.getAddress()]);
  expect(await faucet.DRIP()).to.equal(10_000_000);
  expect(await faucet.DAILY_BUDGET()).to.equal(1_000_000_000);
  await token.mint(await faucet.getAddress(),1_000_000_000);
  await faucet.connect(borrower).claim();
  expect(await fhevm.userDecryptEuint(FhevmType.euint64,await token.confidentialBalanceOf(borrower.address),await token.getAddress(),borrower)).to.equal(10_000_000);
  await expect(faucet.connect(borrower).claim()).to.be.revertedWithCustomError(faucet,'Cooldown');
  const now=(await ethers.provider.getBlock('latest'))!.timestamp;
  const pool=await ethers.deployContract('TimedCommonCeilingLoanProbe',[await token.getAddress(),operator.address,100_000,now+600,now+900]);
  const address=await pool.getAddress();await token.mint(address,1_000_000);
  expect(await pool.commonCeiling()).to.equal(50_000); // $0.05, not 5 cUSDC.
  const h=()=>ethers.hexlify(ethers.randomBytes(32));
  const e={loanId:h(),borrower:borrower.address,claim:h(),custodyKey:h(),root:h(),snapshotBlock:h(),snapshotHeight:1000,proofHash:h(),validUntil:now+110};
  const fields=[['loanId','bytes32'],['borrower','address'],['claim','bytes32'],['custodyKey','bytes32'],['root','bytes32'],['snapshotBlock','bytes32'],['snapshotHeight','uint64'],['proofHash','bytes32'],['validUntil','uint64']].map(([name,type])=>({name,type}));
  await pool.connect(borrower).registerEligibleLoan(e,await operator.signTypedData({name:'SicaraCommonCeiling',version:'1',chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:address},{Eligibility:fields},e));
  const input=await fhevm.createEncryptedInput(address,borrower.address).add64(25_000).encrypt();
  await pool.connect(borrower).borrow(e.loanId,input.handles[0],input.inputProof);
  const debt=(await pool.loanState(e.loanId)).debt;
  expect(await fhevm.userDecryptEuint(FhevmType.euint64,debt,address,borrower)).to.equal(25_000);
  await assert.rejects(()=>fhevm.userDecryptEuint(FhevmType.euint64,debt,address,stranger));
  await token.connect(borrower).setOperator(address,now+500);
  const repayment=await fhevm.createEncryptedInput(address,borrower.address).add64(25_000).encrypt();
  await pool.connect(borrower).repay(e.loanId,repayment.handles[0],repayment.inputProof);
  await pool.connect(borrower).requestSettlement(e.loanId);
  const proof=await fhevm.publicDecrypt([(await pool.loanState(e.loanId)).settlementHandle]);
  await pool.finalizeSettlement(e.loanId,true,proof.decryptionProof);
  expect((await pool.loanState(e.loanId)).settled).to.equal(true);
 });
});
