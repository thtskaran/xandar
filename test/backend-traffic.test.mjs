import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeCapture} from '../lib/traffic.mjs';
import {analyze,runDemo} from '../lib/engine.mjs';
const content=await readFile(new URL('../fixtures/capture-project67.jsonl',import.meta.url),'utf8');
const files=[{path:'app.js',content:"app.get('/api/invoices/:id', (req,res)=>{const invoice=invoices.findById(req.params.id);res.json(invoice);});"}];
test('Project67 pairs real recorder shape, preserves incomplete IDs and strips sensitive fields',()=>{
 const {traffic,metadata}=normalizeCapture({format:'project67-jsonl',content});
 assert.equal(traffic.length,2);assert.equal(traffic[0].status,200);assert.equal(traffic[1].status,null);
 assert.equal(traffic[1].captureRequestId,'rid_unfinished');assert.equal(metadata.incompleteRequests,1);
 assert.equal(metadata.timestamps.first,'2026-10-03T00:00:00.000Z');
 assert.ok(!JSON.stringify({traffic,metadata}).includes('discard-me'));
 const result=analyze({files,capture:{format:'project67-jsonl',content}});
 assert.equal(result.requests[1].status,null);assert.equal(result.capture.format,'project67-jsonl');
});
test('HAR no-response entries remain unknown, response bodies and credentials are discarded',()=>{
 const result=normalizeCapture({format:'har',content:{log:{version:'1.2',entries:[{startedDateTime:'2026-10-03T00:00:00Z',request:{method:'GET',url:'https://synthetic.invalid/api/profile?secret=discard-me',headers:[{name:'Cookie',value:'discard-me'}]},response:{status:0,content:{text:'discard-me'}}}]}}});
 assert.equal(result.traffic[0].status,null);assert.equal(result.metadata.incompleteRequests,1);assert.ok(!JSON.stringify(result).includes('discard-me'));
});
test('malformed, orphan and conflicting events produce explicit issues',()=>{
 const events=[{type:'response',request:{id:'rid_orphan',method:'GET',url:'https://x.invalid/one'},response:{status:403}},{type:'response',request:{id:'rid_orphan',method:'GET',url:'https://x.invalid/two'},response:{status:200}}].map(JSON.stringify).join('\n')+'\ninvalid';
 const result=normalizeCapture({format:'project67-jsonl',content:events});
 assert.equal(result.traffic.length,1);assert.equal(result.traffic[0].status,403);assert.equal(result.metadata.skippedEntries,2);assert.ok(result.metadata.issues.some(i=>i.reason.includes('No paired request')));
 assert.throws(()=>normalizeCapture({format:'har',content:'broken'}));
 assert.throws(()=>normalizeCapture({format:'project67-jsonl',content:'x'.repeat(3000001)}));
});
test('static candidates require object lookup; a visible ownership predicate remains a clue',()=>{
 const run=content=>analyze({files:[{path:'app.js',content}],traffic:[]});
 const parameterOnly=run("app.get('/items/:id', handler);");assert.equal(parameterOnly.findings.length,0);assert.equal(parameterOnly.routes[0].securityAssessment.assessment,'unknown');
 const vulnerable=run("app.get('/items/:id',(req,res)=>{const item=records[req.params.id];res.json(item);});");assert.equal(vulnerable.findings.length,1);assert.equal(vulnerable.findings[0].status,'candidate');assert.equal(vulnerable.routes[0].securityAssessment.objectLookup,true);
 const protectedResult=run("app.get('/items/:id',(req,res)=>{const item=records[req.params.id];if(item.owner!==req.actor)return res.sendStatus(403);res.json(item);});");assert.equal(protectedResult.routes[0].securityAssessment.assessment,'visible-control-clue');assert.equal(protectedResult.findings[0].status,'candidate');assert.match(protectedResult.findings[0].title,/Validate visible/);
});
test('demo finding links the actual North cross-tenant attempt',async()=>{
 const result=await runDemo({fixed:true});const request=result.findings[0].request;
 assert.equal(request.actor,'North tenant member');assert.equal(request.path,'/api/invoices/inv-south');assert.equal(request.status,403);
 assert.ok(result.findings[0].evidenceIds.includes(request.evidenceId));
});
test('response schemas contain allowlisted structure only; session aliases expose no credential material',()=>{
 const entry=(credential,body,alias)=>({startedDateTime:'2026-10-03T00:00:00Z',_actorAlias:alias,request:{method:'GET',url:'https://x.invalid/items/1',headers:[{name:'Authorization',value:credential}]},response:{status:200,content:{mimeType:'application/json',size:123,text:JSON.stringify(body)}}});
 const result=normalizeCapture({format:'har',content:{log:{entries:[entry('Bearer secret-A',{id:'private-id',amount:99,password:'private-password','secret-key-name-99':'private-value'}),entry('Bearer secret-A',{id:'another-private-id'}),entry('Bearer secret-B',{id:'third-id'}),entry('Bearer secret-C',{id:'fourth-id'},'North member')]}}});
 assert.equal(result.traffic[0].actorAlias,result.traffic[1].actorAlias);assert.notEqual(result.traffic[0].actorAlias,result.traffic[2].actorAlias);assert.equal(result.traffic[3].actorAlias,'North member');
 assert.deepEqual(result.traffic[0].responseMetadata.schema.fields,{id:{type:'string'},amount:{type:'number'}});
 assert.equal(result.traffic[0].responseMetadata.schema.omittedFieldCount,2);
 for(const secret of ['secret-A','secret-B','private-id','private-password','private-value','secret-key-name-99'])assert.ok(!JSON.stringify(result).includes(secret));
});
test('Project67 body references remain unread, schema unknown; middleware clues do not verify control',()=>{
 const result=normalizeCapture({format:'project67-jsonl',content});
 assert.equal(result.traffic[0].responseMetadata.schema,null);assert.equal(result.traffic[0].responseMetadata.bodyFileRead,false);
 const source="app.get('/items/:id',requireTenantAccess,(req,res)=>res.json(records[req.params.id]));";
 const analysis=analyze({revision:'same-revision',files:[{path:'app.js',content:source}],traffic:[]});
 assert.equal(analysis.routes[0].securityAssessment.middlewareClues[0].name,'requireTenantAccess');assert.equal(analysis.findings[0].status,'candidate');
 const changed=analyze({revision:'same-revision',files:[{path:'app.js',content:source+'\n// changed content'}],traffic:[]});
 assert.notEqual(analysis.routes[0].id,changed.routes[0].id);assert.notEqual(analysis.routes[0].evidenceId,changed.routes[0].evidenceId);
 assert.equal(analysis.findings[0].ruleId,'XANDER-JS-OBJECT-AUTHZ-001');
});
test('missing and null HAR response metadata remain unknown without failing intake',()=>{
 const result=normalizeCapture({format:'har',content:{log:{entries:[{request:{method:'GET',url:'https://x.invalid/a'},response:null}]}}});
 assert.equal(result.traffic[0].status,null);assert.equal(result.traffic[0].responseMetadata.schemaStatus,'unknown');
});
