import{execFileSync}from'node:child_process';import{readFileSync,readlinkSync,statSync,realpathSync}from'node:fs';import{fileURLToPath}from'node:url';import{validateAzureInputs,validateListener}from'../lib/launcher-identity.mjs';
const root=fileURLToPath(new URL('../',import.meta.url)).replace(/\/$/,'');
function inspect(){const lines=execFileSync('ss',['-H','-ltnp','sport = :4317'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});const processes={};for(const m of lines.matchAll(/pid=(\d+)/g)){const pid=Number(m[1]);processes[pid]={uid:statSync(`/proc/${pid}`).uid,cwd:readlinkSync(`/proc/${pid}/cwd`),executable:readlinkSync(`/proc/${pid}/exe`),argv:readFileSync(`/proc/${pid}/cmdline`).toString().split('\0').filter(Boolean)};}return validateListener({lines,uid:process.getuid(),root,processes,nodeExecutable:realpathSync(process.execPath)});}
try{
 if(process.argv[2]==='validate'){validateAzureInputs(process.env.XANDER_SETUP_ENDPOINT??'',process.env.XANDER_SETUP_DEPLOYMENT??'');console.log('Endpoint and deployment format accepted.');}
 else if(process.argv[2]==='inspect'){const pid=inspect();console.log(pid?`Verified same-user Xander listener on 127.0.0.1:4317 (PID ${pid}).`:'Port 4317 is available.');}
 else if(process.argv[2]==='stop'){
  const pid=inspect();if(pid){
   // Check identity a second time immediately before graceful signaling.
   if(inspect()!==pid)throw Error('Listener identity changed. Run setup again.');
   process.kill(pid,'SIGTERM');
   let stopped=false;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));try{process.kill(pid,0);}catch(e){if(e.code==='ESRCH'){stopped=true;break;}throw e;}}
   if(!stopped)throw Error('Xander did not stop within ten seconds. No forced termination was attempted.');
   if(inspect()!==null)throw Error('Another listener appeared. Setup stopped.');console.log('Stopped the verified Xander server gracefully. Storefront was not stopped.');
  }
 }else throw Error('Unsupported setup action.');
}catch(e){console.error(e.message.startsWith('Command failed')?'Cannot inspect port ownership. Check that ss is available and run setup in your local terminal.':e.code?'Cannot verify the listener identity; setup stopped without a forced shutdown.':e.message);process.exitCode=1;}
