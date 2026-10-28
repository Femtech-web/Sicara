import {ethers,fhevm,network,deployments} from 'hardhat';
import {config as loadEnv} from 'dotenv';
import {readFile,mkdir,open,rename} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {FhevmType} from '@fhevm/hardhat-plugin';
import type {Hex} from 'viem';
import {connectWorker} from '../../services/database/worker-connection';
import {AuthorizationRepository,DEMO_POLICY} from '../../services/issuance/authorization-repository';
import {IssuanceTransactions} from '../../services/issuance/transaction-repository';
import {TestnetWallet} from '../../services/zcash/sidecar-client';
import {SidecarWorkerWallet} from '../../services/zcash/worker-wallet';
import {OperationJournal} from '../../services/zcash/operation-journal';
import {CollateralWorker} from '../../services/zcash/collateral-worker';
import {LoanRepository} from '../../src/features/lending/server/loan-repository';

const root=resolve(__dirname,'../..');
let checkpoint='startup';
async function durable(path:string,value:unknown) {
  const dir=resolve(path,'..'); await mkdir(dir,{recursive:true,mode:0o700});
  const temp=`${path}.${randomUUID()}.tmp`; const file=await open(temp,'wx',0o600);
  try {await file.writeFile(JSON.stringify(value,null,2));await file.sync();}finally{await file.close();}
  await rename(temp,path);const directory=await open(dir,'r');try{await directory.sync();}finally{await directory.close();}
}
async function readOptional(path:string) {
  try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
async function main() {
  if(network.name!=='sepolia'||(await ethers.provider.getNetwork()).chainId!==11155111n)throw new Error('Sepolia only');
  loadEnv({path:resolve(root,'.env'),quiet:true});loadEnv({path:resolve(root,'.env.local'),override:true,quiet:true});
  process.chdir(root);
  await fhevm.initializeCLIApi();if(fhevm.isMock)throw new Error('Live FHE required');
  const step=process.env.SICARA_ISSUANCE_STEP??'verify';
  if(!['prepare','register','borrow','recover-borrow','verify','fund','fund-faucet','claim-faucet'].includes(step))throw new Error('Invalid issuance step');
  const [signer]=await ethers.getSigners();
  if(!signer || !process.env.SEPOLIA_PRIVATE_KEY || !process.env.DATABASE_WORKER_URL)throw new Error('Local test signer/database required');
  const rawSigner=new ethers.Wallet(process.env.SEPOLIA_PRIVATE_KEY,ethers.provider);
  const deployment=await deployments.get('AttestedLoanPilot');
  checkpoint='deployment-validation';
  const pool=await ethers.getContractAt('AttestedLoanPilot',deployment.address,signer);
  const token=await ethers.getContractAt('DemoZama',await pool.token(),signer);
  if((await pool.owner()).toLowerCase()!==signer.address.toLowerCase() || await pool.policyHash()!==DEMO_POLICY)throw new Error('Attestor/policy mismatch');
  const evidence=JSON.parse(await readFile(resolve(root,'.local/evidence/attested-collateral.json'),'utf8'));
  if(evidence.stage!=='collateral_ready'||evidence.wallet.toLowerCase()!==signer.address.toLowerCase()||evidence.amount!=='10000')throw new Error('Confirmed synthetic collateral proof required');
  const controller=new AbortController();const stop=()=>controller.abort();
  // HardhatEthersProvider does not implement waitForTransaction. Poll exact hashes
  // with bounded waits instead; RPC/coprocessor lag never creates a new intent.
  async function waitReceipt(hash:string,confirmations:number) {
    for(let attempt=0;attempt<60;attempt++) {
      if(controller.signal.aborted)throw new Error('Stopped');
      const found=await ethers.provider.getTransactionReceipt(hash);
      if(found && (found.status===0 || await found.confirmations()>=confirmations))return found;
      if(attempt%6===0)console.log(`Waiting for ${confirmations} Sepolia confirmations (${attempt+1}/60)`);
      await new Promise<void>(resolve=>{
        const finish=()=>{clearTimeout(timer);controller.signal.removeEventListener('abort',finish);resolve();};
        const timer=setTimeout(finish,5000);controller.signal.addEventListener('abort',finish,{once:true});
      });
    }
    return null;
  }
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const connection=await connectWorker(process.env.DATABASE_WORKER_URL,stop);
  checkpoint='database-connected';
  let wallet:TestnetWallet|undefined;
  try {
    const db=connection.database;const repository=new AuthorizationRepository(db);const transactions=new IssuanceTransactions(db);
    const walletDir=resolve('.local/zcash/wallet');const journal=new OperationJournal(join(walletDir,'sicara-operations'));
    const artifact=resolve('.local/evidence/attested-issuance.json');
    const local=await readOptional(artifact)??{loanId:evidence.loanId,pool:deployment.address,transactions:{}};
    if(local.loanId!==evidence.loanId||local.pool!==deployment.address)throw new Error('Evidence identity mismatch');
    // Shared database session lock prevents competing operator sends in this tool.
    // Protect restore: every local issuance must still have its SQL authorization.
    for(const key of await journal.keys())if(key.startsWith('issuance-'))await repository.get(key.slice(9));

    if(step==='prepare') {
      wallet=await TestnetWallet.start({binary:resolve('.local/zcash/bin/zec-sidecar'),dataDir:walletDir,signal:controller.signal});
      const gateway=new SidecarWorkerWallet(wallet,resolve('.local/zcash/native-target/release/sicara-address-check'));
      const worker=new CollateralWorker(db,gateway,journal);await worker.initialize();await worker.tick();
      let row=await repository.reserve(evidence.loanId,deployment.address,120);
      await journal.bind(`issuance-${row.loan_id}`,{kind:'issuance',loan:row.loan_id,pool:row.pool,commitment:row.deposit_commitment});
      if(row.state==='reserved') {
        const encrypted=await fhevm.createEncryptedInput(deployment.address,signer.address).add64(BigInt(row.capacity_units)).encrypt();
        await repository.prepare(row.loan_id,ethers.hexlify(encrypted.handles[0]) as Hex,ethers.hexlify(encrypted.inputProof) as Hex);
        row=await repository.get(row.loan_id);
      }
      if(row.state==='prepared') {
        const typed=repository.typedData(row);
        const signature=await signer.signTypedData(typed.domain,JSON.parse(JSON.stringify(typed.types)),typed.message);
        await repository.saveSignature(row.loan_id,signature as Hex,signer.address);
      }
      row=await repository.get(row.loan_id);local.chainLoanId=row.chain_loan_id;local.validUntil=row.valid_until;
      await durable(artifact,local);console.log('Authorization persisted; collateral frozen; acceptance window 120 seconds.');return;
    }

    // Liquidity funding is isolated from collateral authorization and uses the same
    // signed-byte-before-broadcast discipline; never re-mint from a missing response.
    if(step==='fund'||step==='fund-faucet') {
      checkpoint='liquidity-packet';
      const recipient=step==='fund-faucet'?(await deployments.get('DemoTokenFaucet')).address:deployment.address;
      const file=resolve(step==='fund-faucet'?'.local/issuance/faucet-liquidity.json':'.local/issuance/attested-liquidity.json');let packet=await readOptional(file);
      const data=token.interface.encodeFunctionData('mint',[recipient,(step==='fund-faucet'?10_000n:1_000_000n)*100_000_000n]);
      if(!packet){const raw=await rawSigner.signTransaction(await rawSigner.populateTransaction({to:await token.getAddress(),data,gasLimit:1_000_000n}));packet={raw,hash:ethers.keccak256(raw)};await durable(file,packet);}
      const parsed=ethers.Transaction.from(packet.raw);
      if(parsed.to?.toLowerCase()!==(await token.getAddress()).toLowerCase()||parsed.data!==data||parsed.from?.toLowerCase()!==signer.address.toLowerCase()||parsed.chainId!==11155111n)throw new Error('Liquidity packet mismatch');
      let receipt=await ethers.provider.getTransactionReceipt(packet.hash);
      checkpoint='liquidity-receipt';
      if(!receipt){try{await ethers.provider.broadcastTransaction(packet.raw);}catch{/* reconcile exact known hash */}receipt=await waitReceipt(packet.hash,3);}
      if(!receipt||receipt.status!==1)throw new Error('Liquidity unconfirmed; preserve signed packet');
      if(step==='fund-faucet')local.faucetLiquidityTx=packet.hash;else local.liquidityTx=packet.hash;
      await durable(artifact,local);console.log(`Demo liquidity funding confirmed: ${packet.hash}`);return;
    }

    if(step==='claim-faucet') {
      checkpoint='faucet-claim';
      const faucet=await ethers.getContractAt('DemoTokenFaucet',(await deployments.get('DemoTokenFaucet')).address,signer);
      const file=resolve('.local/issuance/faucet-claim.json');let packet=await readOptional(file);
      const data=faucet.interface.encodeFunctionData('claim');
      if(!packet) {
        const gasLimit=(await rawSigner.estimateGas({to:await faucet.getAddress(),data}))*12n/10n+100_000n;
        if(gasLimit>25_000_000n)throw new Error('Estimated gas exceeds test limit');
        const raw=await rawSigner.signTransaction(await rawSigner.populateTransaction({to:await faucet.getAddress(),data,gasLimit}));
        packet={raw,hash:ethers.keccak256(raw)};await durable(file,packet);
      }
      const parsed=ethers.Transaction.from(packet.raw);
      if(parsed.to?.toLowerCase()!==(await faucet.getAddress()).toLowerCase()||parsed.data!==data||parsed.from?.toLowerCase()!==signer.address.toLowerCase()||parsed.chainId!==11155111n)throw new Error('Faucet claim packet mismatch');
      let receipt=await ethers.provider.getTransactionReceipt(packet.hash);
      if(!receipt){try{await ethers.provider.broadcastTransaction(packet.raw);}catch{/* reconcile exact known hash */}receipt=await waitReceipt(packet.hash,3);}
      if(!receipt||receipt.status!==1)throw new Error('Faucet claim unconfirmed; preserve signed packet');
      let delta:bigint|undefined;
      for(let i=0;i<12;i++) {
        try {
          const before=await fhevm.userDecryptEuint(FhevmType.euint64,await token.confidentialBalanceOf(signer.address,{blockTag:receipt.blockNumber-1}),await token.getAddress(),signer);
          const after=await fhevm.userDecryptEuint(FhevmType.euint64,await token.confidentialBalanceOf(signer.address,{blockTag:receipt.blockNumber}),await token.getAddress(),signer);
          delta=after-before;if(delta===1_000_000_000n)break;
        }catch{/* coprocessor/KMS readiness */}
        await new Promise(resolve=>setTimeout(resolve,5000));
      }
      if(delta!==1_000_000_000n)throw new Error('Actual faucet receipt not verified');
      local.faucetAddress=await faucet.getAddress();local.faucetClaimTx=packet.hash;local.faucetClaimVerified=true;await durable(artifact,local);
      console.log(`Faucet delivered/decrypted 10 Demo ZAMA: ${packet.hash}`);return;
    }

    let row=await repository.get(evidence.loanId);
    checkpoint='collateral-refresh';
    wallet=await TestnetWallet.start({binary:resolve('.local/zcash/bin/zec-sidecar'),dataDir:walletDir,signal:controller.signal});
    const gateway=new SidecarWorkerWallet(wallet,resolve('.local/zcash/native-target/release/sicara-address-check'));
    const guardedWorker=new CollateralWorker(db,gateway,journal);await guardedWorker.initialize();
    // Refresh this collateral before any new effect, without processing other loans' refunds.
    const collateral=await gateway.scan();
    const loanRepository=new LoanRepository(db);
    await loanRepository.observe(row.loan_id,collateral);
    if(step==='recover-borrow') {
      checkpoint='confirmed-revert-recovery';
      const failed=await transactions.get(row.loan_id,'borrow');
      if(!failed || failed.state==='confirmed')throw new Error('No failed borrow to recover');
      const receipt=await ethers.provider.getTransactionReceipt(failed.tx_hash);
      const canonical=receipt?await ethers.provider.getBlock(receipt.blockNumber):null;
      if(!receipt||receipt.status!==0||await receipt.confirmations()<12||canonical?.hash!==receipt.blockHash)throw new Error('Canonical reverted receipt with twelve confirmations required');
      const loan=await loanRepository.find(row.wallet,row.loan_id);
      const notes=collateral.notes.filter(note=>note.address===loan.deposit_address);
      if(collateral.stale||notes.some(note=>note.height===null||collateral.tip-note.height+1<10)||notes.reduce((sum,note)=>sum+note.zatoshis,0n)!==BigInt(loan.required_zatoshis))throw new Error('Collateral recovery requires exact fresh confirmed principal');
      const latest=await pool.loanState(row.chain_loan_id);
      if(latest.borrower.toLowerCase()!==row.wallet||!(await pool.consumedDeposit(row.deposit_commitment))||latest.settled)throw new Error('Registered collateral binding changed');
      const debt=await fhevm.userDecryptEuint(FhevmType.euint64,latest.debt,deployment.address,signer);
      const borrowed=await fhevm.userDecryptEbool(latest.borrowed,deployment.address,signer);
      if(debt!==0n||borrowed)throw new Error('Cannot retry an already issued loan');
      await transactions.failedBorrow(row.loan_id,failed.tx_hash,receipt.blockNumber,receipt.blockHash as Hex);
      await db.transaction(async sql=>{
        await sql.query('SELECT id FROM sicara.loans WHERE id=$1 FOR UPDATE',[row.loan_id]);
        await sql.query("UPDATE sicara.collateral_authorizations SET state='registered' WHERE loan_id=$1 AND state IN ('registered','review')",[row.loan_id]);
        await sql.query("UPDATE sicara.loans SET state='issuance_registered' WHERE id=$1 AND state IN ('issuance_review','issuance_registered')",[row.loan_id]);
      });
      row=await repository.get(row.loan_id);
    }
    const state=await db.query<{state:string}>('SELECT state FROM sicara.loans WHERE id=$1',[row.loan_id]);
    if(state.rows[0]?.state==='issuance_review'||row.state==='review')throw new Error('Issuance requires review');
    if(!row.signature||!row.input_proof)throw new Error('Signed capacity required');
    async function receipt(stage:'register'|'borrow',data?:string) {
      let intent=await transactions.get(row.loan_id,stage);
      const attempt=intent?.state==='failed'?intent.attempt+1:intent?.attempt??1;
      if(intent?.state==='failed') {
        if(stage!=='borrow'||step!=='recover-borrow')throw new Error('Explicit confirmed-revert recovery required');
        intent=undefined;
      }
      const file=resolve(`.local/issuance/${row.loan_id}-${stage}${attempt===1?'':`-${attempt}`}.json`);const saved=await readOptional(file);
      if(saved && (!intent || saved.hash!==intent.tx_hash || saved.raw!==intent.raw_transaction))throw new Error('Transaction backup/database mismatch; review before sending');
      if(!intent) {
        if(!data || step!==stage && !(step==='recover-borrow'&&stage==='borrow'))throw new Error('No transaction exists for verification');
        if(stage==='register' && Number(row.valid_until)<=Date.now()/1000)throw new Error('Authorization expired; reconcile instead of resigning/refunding');
        const estimate=await rawSigner.estimateGas({to:deployment.address,data});
        const gasLimit=estimate*12n/10n+100_000n;
        if(gasLimit>25_000_000n)throw new Error('Estimated gas exceeds test limit');
        const raw=await rawSigner.signTransaction(await rawSigner.populateTransaction({to:deployment.address,data,gasLimit}));
        intent=await transactions.prepare(row.loan_id,stage,raw as Hex,data as Hex);
        await durable(file,{hash:intent.tx_hash,raw:intent.raw_transaction});
      } else if(data && ethers.Transaction.from(intent.raw_transaction).data!==data)throw new Error('Saved call differs from persisted authorization');
      if(!saved)await durable(file,{hash:intent.tx_hash,raw:intent.raw_transaction});
      const transaction=ethers.Transaction.from(intent.raw_transaction);
      if(transaction.to?.toLowerCase()!==row.pool||transaction.from?.toLowerCase()!==row.wallet||transaction.chainId!==11155111n||transaction.value!==0n||transaction.hash!==intent.tx_hash)throw new Error('Saved transaction invalid');
      let mined=await ethers.provider.getTransactionReceipt(intent.tx_hash);
      if(!mined) {
        if(intent.state==='confirmed'||step==='verify'){await repository.review(row.loan_id);throw new Error('Confirmed receipt disappeared');}
        // Identical signed bytes have the same nonce/hash. No replacement transaction.
        try{await ethers.provider.broadcastTransaction(intent.raw_transaction);}catch{/* outcome unknown; inspect known hash */}
        mined=await waitReceipt(intent.tx_hash,12);
      } else if(await mined.confirmations()<12)mined=await waitReceipt(intent.tx_hash,12);
      if(!mined||mined.status!==1){if(mined)await repository.review(row.loan_id);throw new Error('Transaction unconfirmed/failed; reconcile existing hash');}
      const canonical=await ethers.provider.getBlock(mined.blockNumber);
      if(canonical?.hash!==mined.blockHash||intent.block_hash&&intent.block_hash!==mined.blockHash){await repository.review(row.loan_id);throw new Error('Receipt reorganized');}
      await transactions.confirm(row.loan_id,stage,intent.tx_hash,mined.blockNumber,mined.blockHash as Hex);
      local.transactions[stage]=intent.tx_hash;await durable(artifact,local);
      return mined;
    }
    const typed=repository.typedData(row).message;
    const registerData=pool.interface.encodeFunctionData('registerAttestedLoan',[typed,row.input_proof,row.signature]);
    checkpoint='register-receipt';
    const registration=await receipt('register',registerData);
    const registered=await pool.loanState(row.chain_loan_id,{blockTag:registration.blockNumber});
    if(registered.borrower.toLowerCase()!==row.wallet||!(await pool.consumedDeposit(row.deposit_commitment,{blockTag:registration.blockNumber})))throw new Error('Contract registration binding mismatch');
    await db.transaction(async sql=>{
      await sql.query('SELECT id FROM sicara.loans WHERE id=$1 FOR UPDATE',[row.loan_id]);
      await sql.query("UPDATE sicara.collateral_authorizations SET state='registered',registration_tx=$2,registration_block=$3,registration_block_hash=$4 WHERE loan_id=$1 AND state IN ('signed','registered')",[row.loan_id,registration.hash,registration.blockNumber,registration.blockHash]);
      await sql.query("UPDATE sicara.loans SET state='issuance_registered' WHERE id=$1 AND state IN ('issuance_pending','issuance_registered')",[row.loan_id]);
    });
    if(step==='register'){console.log(`Attested registration confirmed; stopped for restart: ${registration.hash}`);return;}
    row=await repository.get(row.loan_id);
    let borrowData:string|undefined;
    const previousBorrow=await transactions.get(row.loan_id,'borrow');
    if((step==='borrow'||step==='recover-borrow')&&(!previousBorrow||previousBorrow.state==='failed')) {
      const encrypted=await fhevm.createEncryptedInput(deployment.address,signer.address).add64(250_000n).encrypt();
      borrowData=pool.interface.encodeFunctionData('borrow',[row.chain_loan_id,encrypted.handles[0],encrypted.inputProof]);
    }
    const issued=await receipt('borrow',borrowData);
    checkpoint='borrower-decryption';
    // Only the synthetic borrower decrypts its own debt/balance. Operator and
    // borrower deliberately share this dedicated TEST signer, not production roles.
    let verified=false;
    for(let i=0;i<12;i++) {
      try {
        const debt=await fhevm.userDecryptEuint(FhevmType.euint64,(await pool.loanState(row.chain_loan_id,{blockTag:issued.blockNumber})).debt,deployment.address,signer);
        const balance=await fhevm.userDecryptEuint(FhevmType.euint64,await token.confidentialBalanceOf(signer.address,{blockTag:issued.blockNumber}),await token.getAddress(),signer);
        if(debt===250_000n&&balance===250_000n){verified=true;break;}
      }catch{/* wait for coprocessor/KMS */}
      if(controller.signal.aborted)throw new Error('Stopped');
      await new Promise(resolve=>setTimeout(resolve,5000));
    }
    if(!verified)throw new Error('Borrower decryption not verified; do not issue again');
    local.borrowerVerified=true;local.borrowUnits='250000';local.capacityUnits=row.capacity_units;local.completed=true;
    await durable(artifact,local);console.log(`Real deposit-derived confidential borrowing verified; ${issued.hash}`);
  }finally{await wallet?.close();await connection.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
void main().catch((error:unknown)=>{
  const code=error && typeof error==='object' && 'code' in error ? String(error.code) : 'CHECK_FAILED';
  const safeMessages=new Set(['Authorization expired; reconcile instead of resigning/refunding','Issuance requires review','Contract registration binding mismatch','Transaction unconfirmed/failed; reconcile existing hash','Receipt reorganized','Borrower decryption not verified; do not issue again','Transaction backup/database mismatch; review before sending','Saved call differs from persisted authorization','Saved transaction invalid','Receipt changed; review required','No transaction exists for verification']);
  if(error instanceof Error && safeMessages.has(error.message))console.error(error.message);
  if(error instanceof Error)console.error(error.stack?.split('\n').filter(line=>/^\s+at .*(attested-issuance|transaction-repository|authorization-repository)\.ts:\d+/.test(line)).slice(0,2).join('\n')??'');
  console.error(`Attested issuance stopped at ${checkpoint} (${/^[A-Z0-9_]+$/.test(code)?code:'CHECK_FAILED'}). Preserve SQL, wallet journal and signed packets; reconcile existing hashes. No credentials were logged.`);process.exitCode=1;
});
