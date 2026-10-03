import { parse } from 'acorn';
import { normalizeCapture } from './traffic.mjs';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFixture } from '../fixtures/app.mjs';
import { crossActorReadOracle } from '../vendor/project67/executor/phase2Oracles.mjs';

export class InputError extends Error { constructor(message) { super(message); this.name = 'InputError'; this.statusCode = 400; } }
const id = (kind, value) => `${kind}_${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16)}`;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, label, max = 300) => { if (typeof value !== 'string' || value.length > max) throw new InputError(`${label} must be text up to ${max} characters.`); return value; };
const safeText = value => String(value ?? '').replace(/(?:bearer\s+)[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]').replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{10,}/g, '[REDACTED]').replace(/([?&](?:token|key|secret|password|authorization)=)[^\s&]*/gi, '$1[REDACTED]');
const clean = value => typeof value === 'string' ? safeText(value) : Array.isArray(value) ? value.map(clean) : plain(value) ? Object.fromEntries(Object.entries(value).map(([key,item])=>[key,clean(item)])) : value;
const allowedMethods = new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS']);
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  const queue=[node];
  while(queue.length) {
    const current=queue.pop(); visit(current);
    for(const [key,value] of Object.entries(current)) {
      if(key==='loc')continue;
      if(Array.isArray(value)) { for(const child of value)if(child&&typeof child.type==='string')queue.push(child); }
      else if(value&&typeof value.type==='string')queue.push(value);
    }
  }
}
function structuralSignals(handler) {
  if(!['ArrowFunctionExpression','FunctionExpression'].includes(handler?.type))return {assessment:'unknown',reason:'Referenced handlers are not resolved across files.',objectLookup:false,ownershipPredicate:false};
  const requestName=handler.params[0]?.type==='Identifier'?handler.params[0].name:null;
  const chain=node=>node?.type==='Identifier'?node.name:node?.type==='MemberExpression'&&!node.computed?`${chain(node.object)}.${node.property.name}`:'';
  const parameterAliases=new Set();
  const fromParameter=node=>{let found=false;walk(node,item=>{const name=chain(item);if(requestName&&name.startsWith(`${requestName}.params.`)||item.type==='Identifier'&&parameterAliases.has(item.name))found=true;});return found;};
  walk(handler.body,node=>{if(node.type==='VariableDeclarator'&&node.id?.type==='Identifier'&&fromParameter(node.init))parameterAliases.add(node.id.name);});
  const lookupLines=[],ownershipLines=[];
  walk(handler.body,node=>{
    const lookup=node.type==='MemberExpression'&&node.computed&&fromParameter(node.property)||node.type==='CallExpression'&&node.callee?.type==='MemberExpression'&&/^(findById|findUnique|findOne|get|loadById)$/.test(node.callee.property?.name)&&node.arguments.some(fromParameter);
    if(lookup)lookupLines.push(node.loc.start.line);
    if(['BinaryExpression'].includes(node.type)&&['===','!==','==','!='].includes(node.operator)) {
      const sides=[chain(node.left),chain(node.right)];
      if(sides.some(value=>/\.(owner|ownerId|tenant|tenantId|organizationId|userId)$/.test(value))&&sides.some(value=>requestName&&value.startsWith(`${requestName}.`)&&/\.(actor|user|userId|tenant|tenantId|organizationId|id)$/.test(value)))ownershipLines.push(node.loc.start.line);
    }
  });
  return {assessment:lookupLines.length?(ownershipLines.length?'visible-control-clue':'review-object-authorization'):'unknown',objectLookup:lookupLines.length>0,ownershipPredicate:ownershipLines.length>0,lookupLines:[...new Set(lookupLines)],ownershipLines:[...new Set(ownershipLines)],handlerSpan:{start:handler.loc.start.line,end:handler.loc.end.line},reason:lookupLines.length?(ownershipLines.length?'A parameter-derived object lookup and an ownership comparison are visible. Control flow and enforcement are not proven.':'A parameter-derived object lookup is visible without a recognized ownership comparison in the inline handler. Middleware or the data layer may enforce policy.'):'No supported parameter-derived object lookup was recognized; arbitrary handler behavior remains unresolved.'};
}
function declarations(content) {
  let ast;
  try { ast = parse(content, {ecmaVersion:'latest',sourceType:'module',locations:true}); }
  catch { try { ast = parse(content, {ecmaVersion:'latest',sourceType:'script',locations:true}); } catch { return null; } }
  const results = [], queue = [ast];
  while (queue.length) {
    const node = queue.pop();
    if (node.type === 'CallExpression' && node.callee?.type === 'MemberExpression' && !node.callee.computed && node.callee.object?.type === 'Identifier' && ['app','router'].includes(node.callee.object.name) && allowedMethods.has(node.callee.property?.name?.toUpperCase()) && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
      results.push({method:node.callee.property.name.toUpperCase(),path:node.arguments[0].value,line:node.loc.start.line,handler:node.arguments.at(-1)?.type === 'Identifier' ? node.arguments.at(-1).name : 'Inline handler',middleware:node.arguments.slice(1,-1).filter(arg=>arg.type==='Identifier').map(arg=>arg.name),securityAssessment:structuralSignals(node.arguments.at(-1))});
    }
    for (const [key,value] of Object.entries(node)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) { for (const item of value) if (item && typeof item.type === 'string') queue.push(item); }
      else if (value && typeof value.type === 'string') queue.push(value);
    }
  }
  return results.sort((a,b)=>a.line-b.line);
}
function routeMatches(pattern, pathname) {
  const a = pattern.split('/'), b = pathname.split('/');
  return a.length === b.length && a.every((part, i) => part.startsWith(':') ? /^[^/]+$/.test(b[i]) : part === b[i]);
}
export function analyze(input) {
  if (!plain(input)) throw new InputError('Analysis must be a JSON object.');
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 100) throw new InputError('Provide 1–100 source files.');
  if (input.capture !== undefined && input.traffic !== undefined) throw new InputError('Supply either traffic or capture, not both.');
  const normalizedCapture = input.capture !== undefined ? normalizeCapture(input.capture) : null;
  const traffic = normalizedCapture?.traffic ?? input.traffic;
  if (!Array.isArray(traffic) || traffic.length > 2000) throw new InputError('Traffic must contain at most 2,000 requests.');
  const revision = string(input.revision || 'unprovided', 'revision', 120);
  const paths = new Set(); let total = 0;
  const files = input.files.map(file => {
    if (!plain(file)) throw new InputError('Each source file must be an object.');
    const path = string(file.path, 'file path', 240);
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f]/.test(path) || paths.has(path)) throw new InputError('Source paths must be unique, safe relative paths.');
    paths.add(path);
    const content = string(file.content, 'file content', 300000); total += content.length;
    if (total > 2000000) throw new InputError('Source content exceeds the 2 MB limit.');
    return { path, content };
  });
  const context = input.context ?? {};
  if (!plain(context)) throw new InputError('Context must be an object.');
  const product = {
    name: string(context.name || 'Imported application', 'product name', 120),
    roles: context.roles ?? [], assets: context.assets ?? [],
    policy: string(context.policy || 'Owner authorization policy has not been supplied.', 'policy', 1500)
  };
  for (const key of ['roles','assets']) if (!Array.isArray(product[key]) || product[key].length > 30 || product[key].some(x => typeof x !== 'string' || x.length > 180)) throw new InputError(`${key} must be an array of at most 30 short text values.`);
  const rawAssumptions = context.assumptions ?? {};
  scenario(rawAssumptions, 7);
  const assumptions = Object.fromEntries(['baselineRecords','recordsPerDay','recordCap','responseCostPerRecord','dailyRevenue','disruptionDays','unresolvedDays','currency'].filter(key=>rawAssumptions[key] != null).map(key=>[key,rawAssumptions[key]]));
  const routes = [], evidence = [], findings = [], skippedFiles = [];
  for (const file of files) {
    if (!/\.(?:[cm]?js)$/i.test(file.path)) { skippedFiles.push({path:file.path,reason:'Unsupported source type; JavaScript .js/.mjs/.cjs only.'}); continue; }
    const parsed = declarations(file.content);
    if (!parsed) { skippedFiles.push({path:file.path,reason:'JavaScript could not be parsed; declarations unresolved.'}); continue; }
    for (const declaration of parsed) {
      const {line,method,path,middleware,handler,securityAssessment} = declaration;
      securityAssessment.ruleId='XANDER-JS-OBJECT-AUTHZ-001';
      securityAssessment.category='Object-level authorization review';
      securityAssessment.middlewareClues=middleware.filter(name=>/(auth|tenant|owner|access|permission|role|session)/i.test(name)).map(name=>({name,kind:'middleware-name-clue',verified:false}));
      if (!path.startsWith('/') || path.length > 240 || /[?*(){}]/.test(path)) continue;
      if (routes.length >= 1000) throw new InputError('Source exceeds the supported limit of 1,000 route declarations. Reduce the imported scope.');
      const contentHash = id('content',file.content);
      const routeId = id('route', [revision, contentHash, file.path, line, method, path]);
      const ev = {id:id('source',[revision,contentHash,file.path,line]),kind:'source',label:`${file.path}:${line}`,file:file.path,line,revision,detail:`AST-indexed Express-style declaration: ${method} ${path}. This does not establish execution or authorization behavior.`};
      evidence.push(ev);
      routes.push({ id:routeId,method,path,file:file.path,line,revision,handler,middleware,securityAssessment,mappingBasis:'AST Express-style declaration; binding identity unresolved',evidenceId:ev.id });
    }
  }
  const requests = traffic.map((request, index) => {
    if (!plain(request)) throw new InputError('Every traffic entry must be an object.');
    const method = string(request.method, 'HTTP method', 12).toUpperCase();
    if (!allowedMethods.has(method)) throw new InputError('Unsupported HTTP method.');
    const raw = string(request.url, 'request URL', 3000);
    let url; try { url = new URL(raw, 'http://capture.invalid'); } catch { throw new InputError('Invalid request URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new InputError('Traffic URLs must use HTTP(S) without embedded credentials.');
    if (!(normalizedCapture && request.status === null) && (!Number.isInteger(request.status) || request.status < 100 || request.status > 599)) throw new InputError('Each request requires an observed HTTP status (100–599).');
    const routeIds = routes.filter(r => r.method === method && routeMatches(r.path, url.pathname)).map(r => r.id);
    const requestId = id('request',[index,method,url.pathname,request.status]);
    const ev = { id:id('traffic',requestId),kind:'traffic',label:`${method} ${url.pathname}`,detail:`${request.status === null ? 'HTTP response status unknown' : `Observed HTTP ${request.status}`}. ${normalizedCapture ? `Capture request ID ${request.captureRequestId}; response structure ${request.responseMetadata?.schemaStatus || 'unknown'}; session ${request.actorAlias || 'unknown'} (identity unverified). ` : ''}URL query, headers and bodies are excluded from reports. A path match is correlation, not proof the handler executed.` };
    evidence.push(ev);
    return {id:requestId,method,path:url.pathname,status:request.status,...(normalizedCapture ? {captureRequestId:request.captureRequestId,responseObserved:request.responseObserved,observedAt:request.observedAt,requestObservedAt:request.requestObservedAt,responseObservedAt:request.responseObservedAt,sourceIndex:request.sourceIndex,actorAlias:request.actorAlias,actorAliasBasis:request.actorAliasBasis,responseMetadata:request.responseMetadata} : {}),routeIds,mappingStatus:routeIds.length === 1 ? 'correlated' : routeIds.length ? 'ambiguous' : 'unresolved',evidenceId:ev.id};
  });
  for (const route of routes.filter(r => /:[A-Za-z_]/.test(r.path) && r.securityAssessment.objectLookup)) {
    const request = requests.find(r => r.routeIds.length === 1 && r.routeIds[0] === route.id);
    findings.push({id:id('finding',[route.id,'ownership']),title:route.securityAssessment.ownershipPredicate?'Validate visible ownership control':'Object lookup has no visible ownership check',severity:'unrated',status:'candidate',summary:`${route.method} ${route.path}: ${route.securityAssessment.reason} This is a source review candidate, not a demonstrated weakness.`,consequence:'If a caller can access another organization’s private records, confidentiality and customer commitments could be affected. This has not been demonstrated for this import.',businessImpact:'Potential confidentiality impact; scope and business consequence are unknown until the owner confirms the resource policy.',ruleId:route.securityAssessment.ruleId,category:route.securityAssessment.category,resource:product.assets[0] || 'Object selected by route parameter',routeId:route.id,evidenceIds:[route.evidenceId,...(request ? [request.evidenceId] : [])],source:{file:route.file,line:route.line,revision,handlerSpan:route.securityAssessment.handlerSpan,lookupLines:route.securityAssessment.lookupLines,ownershipLines:route.securityAssessment.ownershipLines},request:request ? {method:request.method,path:request.path,status:request.status} : null,unknowns:['Does this resource require tenant ownership?','Does middleware or the data layer enforce that policy?','No imported project has been executed or probed.']});
  }
  const mappedRequests = requests.filter(r => r.mappingStatus === 'correlated').length;
  const coverage = {sourceFiles:files.length,indexedSourceFiles:files.length-skippedFiles.length,skippedFiles,routeCount:routes.length,observedRoutes:new Set(requests.filter(r => r.mappingStatus === 'correlated').flatMap(r => r.routeIds)).size,mappedRequests,unresolvedRequests:requests.length-mappedRequests,limitations:['Only parseable JavaScript literal app/router Express-style route declarations are indexed using Acorn. TypeScript, mount prefixes, computed paths, decorators, aliases, binding identity and cross-file handler resolution remain unresolved.','Correlation does not establish that a specific source handler executed.','Imported source is never executed. No uploaded finding is verified automatically.','Response bodies, cookies and authorization headers are not retained.']};
  return clean({id:id('analysis',[revision,files.map(f=>[f.path,id('content',f.content)]),requests]),mode:'uploaded',createdAt:new Date().toISOString(),product,summary:{routes:routes.length,requests:requests.length,mappedRequests,unresolvedRequests:coverage.unresolvedRequests,verifiedFindings:0,candidates:findings.length},routes,requests,evidence,findings,coverage,...(normalizedCapture ? {capture:normalizedCapture.metadata} : {}),unknowns:['Authorization and business policies need owner confirmation.','Static analysis is a narrow route index, not a complete security audit.',...(revision==='unprovided' ? ['Source revision was not supplied.'] : [])],assumptions});
}

export function scenario(assumptions = {}, days = 7) {
  if (!plain(assumptions)) throw new InputError('Assumptions must be a JSON object.');
  if (!Number.isFinite(days) || days <= 0 || days > 36500) throw new InputError('Scenario duration must be between 0 and 36,500 days.');
  const keys = ['baselineRecords','recordsPerDay','recordCap','responseCostPerRecord','dailyRevenue','disruptionDays','unresolvedDays'];
  for (const key of keys) if (assumptions[key] != null && (!Number.isFinite(assumptions[key]) || assumptions[key] < 0 || assumptions[key] > 1e12)) throw new InputError(`${key} must be a nonnegative finite number, or omitted.`);
  const currency = assumptions.currency ?? 'USD';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new InputError('Currency must be a three-letter uppercase code.');
  const present = key => typeof assumptions[key] === 'number';
  if (present('recordCap') && present('baselineRecords') && assumptions.recordCap < assumptions.baselineRecords) throw new InputError('recordCap cannot be below baselineRecords.');
  const exposedRecords = present('baselineRecords') && present('recordsPerDay') ? Math.min(assumptions.baselineRecords + assumptions.recordsPerDay * days, present('recordCap') ? assumptions.recordCap : Infinity) : null;
  const responseCost = exposedRecords !== null && present('responseCostPerRecord') ? exposedRecords * assumptions.responseCostPerRecord : null;
  const revenueAtRisk = present('dailyRevenue') && present('disruptionDays') ? assumptions.dailyRevenue * Math.min(days,assumptions.disruptionDays) : null;
  if ([exposedRecords,responseCost,revenueAtRisk].some(value => value !== null && (!Number.isFinite(value) || value > Number.MAX_SAFE_INTEGER))) throw new InputError('Scenario arithmetic exceeds the supported numeric range.');
  return {days,kind:exposedRecords === null && revenueAtRisk === null ? 'qualitative' : 'conditional',currency,exposedRecords,potentiallyReachableRecords:exposedRecords,responseCost,revenueAtRisk,missing:keys.filter(key=>key!=='unresolvedDays'&&!present(key)),conditions:['Illustrative conditional scenario, not a breach prediction or probability.','Potentially reachable records are baselineRecords plus new records per day while unresolved, bounded by an optional cap. This is not a count of accessed or stolen records.','Response cost applies only if all modeled records require the supplied response effort; it is not a loss estimate.','Revenue at risk assumes a separate owner-supplied disruption duration; it is not automatically caused by data exposure.','Open duration means an explicitly chosen finite unresolved period. First observed is not the start of exposure.','A fix stops future accumulation; it does not undo any prior disclosure.'],formula:{exposedRecords:'min(baselineRecords + recordsPerDay × days, optional recordCap)',responseCost:'modeled records × responseCostPerRecord',revenueAtRisk:'dailyRevenue × min(days, disruptionDays)'}};
}

export function evaluateFixtureProof({owner,baseline,nonVictim,attacker,anon,profile}) {
  const contains = (response, token) => response?.status === 200 && response.body?.includes(token);
  const ownerPassed = contains(owner,'SOUTH_PRIVATE_INVOICE_91B38F');
  const baselinePassed = contains(baseline,'NORTH_PRIVATE_INVOICE_48E29A') && !baseline.body.includes('SOUTH_PRIVATE_INVOICE_91B38F');
  const nonVictimPassed = contains(nonVictim,'WEST_PRIVATE_INVOICE_78C62E') && !nonVictim.body.includes('SOUTH_PRIVATE_INVOICE_91B38F');
  const profilePassed = contains(profile,'north');
  const anonymousPassed = anon?.status === 401 && !anon.body?.includes('SOUTH_PRIVATE_INVOICE_91B38F');
  const legitimatePassed = Boolean(ownerPassed && baselinePassed && nonVictimPassed && profilePassed && anonymousPassed);
  const oracle = crossActorReadOracle({kind:'cross_actor_read',canary:'SOUTH_PRIVATE_INVOICE_91B38F',target_endpoint:'/api/invoices/:id'}, {responseA:attacker,responseB:owner,baselineA:baseline,control:nonVictim});
  const verdict = !legitimatePassed ? 'inconclusive' : oracle.verdict === 'confirmed' ? 'confirmed' : attacker?.status === 403 && oracle.verdict === 'refuted' ? 'refuted' : 'inconclusive';
  return {oracle,verdict,legitimatePassed,ownerPassed,baselinePassed,nonVictimPassed,profilePassed,anonymousPassed};
}

export async function runDemo({fixed = false} = {}) {
  if (typeof fixed !== 'boolean') throw new InputError('fixed must be a boolean.');
  const source = await readFile(new URL('../fixtures/app.mjs', import.meta.url), 'utf8');
  const app = createFixture({fixed});
  const server = app.listen(0,'127.0.0.1');
  await new Promise((resolve,reject)=>{ server.once('listening',resolve);server.once('error',reject); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const captures = [];
  async function get(path, actor) {
    const response = await fetch(base+path,{headers:actor?{'x-demo-actor':actor}:{},signal:AbortSignal.timeout(3000),redirect:'error'});
    const body = await response.text(); captures.push({method:'GET',url:path,status:response.status}); return {status:response.status,body};
  }
  let owner, baseline, attacker, anon, profile, nonVictim;
  try {
    owner = await get('/api/invoices/inv-south','south');
    nonVictim = await get('/api/invoices/inv-west','west');
    baseline = await get('/api/invoices/inv-north','north');
    attacker = await get('/api/invoices/inv-south','north');
    anon = await get('/api/invoices/inv-south');
    profile = await get('/api/profile','north');
  } finally { await new Promise(resolve=>server.close(resolve)); }
  const analysis = analyze({files:[{path:'fixtures/app.mjs',content:source}],revision:id('fixture',[source,{fixed}]),traffic:captures,context:{name:'Meridian Billing · synthetic demo',roles:['North tenant member','South tenant member','West tenant member','Unauthenticated visitor'],assets:['Private customer invoices'],policy:'A tenant member may read only invoices owned by their organization.',assumptions:{currency:'USD',baselineRecords:2400,recordsPerDay:40,recordCap:5000,responseCostPerRecord:8,dailyRevenue:2000,disruptionDays:2,unresolvedDays:90}}});
  const {oracle,verdict,legitimatePassed,ownerPassed,baselinePassed,nonVictimPassed,profilePassed,anonymousPassed} = evaluateFixtureProof({owner,baseline,nonVictim,attacker,anon,profile});
  const proofId = id('proof',[analysis.id,fixed,verdict]);
  analysis.mode = 'demo'; analysis.demo = {synthetic:true,fixed,networkScope:'Ephemeral server bound to 127.0.0.1; six fixed read-only requests.',assumptionsLabel:'Illustrative synthetic inputs. Replace with owner-supplied values.'};
  analysis.evidence.push({id:proofId,kind:'proof',label:'Local cross-tenant differential test',detail:`${verdict}; exact synthetic victim-canary comparison with legitimate owner, own-object, authenticated non-victim, anonymous and profile controls. No production target was contacted.`});
  const finding = analysis.findings[0];
  const crossTenantRequest = analysis.requests[3];
  finding.request = {id:crossTenantRequest.id,method:crossTenantRequest.method,path:crossTenantRequest.path,status:crossTenantRequest.status,evidenceId:crossTenantRequest.evidenceId,actor:'North tenant member',resourceOwner:'South tenant member',purpose:'Cross-tenant authorization attempt'};
  finding.evidenceIds = [analysis.routes.find(route=>route.id===finding.routeId).evidenceId,crossTenantRequest.evidenceId];
  Object.assign(finding,{title:fixed?'Invoice ownership control blocks cross-tenant reads':'A tenant can read another customer’s private invoice',severity:fixed?'informational':'high',status:verdict==='confirmed'?'verified':verdict==='refuted'?'rejected':'inconclusive',summary:fixed?'The protected fixture denies North’s request for South’s invoice while both legitimate invoice reads and the profile operation still succeed.':'The local vulnerable fixture returned South’s exact private invoice canary to North. The canary was absent from North’s own invoice and West’s authenticated control.',consequence:fixed?'This exact cross-tenant request was blocked while legitimate operations worked. This control does not prove the application is secure or undo possible earlier disclosure.':'A demonstrated cross-tenant invoice leak breaks customer confidentiality. Potential follow-on consequences include response work and trust loss; legal duties and production scope require owner review.',businessImpact:'Customer invoice confidentiality is affected in the synthetic vulnerable variant. Financial scenarios remain conditional and independent of proof confidence.',evidenceIds:[...finding.evidenceIds,proofId],unknowns:['Production reachability, affected record count and contractual duties are unknown.','Financial values are illustrative synthetic assumptions, not a loss forecast.'],proof:{verdict,oracle:'Project67 crossActorReadOracle',fixed,legitimatePassed,contentMatch:oracle.evidence.content_match === true,evidence:oracle.evidence,controls:[{name:'West reads own invoice (non-victim control)',status:nonVictim.status,passed:nonVictimPassed},{name:'South reads own invoice',status:owner.status,passed:ownerPassed},{name:'North reads own invoice',status:baseline.status,passed:baselinePassed},{name:'North attempts South invoice',status:attacker.status,passed:fixed?attacker.status===403:oracle.verdict==='confirmed'},{name:'Anonymous request denied',status:anon.status,passed:anonymousPassed},{name:'Legitimate profile operation',status:profile.status,passed:profilePassed}],timeline:['candidate','supported','tested',verdict==='confirmed'?'verified':verdict==='refuted'?'rejected':'inconclusive']}});
  analysis.summary.verifiedFindings = finding.status==='verified'?1:0; analysis.summary.candidates = 0;
  analysis.unknowns = ['Demo results apply only to the isolated synthetic fixture. No production security assessment has been performed.','A passing protected control refutes this exact attempt; it does not prove the whole application secure.'];
  return clean(analysis);
}
