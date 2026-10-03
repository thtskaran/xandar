import test from 'node:test';
import assert from 'node:assert/strict';
import {graph,evaluateImpact} from '../public/impact-model.mjs';
const ids=result=>result.affected.map(n=>n.nodeId);
test('availability follows dependency impact direction, not call direction',()=>{
 const catalog=evaluateImpact(graph,{nodeId:'catalog',type:'availability'});
 assert.ok(ids(catalog).includes('checkout'));assert.ok(ids(catalog).includes('basket'));
 assert.ok(!ids(catalog).includes('storage'));assert.ok(!ids(catalog).includes('orders'));
 const checkout=evaluateImpact(graph,{nodeId:'checkout',type:'availability'});
 assert.deepEqual(ids(checkout),['checkout']);
});
test('integrity follows data consumption; confidentiality does not inherit connections',()=>{
 assert.deepEqual(new Set(ids(evaluateImpact(graph,{nodeId:'basket',type:'integrity'}))),new Set(['basket','checkout','orders','tracking']));
 for(const node of graph.nodes) assert.deepEqual(ids(evaluateImpact(graph,{nodeId:node.id,type:'confidentiality',exploreAssumptions:true})),[node.id]);
 assert.deepEqual(ids(evaluateImpact(graph,{nodeId:'storage',type:'integrity'})),['storage']);
});
test('inferred links require exploration, unknown stays blocked',()=>{
 const plain=evaluateImpact(graph,{nodeId:'payment',type:'availability'});
 assert.deepEqual(ids(plain),['payment']);assert.ok(plain.blocked.find(e=>e.edgeId==='payment-checkout'));
 const explored=evaluateImpact(graph,{nodeId:'payment',type:'availability',exploreAssumptions:true});
 assert.deepEqual(ids(explored),['payment','checkout','storefront']);
 assert.ok(explored.blocked.find(e=>e.edgeId==='payment-orders-unknown'));
 assert.equal(explored.affected.find(n=>n.nodeId==='storefront').confidence,'inferred');
});
test('cycles and parallel paths terminate and deduplicate affected components',()=>{
 const nodes=['a','b','c'].map(id=>({id,effects:{availability:{users:id}}}));
 const e=(id,from,to)=>({id,from,to,transmission:{availability:{condition:'Required record unavailable',confidence:'static-supported'}}});
 const result=evaluateImpact({nodes,edges:[e('ab','a','b'),e('ac','a','c'),e('bc','b','c'),e('ca','c','a')]},{nodeId:'a'});
 assert.deepEqual(ids(result),['a','b','c']);assert.equal(result.activeEdges.length,4);assert.equal(result.affected[2].depth,1);
});
test('empty imported graph, unknown selection and unsupported evidence stay bounded',()=>{
 assert.equal(evaluateImpact({nodes:[],edges:[]},{nodeId:'a'}).validSelection,false);
 assert.equal(evaluateImpact(graph,{nodeId:'absent'}).affected.length,0);
 assert.throws(()=>evaluateImpact(graph,{nodeId:'basket',type:'probability'}),TypeError);
 assert.throws(()=>evaluateImpact({nodes:Array(201).fill({id:'a'}),edges:[]},{nodeId:'a'}),RangeError);
 const imported={nodes:[{id:'a'},{id:'b'}],edges:[{id:'e',from:'a',to:'b',transmission:{availability:{condition:'Requests happened in order',confidence:'observed'}}}]};
 const r=evaluateImpact(imported,{nodeId:'a',exploreAssumptions:true});assert.deepEqual(ids(r),['a']);assert.match(r.blocked[0].reason,/alone/);
});
test('source provenance, effects and transition preconditions are present; graph stays unchanged',()=>{
 const before=JSON.stringify(graph);
 for(const n of graph.nodes){assert.ok(n.evidence.some(e=>e.kind==='static-supported'&&e.url.includes(graph.sourceCommit)));for(const type of ['availability','integrity','confidentiality'])for(const category of ['users','journeys','data','operations','trust'])assert.ok(n.effects[type][category]);}
 for(const edge of graph.edges){assert.ok(edge.architecture);assert.ok(edge.evidence.length);for(const t of Object.values(edge.transmission))assert.ok(t.condition);}
 evaluateImpact(graph,{nodeId:'storage',exploreAssumptions:true});assert.equal(JSON.stringify(graph),before);
});
