/** Read-only live deployment check. Never requests mint/claim or prints secrets. */
import {ethers,deployments,network} from 'hardhat';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
async function main() {
 if(network.name!=='sepolia'||(await ethers.provider.getNetwork()).chainId!==11155111n)throw new Error('Sepolia only');
 const tokenDeployment=await deployments.get('ConfidentialTestUSDC');
 const faucetDeployment=await deployments.get('ConfidentialTestUSDCFaucet');
 const token=await ethers.getContractAt('ConfidentialTestUSDC',tokenDeployment.address);
 const faucet=await ethers.getContractAt('DemoTokenFaucet',faucetDeployment.address);
 const tokenCode=await ethers.provider.getCode(tokenDeployment.address),faucetCode=await ethers.provider.getCode(faucetDeployment.address);
 if(tokenCode==='0x'||faucetCode==='0x'||await token.decimals()!==6n||await token.symbol()!=='cUSDC'||(await faucet.token()).toLowerCase()!==tokenDeployment.address.toLowerCase()||await faucet.DRIP()!==10_000_000n||await faucet.DAILY_BUDGET()!==1_000_000_000n)throw new Error('Wrong token/faucet configuration');
 for(const deployment of [tokenDeployment,faucetDeployment]){
  if(!deployment.transactionHash)throw new Error('Missing deployment transaction');
  const receipt=await ethers.provider.getTransactionReceipt(deployment.transactionHash);
  if(!receipt||receipt.status!==1||(await ethers.provider.getBlock(receipt.blockNumber))?.hash!==receipt.blockHash)throw new Error('Deployment is not canonical');
 }
 const report={network:'sepolia',token:tokenDeployment.address,faucet:faucetDeployment.address,decimals:6,dripTokens:10,tokenCodeHash:ethers.keccak256(tokenCode),faucetCodeHash:ethers.keccak256(faucetCode),configurationVerified:true,actualClaimDeliveryVerified:false,collateralLoanVerified:false,disclosure:'Self-issued valueless test asset; not Circle USDC, a wrapper or a redeemable reserve claim.'};
 const directory=resolve('../.local/evidence');await mkdir(directory,{recursive:true,mode:0o700});await writeFile(resolve(directory,'cusdc-deployment.json'),JSON.stringify(report,null,2),{mode:0o600});
 console.log(JSON.stringify(report,null,2));
}
void main().catch(()=>{console.error('cUSDC deployment check failed; no transaction requested.');process.exitCode=1;});
