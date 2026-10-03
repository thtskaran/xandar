import {createLayaAdvisoryHandler} from './lib/laya-advisory.mjs';
import './lib/load-private-env.mjs';
import {createWorkspaceOrchestratorV2} from './lib/workspace-orchestrator-v2.mjs';
import {createSourceContextBuilder} from './lib/workspace-context-v2.mjs';
import {createRemediationReviewer} from './lib/remediation.mjs';
import {createRemediationHandler} from './lib/remediation-handler.mjs';
import {createAzureProposalGenerator} from './lib/azure-remediation.mjs';
import {azureConfiguration} from './lib/azure-knowledge.mjs';
import {createWorkspaceAnalysisHandler} from './lib/workspace-analysis.mjs';
import {createOperationalForecastHandler} from './lib/operational-forecast.mjs';
const operationalForecastHandler=createOperationalForecastHandler({runsDir:fileURLToPath(new URL('./.runtime/workspace-analysis',import.meta.url)),dataDir:fileURLToPath(new URL('./.runtime/operational-forecasts',import.meta.url))});
import {createImpactContextHandler} from './lib/impact-context.mjs';
const impactContextHandler=createImpactContextHandler({captureFile:new URL('./evidence/ordinary-capture-expanded.json',import.meta.url)});
import {createAzureKnowledgeHandler} from './lib/azure-knowledge.mjs';
import {createConditionalHandler} from './lib/conditional.mjs';
import { createVaultHandler } from './lib/vault.mjs';
const vaultHandler = await createVaultHandler({dataDir:fileURLToPath(new URL('./.runtime/vault',import.meta.url)),seedDemo:true});
const buildSourceContext=createSourceContextBuilder({inventoryFile:new URL('./evidence/source-inventory-v2.json',import.meta.url),captureFile:new URL('./evidence/ordinary-capture-expanded.json',import.meta.url),store:vaultHandler.store,expectedRevision:'36870cbbdfe7864698e1adf644c7bf772f67ebb7'});
const workspaceV2Handler=await createWorkspaceOrchestratorV2({store:vaultHandler.store,dataDir:fileURLToPath(new URL('./.runtime/workspace-analysis-v2',import.meta.url)),buildContext:buildSourceContext,env:process.env});
const proposalConfig=azureConfiguration(process.env);
let remediationSourceReady=true,remediationReviewer;
try{remediationReviewer=await createRemediationReviewer({sourceRoot:process.env.XANDER_SOURCE_ROOT||new URL('./juice/source', import.meta.url).pathname,generateProposal:createAzureProposalGenerator(proposalConfig)});}catch{remediationSourceReady=false;remediationReviewer={capabilities:()=>({reviewOnly:true,supportedFiles:[],reason:'Pinned source checkout unavailable. Set XANDER_SOURCE_ROOT to the matching reviewed checkout.'}),propose:async()=>{throw Object.assign(new Error('Pinned source checkout is unavailable.'),{status:503});}};}

