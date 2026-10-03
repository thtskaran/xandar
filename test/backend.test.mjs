import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {analyze, runDemo, scenario, evaluateFixtureProof, InputError} from '../lib/engine.mjs';
const example = JSON.parse(await readFile(new URL('../fixtures/example.json',import.meta.url)));

test('source and request correlation remains candidate, never proof',()=>{
  const result = analyze(example);
  assert.equal(result.findings[0].status,'candidate');
  assert.equal(result.routes[0].line,3);
  assert.equal(result.summary.mappedRequests,1);
  assert.equal(result.summary.verifiedFindings,0);
  assert.equal(result.id,analyze(example).id);
});
test('paths and bounded input are validated without touching filesystem',()=>{
  for(const path of ['../secrets','/etc/passwd','a/../b','a\\b','a//b']) assert.throws(()=>analyze({...example,files:[{path,content:'x'}]}),InputError);
  assert.throws(()=>analyze({...example,files:[{path:'a.js',content:'a'.repeat(300001)}]}),InputError);
  assert.throws(()=>analyze({...example,traffic:[{method:'GET',url:'file:///etc/passwd',status:200}]}),InputError);
});
test('unmapped traffic and missing financial inputs remain unknown',()=>{
  const result = analyze({...example,traffic:[{method:'GET',url:'/unmapped',status:404}]});
  assert.equal(result.requests[0].mappingStatus,'unresolved');
  assert.equal(result.summary.unresolvedRequests,1);
  assert.equal(scenario({},7).exposedRecords,null);
  assert.equal(scenario({},7).responseCost,null);
  assert.equal(scenario({},7).kind,'qualitative');
});
test('secrets in traffic headers, query strings and bodies are not persisted',()=>{
  const result = analyze({...example,traffic:[{method:'GET',url:'/api/invoices/123?token=private_secret_123',status:200,headers:{authorization:'Bearer private_secret_123'},body:'private_secret_123'}]});
  assert.ok(!JSON.stringify(result).includes('private_secret_123'));
});
test('scenario periods, saturation and conditional monetary types stay separate',()=>{
  const assumptions={baselineRecords:2400,recordsPerDay:40,recordCap:5000,responseCostPerRecord:8,dailyRevenue:2000,disruptionDays:2};
  assert.deepEqual([7,10,30].map(d=>scenario(assumptions,d).exposedRecords),[2680,2800,3600]);
  assert.equal(scenario(assumptions,90).exposedRecords,5000);
  assert.equal(scenario(assumptions,7).revenueAtRisk,4000);
  assert.equal(scenario({baselineRecords:0,recordsPerDay:0,responseCostPerRecord:0},7).responseCost,0);
  for(const bad of [{recordsPerDay:-1},{baselineRecords:30,recordCap:10},{dailyRevenue:Infinity},{dailyRevenue:1e12,disruptionDays:1e12}]) assert.throws(()=>scenario(bad,36500),InputError);
  assert.throws(()=>scenario({},Infinity),InputError);
});
test('actual vulnerable and protected local fixtures preserve legitimate operations', async()=>{
  const vulnerable = await runDemo();
  const fixed = await runDemo({fixed:true});
  assert.equal(vulnerable.findings[0].status,'verified');
  assert.equal(fixed.findings[0].status,'rejected');
  assert.equal(vulnerable.findings[0].proof.contentMatch,true);
  for(const result of [vulnerable,fixed]) {
    assert.equal(result.findings[0].proof.legitimatePassed,true);
    assert.ok(result.findings[0].proof.controls.every(c=>c.passed));
    assert.equal(result.mode,'demo');
    assert.ok(!JSON.stringify(result).includes('SOUTH_PRIVATE_INVOICE_91B38F'));
  }
});
test('parser ignores comments and quoted fake declarations, retains unknown unsupported source',()=>{
  const result=analyze({...example,files:[{path:'app.js',content:`const note = "app.get('/fake/:id', handler)";\n// app.get('/comment/:id', handler)\napp.get('/real/:id', handler);`}]});
  assert.equal(result.routes.length,1);
  assert.equal(result.routes[0].path,'/real/:id');
  assert.equal(result.routes[0].line,3);
});
test('sanitizing free text cannot corrupt JSON; unknown assumption keys are discarded',()=>{
  const result=analyze({...example,context:{policy:'Owner policy https://x.test/?token=sensitive',assumptions:{password:'secret',baselineRecords:0}}});
  assert.ok(result.product.policy.includes('[REDACTED]'));
  assert.deepEqual(result.assumptions,{baselineRecords:0});
  assert.throws(()=>scenario({currency:['USD']},7),InputError);
});
test('route count is bounded and unsupported files are explicitly accounted for',()=>{
  assert.throws(()=>analyze({...example,files:[{path:'app.js',content:Array.from({length:1001},(_,i)=>`app.get('/r${i}', handler);`).join('\n')}]}),InputError);
  const result=analyze({...example,files:[{path:'a.ts',content:'const x: number = 1;'}, {path:'broken.js',content:'app.get('}]});
  assert.equal(result.coverage.indexedSourceFiles,0);
  assert.equal(result.coverage.skippedFiles.length,2);
  assert.equal(result.summary.routes,0);
});

test('proof cannot pass with a broken owner control or call a server error protected',()=>{
  const responses={owner:{status:200,body:'SOUTH_PRIVATE_INVOICE_91B38F'},baseline:{status:200,body:'NORTH_PRIVATE_INVOICE_48E29A'},nonVictim:{status:200,body:'WEST_PRIVATE_INVOICE_78C62E'},attacker:{status:403,body:'Forbidden'},anon:{status:401,body:'Unauthorized'},profile:{status:200,body:'north'}};
  assert.equal(evaluateFixtureProof(responses).verdict,'refuted');
  assert.equal(evaluateFixtureProof({...responses,owner:{status:200,body:'Error'}}).verdict,'inconclusive');
  assert.equal(evaluateFixtureProof({...responses,attacker:{status:500,body:'Error'}}).verdict,'inconclusive');
  assert.equal(evaluateFixtureProof({...responses,attacker:{status:200,body:'No invoice'}}).verdict,'inconclusive');
});
