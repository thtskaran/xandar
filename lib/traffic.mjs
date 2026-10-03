/** Bounded, non-executing adapters for Project67 recorder.mjs and HAR 1.2. */
export class CaptureInputError extends Error {
  constructor(message) { super(message); this.name='InputError'; this.statusCode=400; }
}
const MAX_BYTES=2_000_000, MAX_EVENTS=6000, MAX_REQUESTS=2000;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stamp=value=>typeof value==='string' && value.length<=64 && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const captureId=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)?value:null;
const status=value=>Number.isInteger(value)&&value>=100&&value<=599?value:null;
const SAFE_FIELDS=new Set(['id','owner','ownerId','tenant','tenantId','organizationId','userId','name','email','amount','currency','total','subtotal','tax','invoice','invoices','items','data','results','error','errors','message','status','code','count','page','limit','next','previous','createdAt','updatedAt','dueDate','customer','customerId','organization','profile','plan','description','quantity','price','sku','address','city','country','active','success']);
function jsonShape(value,depth=0,budget={left:80}) {
  if(budget.left--<=0||depth>=4)return {type:Array.isArray(value)?'array':value===null?'null':typeof value,truncated:true};
  if(value===null)return {type:'null'};
  if(Array.isArray(value))return {type:'array',sampledItems:value.slice(0,3).map(item=>jsonShape(item,depth+1,budget)),truncated:value.length>3};
  if(plain(value)) {
    const entries=Object.entries(value),visible=entries.filter(([key])=>SAFE_FIELDS.has(key)).slice(0,20);
    return {type:'object',fields:Object.fromEntries(visible.map(([key,item])=>[key,jsonShape(item,depth+1,budget)])),omittedFieldCount:entries.length-visible.length};
  }
  return {type:typeof value};
}
export function responseMetadata(response={},format='har') {
  if(!plain(response))response={};
  const rawMime=format==='har'?response.content?.mimeType:response.contentType;
  const mime=typeof rawMime==='string'&&/^(application\/(?:json|problem\+json)|text\/(?:plain|html)|application\/octet-stream)(?:;|$)/i.test(rawMime)?rawMime.split(';')[0].toLowerCase():null;
  const rawBytes=format==='har'?response.content?.size:response.bodySaved?.bytes;
  const bytes=Number.isSafeInteger(rawBytes)&&rawBytes>=0&&rawBytes<=MAX_BYTES?rawBytes:null;
  const text=format==='har'?response.content?.text:response.body;
  let schema=null,reason='No supported inline JSON response is available; schema unknown.';
  if(mime?.endsWith('json')&&typeof text==='string'&&text.length<=90000) {
    let decoded=text;
    if(format==='har'&&response.content?.encoding==='base64')decoded=Buffer.from(text,'base64').toString('utf8');
    if(Buffer.byteLength(decoded)<=65536) {try{schema=jsonShape(JSON.parse(decoded));reason='Structure only: allowlisted field names and types; values and unknown keys discarded.';}catch{reason='Inline JSON could not be parsed; schema unknown.';}}
    else reason='Inline response exceeds the 64 KB schema sampling limit.';
  }
  return {contentType:mime,bytes,schema,schemaStatus:schema?'observed-structure':'unknown',schemaReason:reason,bodyFileRead:false};
}
function actorClassifier() {
  const sessions=new Map();
  return request=>{
    const alias=request?.actorAlias;
    if(typeof alias==='string'&&/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(alias)&&!/(bearer|secret|token|password|cookie|authorization)/i.test(alias))return {actorAlias:alias,actorAliasBasis:'owner-supplied label; identity unverified'};
    const headers=request?.headers;
    const entries=Array.isArray(headers)?headers.slice(0,100).map(item=>[item?.name,item?.value]):plain(headers)?Object.entries(headers).slice(0,100):[];
    const credentials=entries.filter(([name,value])=>typeof name==='string'&&/^(authorization|cookie)$/i.test(name)&&typeof value==='string'&&value.length>0&&value.length<=4096).map(([name,value])=>[name.toLowerCase(),value]).sort((a,b)=>a[0].localeCompare(b[0]));
    if(!credentials.length)return {actorAlias:null,actorAliasBasis:'No usable session evidence; identity unknown'};
    const key=JSON.stringify(credentials);
    if(!sessions.has(key))sessions.set(key,`session-${sessions.size+1}`);
    return {actorAlias:sessions.get(key),actorAliasBasis:'Per-capture credential equality only; not a person, role or authenticated identity'};
  };
}
function basic(request) {
  if (!plain(request)||typeof request.method!=='string'||!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/i.test(request.method)||typeof request.url!=='string'||request.url.length>3000) return null;
  let url;try{url=new URL(request.url);}catch{return null;}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
  return {method:request.method.toUpperCase(),url:url.origin+url.pathname};
}
export function normalizeCapture(capture) {
  if(!plain(capture)||!['project67-jsonl','har'].includes(capture.format))throw new CaptureInputError('Capture format must be project67-jsonl or har.');
  let serialized;
  try { serialized=typeof capture.content==='string'?capture.content:JSON.stringify(capture.content); }catch{throw new CaptureInputError('Capture must be JSON serializable.');}
  if(typeof serialized!=='string'||Buffer.byteLength(serialized)>MAX_BYTES)throw new CaptureInputError('Capture exceeds the 2 MB limit or is missing.');
  const metadata={format:capture.format,provenance:capture.format==='project67-jsonl'?'Project67 src/capture/recorder.mjs request/response event schema':'HAR 1.2 log.entries',eventCount:0,importedRequests:0,incompleteRequests:0,skippedEntries:0,issues:[],timestamps:{first:null,last:null},limitations:['Capture contents are owner-supplied observations, not independently authenticated evidence.','Headers, cookies, body data, body file references, URL query and fragment are discarded.','Capture timestamps are observation times, not the inception of a weakness.']};
  const traffic=[],times=[],actor=actorClassifier();
  metadata.limitations.push('Session aliases use transient credential equality within this capture only. Raw credentials and credential hashes are never exported; matching aliases do not prove actor identity.','Response schema samples retain only allowlisted field names and types, never values; schema similarity does not prove source-handler execution.');
  const issue=(entry)=>{if(metadata.issues.length<100)metadata.issues.push(entry);};
  const keepTime=value=>{const t=stamp(value);if(t)times.push(t);return t;};
  const add=entry=>{if(traffic.length>=MAX_REQUESTS)throw new CaptureInputError('Capture exceeds 2,000 requests.');traffic.push(entry);};
  if(capture.format==='har') {
    let document;try{document=typeof capture.content==='string'?JSON.parse(capture.content):capture.content;}catch{throw new CaptureInputError('HAR content is invalid JSON.');}
    if(!plain(document)||!plain(document.log)||!Array.isArray(document.log.entries)||document.log.entries.length>MAX_REQUESTS)throw new CaptureInputError('HAR must contain log.entries with at most 2,000 entries.');
    metadata.eventCount=document.log.entries.length;
    document.log.entries.forEach((entry,index)=>{
      const request=basic(entry?.request);
      if(!request){metadata.skippedEntries++;issue({index,reason:'Invalid HTTP request method or absolute HTTP(S) URL.'});return;}
      const observedAt=keepTime(entry.startedDateTime),responseStatus=status(entry.response?.status);
      const requestId=captureId(entry._requestId)||`har-entry-${index+1}`;
      if(responseStatus===null){metadata.incompleteRequests++;issue({index,captureRequestId:requestId,reason:'No valid observed HTTP response status; status remains unknown.'});}
      if(!observedAt)issue({index,captureRequestId:requestId,reason:'Capture timestamp missing or invalid.'});
      add({...request,...actor({...entry.request,actorAlias:entry._actorAlias??entry.request.actorAlias}),responseMetadata:responseMetadata(entry.response,'har'),status:responseStatus,captureRequestId:requestId,responseObserved:responseStatus!==null,observedAt,requestObservedAt:observedAt,responseObservedAt:null,sourceIndex:index});
    });
  }else{
    if(typeof capture.content!=='string')throw new CaptureInputError('Project67 JSONL capture content must be text.');
    const lines=capture.content.split(/\r?\n/);if(lines.length>MAX_EVENTS+1)throw new CaptureInputError('Capture exceeds 6,000 JSONL lines.');
    const records=new Map();
    lines.forEach((line,index)=>{
      if(!line.trim())return;
      metadata.eventCount++;
      let event;try{event=JSON.parse(line);}catch{metadata.skippedEntries++;issue({index,reason:'Malformed JSONL event skipped.'});return;}
      if(!plain(event)){metadata.skippedEntries++;issue({index,reason:'Non-object event skipped.'});return;}
      const at=keepTime(event.at);
      if(['body_fetch_failed','body_incomplete','serviceworker_detected'].includes(event.type))issue({index,captureRequestId:captureId(event.request_id),reason:event.type==='serviceworker_detected'?'Service worker detected; mediated traffic may be missing.':event.type==='body_fetch_failed'?'Response body fetch failed in original capture.':'Response body incomplete in original capture.'});
      if(!['request','response','requestfailed'].includes(event.type))return;
      const request=basic(event.request),requestId=captureId(event.request?.id);
      if(!request||!requestId){metadata.skippedEntries++;issue({index,reason:'Request event has invalid method, URL or request ID.'});return;}
      let record=records.get(requestId);
      if(record&&(record.method!==request.method||record.url!==request.url)) {metadata.skippedEntries++;issue({index,captureRequestId:requestId,reason:'Conflicting request ID; event skipped rather than paired to another endpoint.'});return;}
      if(!record){if(records.size>=MAX_REQUESTS)throw new CaptureInputError('Capture exceeds 2,000 unique requests.');record={...request,...actor(event.request),responseMetadata:responseMetadata({},'project67-jsonl'),status:null,captureRequestId:requestId,responseObserved:false,observedAt:at,requestObservedAt:null,responseObservedAt:null,sourceIndex:index,requestEventSeen:false,responseEventSeen:false,failed:false};records.set(requestId,record);}
      if(event.type==='request') {if(record.requestEventSeen)issue({index,captureRequestId:requestId,reason:'Duplicate request event.'});record.requestEventSeen=true;record.requestObservedAt=at;}
      if(event.type==='response') {
        if(record.responseEventSeen){metadata.skippedEntries++;issue({index,captureRequestId:requestId,reason:'Duplicate response event skipped; original observation retained.'});return;}
        record.responseEventSeen=true;record.status=status(event.response?.status);record.responseObserved=record.status!==null;record.responseObservedAt=at;record.responseMetadata=responseMetadata(event.response,'project67-jsonl');
      }
      if(event.type==='requestfailed'){record.failed=true;issue({index,captureRequestId:requestId,reason:'Request failed in original capture; failure text omitted.'});}
    });
    for(const record of records.values()) {
      if(!record.responseObserved){metadata.incompleteRequests++;issue({index:record.sourceIndex,captureRequestId:record.captureRequestId,reason:'No valid observed HTTP response status; status remains unknown.'});}
      if(!record.requestEventSeen)issue({index:record.sourceIndex,captureRequestId:record.captureRequestId,reason:'No paired request event; request metadata came from the response or failure event.'});
      record.observedAt=record.requestObservedAt||record.responseObservedAt||record.observedAt;
      if(!record.observedAt)issue({index:record.sourceIndex,captureRequestId:record.captureRequestId,reason:'Capture timestamp missing or invalid.'});
      add(record);
    }
  }
  times.sort();metadata.timestamps={first:times[0]??null,last:times.at(-1)??null};metadata.importedRequests=traffic.length;
  if(metadata.issues.length===100)metadata.limitations.push('Issue details are capped at 100 entries; aggregate counts remain available.');
  return {traffic,metadata};
}
