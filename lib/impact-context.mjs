import {readFile} from 'node:fs/promises';
export function summarizeObservations(capture) {
 const groups=new Map();
 for(const r of (Array.isArray(capture?.records)?capture.records:[]).slice(0,2000)){
  let u;try{u=new URL(r.url);}catch{continue;}
  if(u.origin!=='http://127.0.0.1:3000'||!/^\/(api|rest)\//.test(u.pathname))continue;
  const path=u.pathname.split('/').map(p=>/^\d+$/.test(p)||/^[a-f0-9-]{16,}$/i.test(p)?':id':p).join('/');
  const method=['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD'].includes(r.method)?r.method:'UNKNOWN';
  const status=Number.isInteger(r.status)&&r.status>=100&&r.status<=599?r.status:null;
  const key=JSON.stringify([method,path,status]);const row=groups.get(key)||{method,path,status,count:0};row.count++;groups.set(key,row);
 }
 return [...groups.values()].sort((a,b)=>a.path.localeCompare(b.path)||a.method.localeCompare(b.method));
}
export function createImpactContextHandler({captureFile}){
 return async(req,res)=>{
  if(new URL(req.url,'http://localhost').pathname!=='/api/impact/context')return false;
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='GET'){res.writeHead(405);res.end(JSON.stringify({error:'Read-only endpoint.'}));return true;}
  let capture;try{const raw=await readFile(captureFile,'utf8');if(raw.length>8_000_000)throw Error();capture=JSON.parse(raw);}catch{}
  res.end(JSON.stringify({observations:summarizeObservations(capture),available:!!capture,provenance:{kind:'observed',file:'evidence/ordinary-capture-expanded.json',note:'Prior ordinary local browsing. Route occurrence does not prove internal dependencies, vulnerabilities, current health or complete coverage. Dynamic IDs and query values omitted.'}}));return true;
 };
}
