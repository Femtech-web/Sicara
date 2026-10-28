import type { DeployFunction } from "hardhat-deploy/types";
const deploy: DeployFunction = async ({deployments,getNamedAccounts,ethers,network}) => {
  if (network.name !== 'sepolia' || (await ethers.provider.getNetwork()).chainId !== 11155111n) throw new Error('Attested pilot deployment is Sepolia only');
  const {deployer}=await getNamedAccounts();
  const token=process.env.SICARA_TOKEN_ADDRESS;
  if (!token || !ethers.isAddress(token)) throw new Error('Configure the existing DemoZama token');
  const policy=ethers.id('sicara:test-only:demo-prices:50-percent:zero-interest:v1');
  const pool=await deployments.deploy('AttestedLoanPilot',{from:deployer,args:[token,deployer,policy],log:true});
  console.log(`Attested pilot: ${pool.address}. Liquidity funding is reconciled separately.`);
};
deploy.tags=['attested'];
export default deploy;
