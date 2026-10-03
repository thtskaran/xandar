import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PINNED_REVISION,validateUnifiedDiff,createRemediationReviewer} from '../lib/remediation.mjs';
const source='one\ntwo\nthree\nfour\n';
const diff='--- a/routes/login.ts\n+++ b/routes/login.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+second\n three\n';
const validate=(patch=diff,overrides={})=>validateUnifiedDiff({diff:patch,revision:PINNED_REVISION,sources:{'routes/login.ts':source},allowedFiles:['routes/login.ts'],...overrides});
test('exact context and git headers validate without applying',()=>{
 const result=validate();assert.equal(result.contextMatched,true);assert.equal(result.status,'proposed');assert.equal(result.testStatus,'not-tested');assert.equal(result.autoApplied,false);assert.equal(result.files[0].added,1);
 assert.equal(validate('diff --git a/routes/login.ts b/routes/login.ts\nindex abc123..def456 100644\n'+diff).files.length,1);
});
test('reject traversal, unrelated paths, creation, deletion, rename and command text',()=>{
 for(const patch of [diff.replaceAll('routes/login.ts','../.env'),diff.replaceAll('routes/login.ts','routes/search.ts'),diff.replace('--- a/routes/login.ts','--- /dev/null'),diff.replace('+++ b/routes/login.ts','+++ /dev/null'),diff.replace('+++ b/routes/login.ts','+++ b/routes/search.ts'),diff+'echo unsafe\n'])assert.throws(()=>validate(patch));
});
test('reject revision mismatch, stale context, wrong coordinates/counts and unbounded payload',()=>{
 assert.throws(()=>validate(diff,{revision:'0'.repeat(40)}));assert.throws(()=>validate(diff,{sources:{'routes/login.ts':'changed\ntwo\nthree\nfour\n'}}));
 for(const patch of [diff.replace('-1,3','-2,3'),diff.replace('+1,3','+2,3'),diff.replace('-1,3','-1,2'),diff.replace(' one\n',''),diff.replace(' three\n',''),diff+'x'.repeat(48000)])assert.throws(()=>validate(patch));
});
test('multiple hunks require accurate resulting offsets; overlapping hunks reject',()=>{
 const patch='--- a/routes/login.ts\n+++ b/routes/login.ts\n@@ -1,2 +1,3 @@\n one\n+added\n two\n@@ -3,2 +4,2 @@\n-three\n+third\n four\n';
 assert.equal(validate(patch).files[0].hunks,2);assert.throws(()=>validate(patch.replace('+4,2','+3,2')));assert.throws(()=>validate(patch.replace('-3,2','-2,2')));
});
test('local source verification uses real revision and pinned hashes; does not trust caller revision',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'remediation-fixture-'));
 try{await mkdir(path.join(dir,'.git'));await mkdir(path.join(dir,'routes'));await writeFile(path.join(dir,'.git/HEAD'),PINNED_REVISION+'\n');await writeFile(path.join(dir,'routes/login.ts'),source);
 const reviewer=await createRemediationReviewer({sourceRoot:dir});await assert.rejects(()=>reviewer.prepare({issue:{id:'issue1',title:'Review selected code',sourceRefs:['routes/login.ts:21']}}),/manifest/);
 await writeFile(path.join(dir,'.git/HEAD'),'0'.repeat(40));await assert.rejects(()=>reviewer.prepare({issue:{id:'issue1',title:'Review',sourceRefs:['routes/login.ts:21']}}),/revision/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('actual pinned public source supports prepare, validated mock proposal and explicit consent',async()=>{
 const sourceRoot=(process.env.XANDER_SOURCE_ROOT || new URL('../juice/source', import.meta.url).pathname);
 const issue={id:'local-review',title:'Review-only code clarity fixture',description:'A bounded mock issue description.',mechanism:'Comment-only fixture; no defect is asserted.',remediation:'Propose a dummy comment change.',status:'user-supplied',sourceRefs:[{path:'routes/login.ts',line:1}]};let calls=0;
 const reviewer=await createRemediationReviewer({sourceRoot,generateProposal:async context=>{calls++;const lines=context.sources['routes/login.ts'].split('\n');return {revision:context.revision,diff:'--- a/routes/login.ts\n+++ b/routes/login.ts\n@@ -1,2 +1,2 @@\n '+lines[0]+'\n-'+lines[1]+'\n+'+lines[1]+' (review fixture)\n',rationale:'Dummy comment-only proposal; not a remediation claim.'};}});
 const original=await readFile(path.join(sourceRoot,'routes/login.ts'),'utf8');const context=await reviewer.prepare({issue});assert.equal(context.issue.status,'user-supplied');assert.equal(context.issue.independentlyVerified,false);assert.ok(context.sourceRefs[0].sha256);assert.equal(context.issue.description,issue.description);assert.ok(reviewer.capabilities().supportedFiles.includes('routes/login.ts'));const claimed=await reviewer.prepare({issue:{...issue,status:'verified'}});assert.equal(claimed.issue.reportedStatus,'verified');assert.equal(claimed.issue.status,'candidate');assert.equal(claimed.issue.independentlyVerified,false);await assert.rejects(()=>reviewer.prepare({issue:{...issue,description:'x'.repeat(4001)}}),/bounded/);
 await assert.rejects(()=>reviewer.propose({issue}),/consent/);assert.equal(calls,0);const result=await reviewer.propose({issue,consent:true});assert.equal(calls,1);assert.equal(result.validation.contextMatched,true);assert.equal(result.autoApplied,false);
 const after=await readFile(path.join(sourceRoot,'routes/login.ts'),'utf8');assert.equal(after,original);assert.match(context.sources['routes/login.ts'],/withheld source context/);assert.equal(context.sourceRefs[0].sha256,createHash('sha256').update(original).digest('hex'));
 await assert.rejects(()=>reviewer.prepare({issue:{...issue,sourceRefs:['.env']}}),/allowlist/);
});

test('expanded manifest aligns exactly with 206 eligible inventory files and their actual pinned hashes',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../lib/remediation-source-manifest.json',import.meta.url),'utf8'));
 const inventory=JSON.parse(await readFile(new URL('../evidence/source-inventory-v2.json',import.meta.url),'utf8'));
 assert.equal(manifest.eligibleFiles,206);assert.equal(manifest.inventoryHash,inventory.inventoryHash);assert.deepEqual(Object.keys(manifest.files).sort(),inventory.nodes.map(n=>n.path).sort());
 for(const n of inventory.nodes){assert.equal(manifest.files[n.path],n.sha256);const text=await readFile(path.join((process.env.XANDER_SOURCE_ROOT || new URL('../juice/source', import.meta.url).pathname),n.path));assert.equal(createHash('sha256').update(text).digest('hex'),n.sha256);}
});
test('frontend dotted basename and models support safe review-only fixture proposals',async()=>{
 const sourceRoot=(process.env.XANDER_SOURCE_ROOT || new URL('../juice/source', import.meta.url).pathname);
 const reviewer=await createRemediationReviewer({sourceRoot});assert.equal(reviewer.capabilities().supportedFileCount,206);
 const inventory=JSON.parse(await readFile(new URL('../evidence/source-inventory-v2.json',import.meta.url),'utf8'));const sample=[...new Set([...inventory.nodes.slice(0,10).map(n=>n.path),'models/product.ts','models/basket.ts'])];assert.ok(sample.length>8);for(const p of sample){
 const before=await readFile(path.join(sourceRoot,p),'utf8');const issue={id:p,title:'Comment-only review fixture',sourceRefs:[{path:p,line:1}]};const context=await reviewer.prepare({issue});const lines=context.sources[p].split('\n');
 const diff=`--- a/${p}\n+++ b/${p}\n@@ -1,2 +1,2 @@\n ${lines[0]}\n-${lines[1]}\n+${lines[1]} (review fixture)\n`;
 const result=await reviewer.review({issue,revision:PINNED_REVISION,diff,rationale:'Dummy comment only; no defect claim.'});assert.equal(result.validation.contextMatched,true);assert.equal(result.autoApplied,false);assert.equal(await readFile(path.join(sourceRoot,p),'utf8'),before);
 }
});
test('withheld context cannot enter a patch even when exact raw context is known',()=>{
 assert.throws(()=>validate(diff,{allowedLineRanges:{'routes/login.ts':[[1,1],[3,4]]}}),/withheld/);
 assert.equal(validate(diff,{allowedLineRanges:{'routes/login.ts':[[1,4]]}}).contextMatched,true);
 for(const p of ['frontend/../routes/login.ts','frontend/./about.component.ts','frontend\\about.component.ts','/routes/login.ts','routes/.hidden.ts'])assert.throws(()=>validate(diff.replaceAll('routes/login.ts',p),{allowedFiles:[p],sources:{[p]:source}}));
});
