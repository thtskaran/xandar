import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {extname,join} from 'node:path';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extract,LIMITS,fail} from './extract.mjs';
export const OFFICE_LIMITS={inputBytes:16*1024*1024,expandedBytes:32*1024*1024,memberBytes:16*1024*1024,archiveMembers:2048,sheets:32,workbookRows:50000,workbookCells:1000000,pdfPages:100,workerMemoryMiB:512,workerTimeoutMs:15000,outputBytes:32*1024*1024};
export async function extractDocument(name,buffer,{python='python3',timeoutMs=OFFICE_LIMITS.workerTimeoutMs}={}){
 const ext=extname(name).toLowerCase().slice(1);if(!['xlsx','docx','pdf'].includes(ext))return extract(name,buffer);
 if(buffer.length>LIMITS.fileBytes)throw fail('File exceeds 16 MiB.',413);
 const privateCwd=await mkdtemp(join(tmpdir(),'xander-extract-'));
 try{return await new Promise((resolve,reject)=>{
  let finished=false,size=0;const chunks=[];const child=spawn(python,['-I','-B',fileURLToPath(new URL('./office_worker.py',import.meta.url)),ext],{cwd:privateCwd,stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??'/usr/bin:/bin',LANG:'C.UTF-8',PYTHONNOUSERSITE:'1',OPENBLAS_NUM_THREADS:'1',OMP_NUM_THREADS:'1',NUMEXPR_NUM_THREADS:'1',MALLOC_ARENA_MAX:'2'}});
  const finish=(error,value)=>{if(finished)return;finished=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish(fail('Document extraction exceeded its 15-second time limit.',422));},Math.min(15000,Math.max(1,timeoutMs)));
  child.on('error',()=>finish(fail('Python document worker unavailable; check local extraction setup.',503)));
  child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>OFFICE_LIMITS.outputBytes){child.kill('SIGKILL');finish(fail('Extracted output exceeds 32 MiB.',422));}else chunks.push(chunk);});
  child.on('close',(code,signal)=>{if(finished)return;if(code!==0)return finish(fail(signal?'Document exceeded worker resource limits.':'Document worker failed.',422));let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return finish(fail('Document worker returned an invalid result.',422));}if(!result.ok)return finish(fail(result.message,result.code==='dependency_missing'?503:result.code==='limit'?422:400));finish(null,result.data);});
  child.stdin.end(buffer);
 });}finally{await rm(privateCwd,{recursive:true,force:true});}
}
