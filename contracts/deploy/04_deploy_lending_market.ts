import type {DeployFunction} from 'hardhat-deploy/types';
const deploy:DeployFunction=async({deployments,getNamedAccounts,ethers})=>{
 if(![31337n,11155111n].includes((await ethers.provider.getNetwork()).chainId))throw new Error('Test networks only');
 const {deployer}=await getNamedAccounts();const token=await deployments.get('ConfidentialTestUSDC');
 const previous=await deployments.getOrNull('MatchedLendingPool');
 if(previous){const pool=await ethers.getContractAt('MatchedLendingPool',previous.address);if((await pool.token()).toLowerCase()!==token.address.toLowerCase()||await pool.interestBps()!==200n)throw new Error('Existing market differs; do not overwrite');console.log(`Existing market ${previous.address}; no redeployment.`);return;}
 const now=(await ethers.provider.getBlock('latest'))!.timestamp;
 await deployments.deploy('MatchedLendingPool',{from:deployer,args:[token.address,deployer,100_000,now+24*3600,now+26*3600,200],log:true});
};
deploy.tags=['lending-market'];export default deploy;
