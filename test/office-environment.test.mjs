import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,stat,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {extractDocument} from '../lib/office-extract.mjs';
test('document worker receives only allowlisted environment, private temporary cwd and no bytecode writes',async()=>{
 const fixtureDir=await mkdtemp(join(tmpdir(),'vault-env-test-'));
 try{
  const probe=join(fixtureDir,'python-probe');
  await writeFile(probe,`#!/usr/bin/python3
import os,sys,json,stat
sys.stdin.buffer.read()
probe={'envKeys':sorted(os.environ.keys()),'cwd':os.getcwd(),'mode':stat.S_IMODE(os.stat(os.getcwd()).st_mode),'files':os.listdir(os.getcwd()),'args':sys.argv[1:]}
print(json.dumps({'ok':True,'data':{'kind':'text','status':'indexed','rows':[],'columns':[],'chunks':[],'warnings':[],'probe':probe}}))
`,{mode:0o700});
  process.env.XANDER_TEST_ONLY_SECRET_MARKER='dummy-private-marker';
  const result=await extractDocument('test.pdf',Buffer.from('%PDF-1.4'),{python:probe});
  const probeResult=result.probe;
  const stdout=JSON.stringify(probeResult);
  assert.deepEqual(probeResult.envKeys,['LANG','MALLOC_ARENA_MAX','NUMEXPR_NUM_THREADS','OMP_NUM_THREADS','OPENBLAS_NUM_THREADS','PATH','PYTHONNOUSERSITE'].sort());
  assert.equal(probeResult.mode,0o700);assert.deepEqual(probeResult.files,[]);assert.ok(probeResult.cwd.startsWith(join(tmpdir(),'xander-extract-')));assert.ok(probeResult.args.includes('-I'));assert.ok(probeResult.args.includes('-B'));assert.ok(!stdout.includes('dummy-regression-value'));assert.ok(!stdout.includes('dummy-private-marker'));await assert.rejects(stat(probeResult.cwd),{code:'ENOENT'});
  await writeFile(probe,`#!/usr/bin/python3
import os,sys,json
sys.stdin.buffer.read()
message='unexpected_secret_present' if 'AZURE_OPENAI_API_KEY' in os.environ or 'XANDER_TEST_ONLY_SECRET_MARKER' in os.environ else 'no_credentials_in_worker_error'
print(json.dumps({'ok':False,'code':'invalid','message':message}))
`,{mode:0o700});
  await assert.rejects(extractDocument('test.pdf',Buffer.from('%PDF-1.4'),{python:probe}),e=>e.message==='no_credentials_in_worker_error');
 }finally{delete process.env.XANDER_TEST_ONLY_SECRET_MARKER;await rm(fixtureDir,{recursive:true,force:true});}
});
