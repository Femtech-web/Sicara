/** Build a separate budget-limited funding helper; never opens a wallet. */
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,readdir,rm,open,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
const root=resolve(import.meta.dirname,'..');
const upstream=resolve(process.argv[2]??process.env.SICARA_ZCASH_SOURCE??join(root,'.local/zcash/upstream'));
const commit='0767b30f645be6e7083c1f4e3cb01c19728f1ef9';
if(execFileSync('git',['-C',upstream,'rev-parse','HEAD'],{encoding:'utf8'}).trim()!==commit||execFileSync('git',['-C',upstream,'status','--porcelain'],{encoding:'utf8'}).trim())throw new Error('Pristine pinned upstream checkout required');
const patch=join(root,'services/zcash/patches/isolated-funding-budget.patch');
const scratch=await mkdtemp(join(tmpdir(),'sicara-funder-source-'));
const source=join(root,'.local/zcash/isolated-funder-src');
const hash=async(file)=>createHash('sha256').update(await readFile(file)).digest('hex');
async function files(directory,prefix=''){
 const result=[];
 for(const entry of await readdir(join(directory,prefix),{withFileTypes:true})){
  const path=join(prefix,entry.name);
  if(entry.isDirectory())result.push(...await files(directory,path));
  else if(entry.isFile())result.push(path);
  else throw new Error('Unexpected link in funder source');
 }
 return result.sort();
}
try{
 const expected=join(scratch,'source');
 await cp(join(upstream,'zec-sidecar'),expected,{recursive:true,filter:path=>!path.split('/').includes('target')});
 execFileSync('git',['apply','--check',patch],{cwd:expected,stdio:'inherit'});
 execFileSync('git',['apply',patch],{cwd:expected,stdio:'inherit'});
 let exists=true;try{await readdir(source);}catch(error){if(error.code!=='ENOENT')throw error;exists=false;}
 if(!exists){await mkdir(dirname(source),{recursive:true,mode:0o700});await cp(expected,source,{recursive:true});}
 const expectedFiles=await files(expected),actualFiles=await files(source);
 if(JSON.stringify(expectedFiles)!==JSON.stringify(actualFiles))throw new Error('Unexpected isolated source files; do not overwrite modified code');
 for(const file of expectedFiles)if(await hash(join(expected,file))!==await hash(join(source,file)))throw new Error('Isolated source differs from pinned source plus reviewed budget patch');
 const target=join(root,'.local/privacy-native-target');
 execFileSync('cargo',['build','--offline','--locked','--release','-j','2','--manifest-path',join(source,'Cargo.toml'),'--target-dir',target],{cwd:root,stdio:'inherit',env:{PATH:process.env.PATH,HOME:process.env.HOME,CARGO_HOME:process.env.CARGO_HOME,CARGO_PROFILE_RELEASE_DEBUG:'0',RAYON_NUM_THREADS:'2'}});
 const report={version:1,commit,binarySha256:await hash(join(target,'release/zec-sidecar')),patchSha256:await hash(patch),maximumDebitZats:1_000_000,sourceWalletUnchanged:true,note:'Dedicated isolated funding binary; never replaces original custody sidecar.'};
 const destination=join(root,'.local/zcash/isolated-funder-build.json'),temporary=`${destination}.${randomUUID()}.tmp`;
 const file=await open(temporary,'wx',0o600);try{await file.writeFile(JSON.stringify(report,null,2));await file.sync();}finally{await file.close();}
 await rename(temporary,destination);const parent=await open(dirname(destination),'r');try{await parent.sync();}finally{await parent.close();}
 console.log('Dedicated testnet funding helper verified and built. No wallet opened or transaction sent.');
}finally{await rm(scratch,{recursive:true,force:true});}
