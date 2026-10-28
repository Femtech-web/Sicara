import type {DeployFunction} from 'hardhat-deploy/types';
const deploy:DeployFunction=async({deployments,getNamedAccounts,network,ethers})=>{
  if(network.name!=='sepolia'||(await ethers.provider.getNetwork()).chainId!==11155111n)throw new Error('Sepolia faucet only');
  const token=process.env.SICARA_TOKEN_ADDRESS;if(!token||!ethers.isAddress(token))throw new Error('Existing Demo ZAMA required');
  const {deployer}=await getNamedAccounts();
  const faucet=await deployments.deploy('DemoTokenFaucet',{from:deployer,args:[token],log:true});
  console.log(`Demo-token faucet: ${faucet.address}. Prefund separately; no mint authority is granted.`);
};
deploy.tags=['faucet'];export default deploy;
