import {expect} from 'chai';
import {ethers,fhevm} from 'hardhat';
import {FhevmType} from '@fhevm/hardhat-plugin';
import assert from 'node:assert/strict';

/** Counterexamples, not a new lending integration. Local FHEVM mock only. */
describe('Private collateral feasibility boundary (local counterexamples)',function(){
 before(function(){if(!fhevm.isMock)this.skip();});
 it('a valid encrypted input and operator signature do NOT establish any Zcash collateral or range-proof binding',async()=>{
  const [operator,borrower,stranger]=await ethers.getSigners();
  const token=await ethers.deployContract('DemoZama',[operator.address]);
  const policy=ethers.id('sicara:offline-feasibility-only');
  const pool=await ethers.deployContract('AttestedLoanPilot',[await token.getAddress(),operator.address,policy]);
  const encrypted=await fhevm.createEncryptedInput(await pool.getAddress(),borrower.address).add64(999_999_999n).encrypt();
  // No deposit exists. This arbitrary commitment is not linked to a Zcash note,
  // Halo2 proof, or the plaintext behind this valid Zama encrypted input.
  const authorization={loanId:ethers.hexlify(ethers.randomBytes(32)),borrower:borrower.address,
   depositCommitment:ethers.hexlify(ethers.randomBytes(32)),capacityInput:ethers.hexlify(encrypted.handles[0]),
   inputProofHash:ethers.keccak256(encrypted.inputProof),policyHash:policy,
   validUntil:(await ethers.provider.getBlock('latest'))!.timestamp+120};
  const types={CollateralAuthorization:[
   {name:'loanId',type:'bytes32'},{name:'borrower',type:'address'},{name:'depositCommitment',type:'bytes32'},
   {name:'capacityInput',type:'bytes32'},{name:'inputProofHash',type:'bytes32'},{name:'policyHash',type:'bytes32'},
   {name:'validUntil',type:'uint64'},
  ]};
  const domain={name:'SicaraCollateral',version:'1',chainId:(await ethers.provider.getNetwork()).chainId,verifyingContract:await pool.getAddress()};
  const wrong=await stranger.signTypedData(domain,types,authorization);
  await expect(pool.connect(borrower).registerAttestedLoan(authorization,encrypted.inputProof,wrong)).to.be.revertedWithCustomError(pool,'InvalidAuthorization');
  const signature=await operator.signTypedData(domain,types,authorization);
  await pool.connect(borrower).registerAttestedLoan(authorization,encrypted.inputProof,signature);
  const handle=(await pool.loanState(authorization.loanId)).capacity;
  expect(await fhevm.userDecryptEuint(FhevmType.euint64,handle,await pool.getAddress(),borrower)).to.equal(999_999_999n);
  await assert.rejects(fhevm.userDecryptEuint(FhevmType.euint64,handle,await pool.getAddress(),stranger));
  // Expected finding: current trusted attestation accepts the signer assertion.
  // An input ZKPoK proves well-formed encryption, NOT the external collateral fact.
 });
});
