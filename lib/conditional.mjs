import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
export const MODEL_VERSION='conditional-interruption-v1';
export const TRIALS=20000;
function number(value,name,min,max){if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max)throw new Error(`${name} must be a finite number from ${min} to ${max}.`);return value;}
export function triangular(u,min,mode,max){if(min===max)return min;const p=(mode-min)/(max-min);return u<=p?min+Math.sqrt(u*(max-min)*(mode-min)):max-Math.sqrt((1-u)*(max-min)*(max-mode));}
export function simulate(input){
 const r=number(input.dailyRevenue,'Daily revenue',0,1e12),m=number(input.margin,'Contribution margin',0,1),a=number(input.affectedShare,'Affected share',0,1),q=number(input.lostShare,'Permanently lost share',0,1),F=number(input.oneTimeCost,'One-time incremental cost',0,1e12);
 const min=number(input.durationMin,'Minimum duration',0,3650),mode=number(input.durationMode,'Mode duration',min,3650),max=number(input.durationMax,'Maximum duration',mode,3650),custom=number(input.horizon,'Horizon',Number.MIN_VALUE,3650);
 const seed=number(input.seed,'Seed',0,4294967295);if(!Number.isInteger(seed))throw new Error('Seed must be an integer.');
 if(!/^[A-Z]{3}$/.test(input.currency||''))throw new Error('A three-letter currency is required.');
 if(input.revenueReviewed!==true||!input.revenueSource||typeof input.revenueSource.snapshotVersion!=='number'||!Array.isArray(input.revenueSource.sources)||!input.revenueSource.sources.length)throw new Error('Review and confirm a cited revenue snapshot first.');
 const sources=input.revenueSource.sources.map(s=>({fileId:String(s.fileId||'').slice(0,100),fileName:String(s.fileName||'').slice(0,200),rowStart:s.rowStart,rowEnd:s.rowEnd,...(s.sheet?{sheet:s.sheet,recordStart:s.recordStart}:{}),...(s.previewUrl?{previewUrl:s.previewUrl}:{})}));
 let state=seed>>>0;const random=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
 const durations=Array.from({length:TRIALS},()=>triangular(random(),min,mode,max));
 const coefficient=r*m*a*q;const loss=(d,h,share=q)=>F+r*m*a*share*Math.min(d,h);
 const quantile=(v,p)=>{const i=(v.length-1)*p,lo=Math.floor(i);return v[lo]+(v[Math.ceil(i)]-v[lo])*(i-lo);};
 const horizons=[...new Set([7,10,30,custom])].sort((x,y)=>x-y).map(h=>{const values=durations.map(d=>F+coefficient*Math.min(d,h)).sort((x,y)=>x-y);const low=loss(min,h),high=loss(max,h),bins=Array(24).fill(0);for(const v of values)bins[high===low?0:Math.min(23,Math.floor((v-low)/(high-low)*24))]++;return {days:h,low,base:loss(mode,h),high,mean:values.reduce((s,v)=>s+v,0)/TRIALS,p50:quantile(values,.5),p90:quantile(values,.9),p95:quantile(values,.95),histogram:{min:low,max:high,counts:bins},sensitivity:{duration:[min,mode,max].map(d=>({durationDays:d,loss:loss(d,h)})),lostShare:[0,q,1].map(share=>({lostShare:share,loss:loss(mode,h,share)}))}};});
 return {conditional:true,formula:'F + r × m × a × q × min(D, H)',currency:input.currency,inputs:{dailyRevenue:r,margin:m,affectedShare:a,lostShare:q,oneTimeCost:F,durationMin:min,durationMode:mode,durationMax:max,horizon:custom},horizons,metadata:{modelVersion:MODEL_VERSION,schemaVersion:1,seed,prng:'mulberry32-v1',trials:TRIALS,quantileConvention:'Linear interpolation at (n−1)p (type 7)',snapshotVersion:input.revenueSource.snapshotVersion,revenueScope:input.revenueSource.scope,sourceStatus:'User-reviewed citation supplied to calculator; not independently revalidated',sources,units:{dailyRevenue:`${input.currency}/day`,duration:'days',loss:input.currency,fractions:'0–1'},inputSources:{dailyRevenue:'User-reviewed knowledge snapshot',remainingInputs:'Owner scenario assumptions'},limitations:['Conditional on an event starting at day 0; no event likelihood is estimated.','20,000 draws provide a numerical approximation, not a calibrated forecast.','One-time cost is disjoint from foregone contribution and is counted once.','Base uses mode duration; it is not the simulated median.']}};
}
const inputKeys=['dailyRevenue','margin','affectedShare','lostShare','oneTimeCost','durationMin','durationMode','durationMax','horizon','seed','currency','revenueReviewed'];
export function createConditionalHandler({store,dataDir}={}){
 let writes=Promise.resolve();
 const validate=async raw=>{
  if(!store?.context)throw new Error('Knowledge store is unavailable.');
  const scope=raw?.revenueSource?.scope;if(!['demo','uploads'].includes(scope))throw new Error('Choose a knowledge scope.');
  const context=await store.context(scope);if(context.snapshotVersion!==raw.revenueSource.snapshotVersion||(store.manifest&&store.manifest.snapshotVersion!==context.snapshotVersion)){const e=new Error('Knowledge snapshot changed. Review and approve the current revenue basis.');e.status=409;throw e;}
  if(context.financials.length!==1)throw new Error('A single-currency revenue basis is required.');const financial=context.financials[0];
  if(financial.grossRevenuePerDay!==raw.dailyRevenue||financial.currency!==raw.currency)throw new Error('Revenue or currency does not match the reviewed knowledge snapshot.');
  const input=Object.fromEntries(inputKeys.map(k=>[k,raw[k]]));input.revenueSource={snapshotVersion:context.snapshotVersion,scope,sources:financial.sources.map(s=>({fileId:s.fileId,fileName:s.fileName,rowStart:s.rowStart,rowEnd:s.rowEnd,...(s.sheet?{sheet:s.sheet,recordStart:s.recordStart}:{}),...(s.previewUrl?{previewUrl:s.previewUrl}:{})}))};
  const result=simulate(input);result.metadata.sourceStatus='Vault snapshot and derived revenue revalidated at calculation time; owner approval is a supplied attestation';return{input,result};
 };
 return async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),path=url.pathname;if(!['/api/conditional','/api/conditional/saved','/api/conditional/export'].includes(path))return false;
  res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
  try{
   if(req.headers?.['sec-fetch-site']==='cross-site'||(req.headers?.origin&&new URL(req.headers.origin).host!==req.headers.host)){const e=new Error('Cross-origin requests are not accepted.');e.status=403;throw e;}
   if(req.method==='GET'&&path!=='/api/conditional'){
    const scope=url.searchParams.get('scope');if(!['demo','uploads'].includes(scope))throw new Error('Choose a knowledge scope.');if(!dataDir)throw new Error('Scenario storage is not configured.');await writes;
    let record;try{const file=await fs.readFile(join(dataDir,scope+'.json'),'utf8');if(Buffer.byteLength(file)>262144)throw new Error('Saved scenario is too large.');record=JSON.parse(file);if(record.schemaVersion!==1||record.scope!==scope)throw new Error('Unsupported saved scenario.');}catch(e){if(e.code==='ENOENT'){res.end(JSON.stringify({record:null,scope,stale:false}));return true;}throw e;}
    const current=await store.context(scope),f=current.financials?.[0],stale=current.snapshotVersion!==record.input.revenueSource.snapshotVersion||current.financials.length!==1||f?.grossRevenuePerDay!==record.input.dailyRevenue||f?.currency!==record.input.currency;
    if(path==='/api/conditional/export')res.setHeader('Content-Disposition',`attachment; filename="xander-scenario-${scope}.json"`);
    res.end(JSON.stringify({record,scope,stale,currentSnapshotVersion:current.snapshotVersion,requiresReview:true,note:stale?'Saved scenario uses an older or changed knowledge basis. Review current sources before running.':'Saved result restored without recalculation. Review sources before running again.'}));return true;
   }
   if(req.method!=='POST'||path==='/api/conditional/export'){const e=new Error('Method not allowed.');e.status=405;throw e;}
   let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>32768)throw new Error('Request exceeds 32 KiB.');body+=chunk.toString();}
   const {input,result}=await validate(JSON.parse(body));
   if(path==='/api/conditional/saved'){
    if(!dataDir)throw new Error('Scenario storage is not configured.');const record={schemaVersion:1,scope:input.revenueSource.scope,savedAt:new Date().toISOString(),input,result};
    const operation=writes.then(async()=>{await fs.mkdir(dataDir,{recursive:true,mode:0o700});const file=join(dataDir,record.scope+'.json'),temp=join(dataDir,randomUUID()+'.tmp');try{await fs.writeFile(temp,JSON.stringify(record),{mode:0o600,flag:'wx'});await fs.rename(temp,file);}finally{await fs.rm(temp,{force:true});}});writes=operation.catch(()=>{});await operation;res.end(JSON.stringify({record,stale:false,requiresReview:false}));
   }else res.end(JSON.stringify(result));
  }catch(error){res.statusCode=error.status||400;res.end(JSON.stringify({error:error instanceof SyntaxError?'Invalid JSON.':error.code?'Local scenario storage failed.':error.message}));}return true;
 };
}
