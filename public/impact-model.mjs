/** Curated logical-component model. No probes, inference requests or user records. */
export const sourceCommit = '36870cbbdfe7864698e1adf644c7bf772f67ebb7';
const source = (ref,label) => ({kind:'static-supported',ref,label,url:`https://github.com/juice-shop/juice-shop/blob/${sourceCommit}/${ref.replace(':','#L')}`});
const observed = path => ({kind:'observed',ref:'evidence/ordinary-capture-expanded.json',label:`Prior ordinary browser capture includes ${path}; route presence does not prove a dependency.`});
const effects = (journey,data,operation) => ({
 availability:{users:`People using ${journey} may be unable to complete that step.`,journeys:journey,data:'Availability alone does not imply disclosure, corruption or loss of stored records.',operations:operation,trust:'Repeated failures may reduce confidence; prevalence and sentiment are unmeasured.'},
 integrity:{users:`People using ${journey} may receive incorrect results if the affected values reach that workflow.`,journeys:journey,data:`Potentially incorrect ${data}; exact records and write scope require separate evidence.`,operations:`Reconcile affected records and review ${operation.toLowerCase()}`,trust:'Incorrect outcomes may undermine trust; no measured customer impact is available.'},
 confidentiality:{users:`People whose ${data} are in the demonstrated read scope may face disclosure.`,journeys:journey,data:`Only proven accessible ${data}; no assumption that other tables or customers are exposed.`,operations:'Establish actual read scope and retention before estimating affected people or response work.',trust:'Disclosure may affect confidence; legal duties and notification thresholds are unknown.'}
});
const node=(id,label,group,x,y,summary,ref,route,journey,data,operation)=>({id,label,group,x,y,summary,evidence:[source(ref,summary),...(route?[observed(route)]:[])],effects:effects(journey,data,operation)});
export const graph={id:'juice-shop-logical-v1',version:1,title:'Juice Shop · logical components',sourceCommit,
 nodes:[
 node('identity','Identity & session','Access',90,100,'Login creates a basket and registers the user session.','routes/login.ts:21','/rest/user/login','sign-in and authenticated shopping','account and session data','Assist customers who cannot sign in.'),
 node('catalog','Catalog & stock','Shopping',310,100,'Product search queries the Products table; stock quantity is checked during basket changes.','routes/search.ts:23','/rest/products/search','product discovery and selection','product descriptions, prices and quantities','Review stock and price discrepancies.'),
 node('basket','Shopping basket','Shopping',530,100,'Basket retrieval joins products; checkout reads the basket and its product entries.','routes/basket.ts:18','/rest/basket/:id','reviewing selected items','basket contents and item quantities','Reconcile incomplete or inconsistent baskets.'),
 node('checkout','Checkout','Purchase',530,300,'Order placement reads basket products, applies delivery pricing and writes an order record.','routes/order.ts:36','/rest/basket/:id/checkout','placing a new order','order totals and selected items','Reconcile incomplete orders and customer retries.'),
 node('payment','Payment selection','Purchase',310,300,'Saved card methods are local application records; this is not a verified external payment processor.','server.ts:433','/api/Cards','choosing a saved payment method','saved payment-method data','Help customers select a valid payment method.'),
 node('delivery','Address & delivery','Purchase',750,300,'The order uses a delivery method price and ETA and stores an address identifier.','routes/order.ts:117','/api/Deliverys','choosing delivery and an address','addresses, delivery prices and ETA','Review delivery choices and address corrections.'),
 node('orders','Orders & history','After purchase',750,500,'Order history reads the orders collection; new checkout writes that collection.','routes/orderHistory.ts:17','/rest/order-history','viewing purchase history','order contents and history','Reconcile orders and answer purchase-history enquiries.'),
 node('tracking','Order tracking','After purchase',980,500,'Tracking reads the same orders collection by order identifier.','routes/trackOrder.ts:18','/rest/track-order/:id','checking delivery progress','order status and ETA','Handle tracking enquiries and status corrections.'),
 node('storage','Relational storage','Shared dependency',90,500,'SQLite initializes users, baskets, products, cards and delivery models; orders use a separate collection.','models/index.ts:30',null,'data-backed shopping steps','only the affected SQLite tables','Restore database availability and reconcile affected writes.'),
 node('storefront','Storefront UI','Experience',980,100,'The browser presents shopping workflows. Aggregate UI coupling is curated; deployment isolation is not established.','frontend/src/app/app.routing.ts:109','/','navigating the storefront','displayed shopping information','Triage user-visible errors and provide status updates.')
 ],edges:[],limits:[
 'These are logical components of one monolithic app, not separately deployed microservices.',
 'Arrows describe conditional impact direction, not network request direction or proven exploit paths.',
 'Heat indicates potential scope under the selected premise, never breach probability or measured severity.',
 'Static source supports a dependency; observed traffic supports route presence only. Impact consequences remain conditional.',
 'Unreached components have unknown impact, not a demonstrated zero impact. No failure, disclosure or customer count was measured.',
 'Synthetic business-vault revenue is separate from this storefront database; no loss is calculated automatically.'
 ]};
