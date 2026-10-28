import type {DeployFunction} from 'hardhat-deploy/types';
const deploy:DeployFunction=async({deployments,getNamedAccounts,ethers})=>{
 const chain=Number((await ethers.provider.getNetwork()).chainId);
 if(![31337,11155111].includes(chain))throw new Error('Test networks only');
 const {deployer}=await getNamedAccounts();
 const token=await deployments.deploy('ConfidentialTestUSDC',{from:deployer,args:[deployer],log:true});
 const faucet=await deployments.deploy('ConfidentialTestUSDCFaucet',{contract:'DemoTokenFaucet',from:deployer,args:[token.address],log:true});
 if(faucet.newlyDeployed){const instance=await ethers.getContractAt('ConfidentialTestUSDC',token.address,await ethers.getSigner(deployer));await(await instance.mint(faucet.address,1_000n*1_000_000n)).wait();}
 console.log(`Valueless cUSDC: ${token.address}; separately funded faucet: ${faucet.address}. No collateral intake enabled.`);
};
deploy.tags=['cusdc'];export default deploy;
