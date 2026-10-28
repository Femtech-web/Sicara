import {expect} from 'chai';
import {ethers,fhevm} from 'hardhat';
import {time} from '@nomicfoundation/hardhat-network-helpers';
import {FhevmType} from '@fhevm/hardhat-plugin';

describe('DemoTokenFaucet (local mock)',function(){
  before(function(){if(!fhevm.isMock)this.skip();});
  it('delivers confidential test tokens, enforces cooldown and needs no mint authority',async()=>{
    const [operator,user]=await ethers.getSigners();
    const token=await ethers.deployContract('DemoZama',[operator.address]);
    const faucet=await ethers.deployContract('DemoTokenFaucet',[await token.getAddress()]);
    const drip=await faucet.DRIP();await token.mint(await faucet.getAddress(),drip*3n);
    await expect(faucet.connect(user).claim()).to.emit(faucet,'ClaimRequested').withArgs(user.address);
    expect(await fhevm.userDecryptEuint(FhevmType.euint64,await token.confidentialBalanceOf(user.address),await token.getAddress(),user)).to.equal(drip);
    await expect(faucet.connect(user).claim()).to.be.revertedWithCustomError(faucet,'Cooldown');
    await time.increase(86400);await faucet.connect(user).claim();
    expect(await fhevm.userDecryptEuint(FhevmType.euint64,await token.confidentialBalanceOf(user.address),await token.getAddress(),user)).to.equal(drip*2n);
    await expect(token.connect(user).mint(user.address,1)).to.be.revertedWithCustomError(token,'OwnableUnauthorizedAccount');
  });
  it('caps aggregate daily requests even across different accounts',async()=>{
    const [operator]=await ethers.getSigners();const token=await ethers.deployContract('DemoZama',[operator.address]);
    const faucet=await ethers.deployContract('DemoTokenFaucet',[await token.getAddress()]);
    await time.increaseTo((Math.floor(await time.latest()/86400)+1)*86400+1);
    const day=BigInt(await time.latest())/86400n;
    // Reach the exact budget with distinct ephemeral accounts; no fund transfer required.
    await token.mint(await faucet.getAddress(),await faucet.DAILY_BUDGET());
    for(let i=0;i<100;i++){
      const wallet=ethers.Wallet.createRandom().connect(ethers.provider);
      await operator.sendTransaction({to:wallet.address,value:ethers.parseEther('0.1')});
      await faucet.connect(wallet).claim();
    }
    expect(await faucet.requestedPerDay(day)).to.equal(await faucet.DAILY_BUDGET());
    await expect(faucet.claim()).to.be.revertedWithCustomError(faucet,'DailyLimit');
  });
  it('does not pretend a depleted faucet paid a request',async()=>{
    const [operator,user]=await ethers.getSigners();const token=await ethers.deployContract('DemoZama',[operator.address]);
    const faucet=await ethers.deployContract('DemoTokenFaucet',[await token.getAddress()]);
    await faucet.connect(user).claim();
    expect(await fhevm.userDecryptEuint(FhevmType.euint64,await token.confidentialBalanceOf(user.address),await token.getAddress(),user)).to.equal(0n);
    expect(await faucet.nextClaimAt(user.address)).to.be.greaterThan(await time.latest());
  });
});