const rule=(condition,confidence='static-supported')=>({condition,confidence});
const edge=(from,to,label,ref,transmission,architecture)=>({id:`${from}-${to}`,from,to,label,evidence:[source(ref,label)],architecture,transmission});
graph.edges=[
 edge('identity','basket','Session required for basket access','server.ts:350',{availability:rule('The session cannot be established or accepted; an existing valid session may continue.')},'Basket route depends on authentication middleware.'),
 edge('identity','checkout','Authenticated checkout access','server.ts:350',{availability:rule('The checkout request cannot pass authentication; not every login failure invalidates active sessions.')},'Checkout belongs to the protected /rest/basket route family.'),
 edge('catalog','basket','Basket reads product records','routes/basket.ts:18',{availability:rule('The underlying product-record read fails, rather than only the search endpoint.'),integrity:rule('Altered product values are returned by the basket product join.')},'Basket reads catalog data; a search-only outage need not affect baskets.'),
 edge('catalog','checkout','Checkout consumes product prices','routes/order.ts:36',{availability:rule('Product records needed for the order cannot be read.'),integrity:rule('The modified product price/name is consumed during order creation.')},'Checkout reads basket-associated products directly.'),
 edge('basket','checkout','Checkout consumes basket contents','routes/order.ts:36',{availability:rule('The selected basket or item data cannot be read.'),integrity:rule('Altered basket contents are accepted as order inputs.')},'Checkout reads the basket; impact flows from failed input to consumer.'),
 edge('delivery','checkout','Delivery amount enters order total','routes/order.ts:117',{availability:rule('The selected delivery-method database read fails.'),integrity:rule('Altered delivery price or ETA is accepted in the selected order.')},'Checkout reads the selected Delivery model.'),
 edge('checkout','orders','New orders inherit checkout values','routes/order.ts:154',{integrity:rule('Incorrect totals or products are committed to a new order record.')},'Checkout writes orders; this does not imply existing order-history outage.'),
 edge('orders','tracking','Tracking consumes order records','routes/trackOrder.ts:18',{availability:rule('The underlying orders collection is unavailable, not only the history endpoint.'),integrity:rule('The affected stored order is selected by the tracking query.')},'History and tracking share order records; UI-only history faults do not transfer.'),
 ...['identity','catalog','basket','payment','delivery'].map(to=>edge('storage',to,'Shared SQLite availability','models/index.ts:41',{availability:rule('The SQLite operation required by this component fails; a single-table issue may not satisfy this premise.')},`${to} uses a SQLite model; no confidentiality or integrity propagation is inferred across tables.`)),
 {...edge('payment','checkout','Saved payment selection may block purchase','server.ts:433',{availability:rule('The customer needs this saved-payment path and has no usable alternative.','inferred')},'Workflow coupling is curated; no processor or settlement dependency has been verified.'),evidence:[{kind:'inferred',ref:'curated:payment-journey',label:'Owner review needed: whether unavailable saved cards block this customer journey.'}]},
 {...edge('checkout','storefront','Purchase disruption affects experience','routes/order.ts:36',{availability:rule('Exploring an aggregate purchase-experience impact; other storefront pages may remain available.','inferred'),integrity:rule('Incorrect checkout results are displayed to a customer.','inferred')},'Curated experience relation, not shared process failure.'),evidence:[{kind:'inferred',ref:'curated:experience',label:'Possible customer experience effect; not an outage of the entire UI.'}]},
 {id:'payment-orders-unknown',from:'payment',to:'orders',label:'Settlement coupling unknown',evidence:[{kind:'unknown',ref:'gap:payment-settlement',label:'No external settlement or fulfilment integration has been established.'}],architecture:'Unverified business integration.',transmission:{availability:{condition:'Unknown: no verified settlement dependency.',confidence:'unknown'}}}
];
/** Bounded breadth-first traversal. Inferred links require explicit exploration; unknown links always stop. */
export function evaluateImpact(model,{nodeId,type='availability',exploreAssumptions=false}={}) {
 if(!['availability','integrity','confidentiality'].includes(type)) throw new TypeError('Unknown impact type');
 const nodes=Array.isArray(model?.nodes)?model.nodes:[],edges=Array.isArray(model?.edges)?model.edges:[];
 if(nodes.length>200||edges.length>1000) throw new RangeError('Graph exceeds bounded model limits');
 const index=new Map(nodes.map(n=>[n.id,n]));
 const base={nodeId:nodeId??null,type,affected:[],blocked:[],activeEdges:[],assumptions:[],limits:[...(model?.limits??[])],validSelection:index.has(nodeId)};
 if(!index.has(nodeId))return {...base,message:nodes.length?'Select a known component.':'No component evidence is available.'};
 const direct={nodeId,depth:0,level:'direct',confidence:'static-supported',via:[],explanation:'Selected hypothetical impact premise; this is not a verified finding.',effects:index.get(nodeId).effects?.[type]??{}};
 base.affected.push(direct);
 const visited=new Map([[nodeId,direct]]),queue=[direct],blocked=new Set();
 for(let i=0;i<queue.length;i++){
  const current=queue[i];
  for(const e of edges.filter(e=>e.from===current.nodeId)){
   const r=e.transmission?.[type];
   let reason=!index.has(e.to)?'Target component is unknown.':!r?'No supported transition for this impact type.':r.confidence==='unknown'?'Unknown dependency: propagation stops even in exploration.':!['static-supported','observed','inferred'].includes(r.confidence)?'Unsupported evidence classification.':!r.condition?'Missing transition precondition.':r.confidence==='inferred'&&!exploreAssumptions?'Inferred link: enable assumption exploration to consider it.':null;
   if(reason){if(!blocked.has(e.id)){base.blocked.push({edgeId:e.id,from:e.from,to:e.to,reason});blocked.add(e.id);}continue;}
   // Route observations alone cannot establish causal dependence.
   if(r.confidence==='observed'){base.blocked.push({edgeId:e.id,from:e.from,to:e.to,reason:'Observed requests alone do not establish an impact transition.'});continue;}
   base.activeEdges.push(e.id);base.assumptions.push({edgeId:e.id,condition:r.condition,confidence:r.confidence});
   if(visited.has(e.to))continue;
   const item={nodeId:e.to,depth:current.depth+1,level:'downstream',confidence:current.confidence==='inferred'||r.confidence==='inferred'?'inferred':'static-supported',via:[...current.via,e.id],explanation:r.condition,effects:index.get(e.to).effects?.[type]??{}};
   visited.set(e.to,item);queue.push(item);base.affected.push(item);
  }
 }
 return base;
}
