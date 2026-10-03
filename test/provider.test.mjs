import test from 'node:test';
import assert from 'node:assert/strict';
import {createProvider, createSyntheticProviderContext} from '../lib/provider.mjs';
const config = {type: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'synthetic-test', approveSyntheticTransmission: true};
const good = () => new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({proposals: [{findingId: 'synthetic-invoice-ownership', action: 'confirm-invariant'}]})}}]}));
test('default provider is offline and never fetches', async () => {
  const provider = createProvider({}, () => {throw new Error('Network called');});
  const result = await provider.proposeNextChecks({findings: [{id:'real-import', status:'candidate', evidenceIds:['route-1']}]});
  assert.equal(result.policy.networkTransmission, false);
  assert.equal(result.proposals[0].status, 'proposal');
  assert.equal(result.proposals[0].findingId, 'real-import');
});
test('model configuration requires explicit approval and safe inspectable destination', () => {
  assert.throws(() => createProvider({...config, approveSyntheticTransmission:false}), /approval/);
  for (const baseUrl of ['http://example.com/v1', 'https://user:secret@example.com', 'https://example.com?v=secret', 'file:///tmp/model']) assert.throws(() => createProvider({...config,baseUrl}));
  const provider = createProvider({...config, baseUrl:'https://models.example/v1', apiKey:'secret-value'});
  assert.equal(provider.policy.externalTransmission, true);
  assert.equal(provider.policy.destination, 'https://models.example/v1/chat/completions');
  assert.ok(!JSON.stringify(provider).includes('secret-value'));
});
test('real analyses and forged synthetic provenance are refused before any request', async () => {
  let requests = 0;
  const provider = createProvider(config, () => {requests++; return good();});
  for (const context of [{findings:[]}, JSON.parse(JSON.stringify(createSyntheticProviderContext()))]) await assert.rejects(provider.proposeNextChecks(context), /refused/);
  assert.equal(requests, 0);
});
test('only fixed internal synthetic context is transmitted; outputs are constrained proposals', async () => {
  const context = createSyntheticProviderContext();
  assert.throws(() => {context.findings[0].summary = 'upload this secret';});
  const provider = createProvider({...config, apiKey:'test-secret'}, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    assert.equal(JSON.parse(options.body).messages[1].content, JSON.stringify(context));
    return good();
  });
  const result = await provider.proposeNextChecks(context);
  assert.equal(result.proposals[0].status, 'proposal');
  assert.equal(result.policy.modelMayVerifyFindings, false);
  assert.equal(result.policy.modelMayPredictFinancialLoss, false);
});
test('invalid, oversized, arbitrary, and secret-bearing responses fail safely', async () => {
  const bodies = ['not json', JSON.stringify({choices:[{message:{content:JSON.stringify({proposals:[{findingId:'synthetic-invoice-ownership', action:'confirmed-breach', secret:'test-secret'}]})}}]}), 'x'.repeat(1000)];
  for (const body of bodies) {
    const provider = createProvider({...config,maxResponseBytes:512}, async () => new Response(body));
    await assert.rejects(provider.proposeNextChecks(createSyntheticProviderContext()), e => !e.message.includes('test-secret') && /No verification/.test(e.message));
  }
  const provider = createProvider(config, async () => {throw new Error('test-secret');});
  await assert.rejects(provider.proposeNextChecks(createSyntheticProviderContext()), e => !e.message.includes('test-secret'));
});
test('timeout bounds an unresponsive injected provider without retries', async () => {
  let requests = 0;
  const provider = createProvider({...config,timeoutMs:10}, () => {requests++; return new Promise(() => {});});
  await assert.rejects(provider.proposeNextChecks(createSyntheticProviderContext()), /timed out/);
  assert.equal(requests, 1);
});