const remediationHandler=await createRemediationHandler({reviewer:remediationReviewer,runDirs:[fileURLToPath(new URL('./.runtime/workspace-analysis',import.meta.url)),fileURLToPath(new URL('./.runtime/workspace-analysis-v2',import.meta.url))],dataDir:fileURLToPath(new URL('./.runtime/remediation-proposals',import.meta.url)),ready:proposalConfig.ready&&remediationSourceReady});
const advisoryHandler=createLayaAdvisoryHandler({dataDir:fileURLToPath(new URL('./.runtime/laya-advisories',import.meta.url)),runDirs:[fileURLToPath(new URL('./.runtime/workspace-analysis',import.meta.url)),fileURLToPath(new URL('./.runtime/workspace-analysis-v2',import.meta.url))],env:process.env});
const workspaceAnalysisHandler=await createWorkspaceAnalysisHandler({store:vaultHandler.store,dataDir:fileURLToPath(new URL('./.runtime/workspace-analysis',import.meta.url)),evidenceFile:new URL('./evidence/workspace-source.json',import.meta.url),captureFile:new URL('./evidence/ordinary-capture-expanded.json',import.meta.url)});
const azureKnowledgeHandler=createAzureKnowledgeHandler({store:vaultHandler.store});
const conditionalHandler=createConditionalHandler({store:vaultHandler.store,dataDir:fileURLToPath(new URL('./.runtime/scenarios',import.meta.url))});
import { createCaptureHandler } from './lib/capture.mjs';
const captureHandler = await createCaptureHandler({root:fileURLToPath(new URL('./.runtime/capture',import.meta.url))});
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { analyze, runDemo, scenario } from './lib/engine.mjs';
import { providerPolicy } from './lib/provider.mjs';
const root = new URL('./public/', import.meta.url);
const assets = new Map([['/', ['index.html','text/html']], ['/app.js',['app.js','text/javascript']], ['/style.css',['style.css','text/css']], ['/styles.css',['styles.css','text/css']], ['/fonts/Manrope.ttf',['fonts/Manrope.ttf','font/ttf']], ['/fonts/Newsreader.ttf',['fonts/Newsreader.ttf','font/ttf']]]);
for (const [file,type] of [['site-context.mjs','text/javascript'],['vendor/endpointIdentity.mjs','text/javascript'],['architecture-explorer.mjs','text/javascript'],['architecture-explorer.css','text/css'],['assessment-brief.mjs','text/javascript'],['graph-layout.mjs','text/javascript'],['workspace-shell.css','text/css'],['workspace-shell.mjs','text/javascript'],['impact-forecast.mjs','text/javascript'],['forecast-ui.mjs','text/javascript'],['forecast.css','text/css'],['workspace-ui.mjs','text/javascript'],['workspace.css','text/css'],['impact.html','text/html'],['impact-ui.mjs','text/javascript'],['impact-model.mjs','text/javascript'],['impact.css','text/css'],['answers.html','text/html'],['answers-ui.mjs','text/javascript'],['answers.css','text/css'],['conditional.html','text/html'],['conditional-ui.mjs','text/javascript'],['conditional.css','text/css'],['vault.html','text/html'],['vault-ui.mjs','text/javascript'],['vault.css','text/css'],['capture.html','text/html'],['capture-ui.mjs','text/javascript'],['capture.css','text/css'],['business.html','text/html'],['business.mjs','text/javascript'],['business-model.mjs','text/javascript'],['business.css','text/css']]) assets.set('/'+file,[file,type]);
function reply(res, status, body) { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(body)); }
async function json(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw Object.assign(new Error('Send application/json.'), {status:415});
  let size=0; const parts=[];
  for await (const part of req) { size+=part.length; if(size>2_000_000) throw Object.assign(new Error('Upload exceeds 2 MB. Use a small, relevant source and traffic sample.'),{status:413}); parts.push(part); }
  try { return JSON.parse(Buffer.concat(parts).toString()); } catch { throw Object.assign(new Error('Invalid JSON. Check the example bundle format.'),{status:400}); }
}
export function createServer() {
 let activeDemo=false;
 return http.createServer(async(req,res)=>{
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
  const port=req.socket.localPort; const hosts=new Set([`127.0.0.1:${port}`,`localhost:${port}`]);
  if(!hosts.has(req.headers.host)) return reply(res,403,{error:'Only loopback host access is allowed.'});
  if(req.headers.origin && !hosts.has(req.headers.origin.replace(/^http:\/\//,''))) return reply(res,403,{error:'Cross-origin requests are disabled.'});
  if(req.headers['sec-fetch-site']==='cross-site') return reply(res,403,{error:'Cross-site requests are disabled.'});
  try {
   const path=new URL(req.url,'http://localhost').pathname;
   if(await advisoryHandler(req,res)) return;
   if(await remediationHandler(req,res)) return;
   if(await workspaceV2Handler(req,res)) return;
   if(await workspaceAnalysisHandler(req,res)) return;
   if(await operationalForecastHandler(req,res)) return;
   if(await impactContextHandler(req,res)) return;
   if(await captureHandler(req,res,path)) return;
   if(await azureKnowledgeHandler(req,res)) return;
   if(await conditionalHandler(req,res)) return;
   if(await vaultHandler(req,res)) return;
   if(req.method==='GET' && path==='/api/provider') return reply(res,200,{...providerPolicy,optionalAdapter:'OpenAI-compatible, explicit operator configuration, fixed synthetic context only; not connected to imported analysis.'});
   if(req.method==='GET' && path==='/api/health') return reply(res,200,{ok:true,localOnly:true,modelProvider:azureKnowledgeHandler.status().ready?'azure-opt-in':'disabled',providerAutomaticCalls:false});
   if(req.method==='GET' && path==='/api/example') {const data=await readFile(new URL('./fixtures/example.json',import.meta.url),'utf8'); return reply(res,200,JSON.parse(data));}
   if(req.method==='POST' && path==='/api/analyze') return reply(res,200,await analyze(await json(req)));
   if(req.method==='POST' && path==='/api/scenario') {const body=await json(req); return reply(res,200,scenario(body.assumptions || {},body.days));}
   if(req.method==='POST' && path==='/api/demo') {
    const body=await json(req); if(body.fixed!==undefined && typeof body.fixed!=='boolean') return reply(res,400,{error:'fixed must be a boolean.'});
    if(activeDemo) return reply(res,429,{error:'A fixture test is running. Try again shortly.'});
    activeDemo=true; try{return reply(res,200,await runDemo({fixed:body.fixed===true}));}finally{activeDemo=false;}
   }
   if(req.method==='GET' && assets.has(path)) {const [file,type]=assets.get(path); const data=await readFile(new URL(file,root));res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`});return res.end(data);}
   reply(res,404,{error:'Not found.'});
  } catch(error) {const status=error.status || (error.code==='ENOENT'?404:400);reply(res,status,{error:status===404?'Not found.':String(error.message).slice(0,300)});}
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const port=Number(process.env.PORT || 4317);
 if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('PORT must be an integer from 1024 to 65535.');
 const server=createServer();for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await workspaceV2Handler.shutdown();await captureHandler.capture.stop();server.close(()=>process.exit(0));});server.listen(port,'127.0.0.1',()=>console.log(`Xander AI · http://127.0.0.1:${port} · local only`));
}
