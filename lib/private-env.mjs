import {parseEnv} from 'node:util';
import {promises as fs,constants,openSync,readFileSync,fstatSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateAzureInputs} from './launcher-identity.mjs';
const KEYS=['XANDER_AZURE_ENABLED','AZURE_OPENAI_ENDPOINT','AZURE_OPENAI_DEPLOYMENT','AZURE_OPENAI_API_KEY'];
const bad=()=>new Error('Private environment operation failed. Check file ownership, permissions and valid dotenv syntax. No values were logged.');
function trusted(stat,{privateMode=true}={}){return stat.isFile()&&stat.uid===process.getuid()&&stat.nlink===1&&stat.size<=65536&&(!privateMode||(stat.mode&0o077)===0);}
export function applyAzureEnvText(text,env){const parsed=parseEnv(text);for(const k of KEYS)if(!Object.hasOwn(env,k)&&Object.hasOwn(parsed,k))env[k]=parsed[k];return env;}
export function loadPrivateAzureEnv(path,env=process.env){let fd;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!trusted(stat))throw bad();const text=readFileSync(fd,'utf8');if(Buffer.byteLength(text)>65536)throw bad();applyAzureEnvText(text,env);return true;}catch(e){if(e.code==='ENOENT')return false;throw bad();}finally{if(fd!==undefined)closeSync(fd);}}
function encode(key,value){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))throw bad();for(const candidate of [value,"'"+value+"'",'"'+value+'"','`'+value+'`']){const line=key+'='+candidate+'\n',parsed=parseEnv(line);if(Object.keys(parsed).length===1&&parsed[key]===value)return line;}throw bad();}
export function updateEnvText(original,settings){const input=validateAzureInputs(settings.endpoint,settings.deployment);if(typeof settings.key!=='string'||settings.key.length<1||settings.key.length>4096||/[^\x21-\x7e]/.test(settings.key))throw new Error('Invalid key format; no file was changed.');const before=parseEnv(original),after={...before,XANDER_AZURE_ENABLED:'1',AZURE_OPENAI_ENDPOINT:input.endpoint,AZURE_OPENAI_DEPLOYMENT:input.deployment,AZURE_OPENAI_API_KEY:settings.key};const text='# Private local settings. Do not commit or share this file.\n'+Object.entries(after).map(([k,v])=>encode(k,v)).join('');const parsed=parseEnv(text);if(Object.keys(parsed).length!==Object.keys(after).length||Object.entries(after).some(([k,v])=>parsed[k]!==v)||Buffer.byteLength(text)>65536)throw bad();return text;}
export async function savePrivateAzureEnv(root,settings){
 const path=join(root,'.env');let original='',snapshot=null,handle,temp;
 // Ignore rules do not protect an already tracked file.
 let tracked=false;try{execFileSync('git',['ls-files','--error-unmatch','--','.env'],{cwd:root,stdio:'ignore'});tracked=true;}catch{}if(tracked)throw new Error('The .env file is already tracked by Git. Remove it from tracking yourself before saving credentials.');
 try{
  try{handle=await fs.open(path,constants.O_RDONLY|constants.O_NOFOLLOW);snapshot=await handle.stat();if(!trusted(snapshot,{privateMode:false}))throw bad();original=await handle.readFile('utf8');if(Buffer.byteLength(original)>65536)throw bad();}catch(e){if(e.code!=='ENOENT')throw e;}finally{await handle?.close();handle=null;}
  const text=updateEnvText(original,settings);
  const ignorePath=join(root,'.gitignore');let ignore='';try{const st=await fs.lstat(ignorePath);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid())throw bad();ignore=await fs.readFile(ignorePath,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}for(const pattern of ['.env','.env.*'])if(!ignore.split(/\r?\n/).includes(pattern))ignore+='\n'+pattern+'\n';await fs.writeFile(ignorePath,ignore);
  temp=join(root,'.env.xander-'+randomUUID()+'.tmp');handle=await fs.open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);await handle.writeFile(text);await handle.sync();await handle.close();handle=null;
  let current=null;try{current=await fs.lstat(path);}catch(e){if(e.code!=='ENOENT')throw e;}if(snapshot?(!current||current.ino!==snapshot.ino||current.mtimeMs!==snapshot.mtimeMs||current.size!==snapshot.size):current!==null)throw new Error('The .env file changed while saving. No overwrite was made. Run setup again.');
  await fs.rename(temp,path);temp=null;return{saved:true,mode:'0600',preservedUnrelatedSettings:true};
 }catch(e){if(e.message.startsWith('Invalid key')||e.message.startsWith('The .env'))throw e;throw bad();}finally{await handle?.close();if(temp)await fs.rm(temp,{force:true});}
}
