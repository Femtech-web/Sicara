import type { DeployFunction } from "hardhat-deploy/types";
const deploy: DeployFunction = async ({ deployments, getNamedAccounts, ethers, network }) => {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  if (![31337, 11155111].includes(chainId)) throw new Error("Only local development and Sepolia are supported.");
  const { deployer } = await getNamedAccounts();
  if (!deployer) throw new Error("Configure a dedicated funded Sepolia test account locally.");
  const token = await deployments.deploy("DemoZama", { from: deployer, args: [deployer], log: true });
  const pool = await deployments.deploy("ConfidentialLoanSpike", { from: deployer, args: [token.address, deployer], log: true });
  if (pool.newlyDeployed) {
    const instance = await ethers.getContractAt("DemoZama", token.address, await ethers.getSigner(deployer));
    await (await instance.mint(pool.address, 1_000_000n * 100_000_000n)).wait();
  }
  console.log(`${network.name}: spike deployed; no Zcash integration is enabled.`);
};
deploy.tags = ["spike"];
export default deploy;
