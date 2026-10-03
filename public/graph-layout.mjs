// Logical relationship layout only. Position and routing convey no impact propagation.
export function layoutGraph(nodes,edges){
 const ordered=[...nodes].sort((a,b)=>a.id.localeCompare(b.id)),ids=new Set(ordered.map(n=>n.id));
 const links=edges.filter(e=>ids.has(e.from)&&ids.has(e.to)).sort((a,b)=>a.id.localeCompare(b.id));
 const adjacency=new Map(ordered.map(n=>[n.id,[]]));for(const e of links)adjacency.get(e.from).push(e.to);
 let index=0;const numbers=new Map(),low=new Map(),stack=[],onStack=new Set(),groups=[];
 function visit(id){numbers.set(id,index);low.set(id,index++);stack.push(id);onStack.add(id);for(const to of adjacency.get(id)){if(!numbers.has(to)){visit(to);low.set(id,Math.min(low.get(id),low.get(to)))}else if(onStack.has(to))low.set(id,Math.min(low.get(id),numbers.get(to)))}if(low.get(id)===numbers.get(id)){const group=[];let popped;do{popped=stack.pop();onStack.delete(popped);group.push(popped)}while(popped!==id);groups.push(group.sort())}}
 for(const n of ordered)if(!numbers.has(n.id))visit(n.id);
 groups.sort((a,b)=>a[0].localeCompare(b[0]));const groupById=new Map(groups.flatMap((g,i)=>g.map(id=>[id,i]))),ranks=new Map();
 function rank(g){if(ranks.has(g))return ranks.get(g);const incoming=links.filter(e=>groupById.get(e.to)===g&&groupById.get(e.from)!==g).map(e=>groupById.get(e.from));const value=incoming.length?Math.max(...incoming.map(x=>rank(x)+1)):0;ranks.set(g,value);return value}
 groups.forEach((_,g)=>rank(g));const maxRank=Math.max(0,...ranks.values()),columns=Math.min(4,maxRank+1),buckets=Array.from({length:columns},()=>[]);
 for(const n of ordered){const raw=ranks.get(groupById.get(n.id));buckets[Math.min(columns-1,raw)].push(n.id)}
 const nodeWidth=206,nodeHeight=82,columnPitch=300,rowPitch=128,top=54+Math.min(links.length,30)*5,left=36,width=Math.max(570,columns*columnPitch+30),maxRows=Math.max(1,...buckets.map(x=>x.length)),height=top+maxRows*rowPitch+36,positions=new Map();
 buckets.forEach((bucket,column)=>bucket.forEach((id,row)=>positions.set(id,{x:left+column*columnPitch,y:top+row*rowPitch,column,row})));
 const routes=links.map((edge,i)=>{const a=positions.get(edge.from),b=positions.get(edge.to),sy=a.y+nodeHeight/2,ty=b.y+nodeHeight/2;let points;
  if(a.column<b.column&&b.column===a.column+1){const x=a.x+nodeWidth+24+(i%5)*8;points=[[a.x+nodeWidth,sy],[x,sy],[x,ty],[b.x,ty]]}
  else if(a.column===b.column){const x=a.x+nodeWidth+24+(i%5)*8;points=[[a.x+nodeWidth,sy],[x,sy],[x,ty],[b.x+nodeWidth,ty]];if(edge.from===edge.to){points=[[a.x+nodeWidth,sy],[x,sy],[x,a.y-18],[a.x+nodeWidth/2,a.y-18],[a.x+nodeWidth/2,a.y]]}}
  else {const railY=24+(i%30)*5,outX=a.x+nodeWidth+24+(i%4)*7,inX=b.x-16-(i%3)*6;points=[[a.x+nodeWidth,sy],[outX,sy],[outX,railY],[inX,railY],[inX,ty],[b.x,ty]]}
  return{...edge,points,path:points.map(([x,y],j)=>`${j?'L':'M'}${x},${y}`).join(' ')};
 });
 return{width,height,nodeWidth,nodeHeight,positions,routes,cycles:groups.filter(g=>g.length>1),columns,maxRank};
}
export function wrapNodeLabel(label,maxCharacters=25){const words=String(label).split(/\s+/),lines=[''];for(const word of words){const i=lines.length-1;if((lines[i]+' '+word).trim().length<=maxCharacters)lines[i]=(lines[i]+' '+word).trim();else if(lines.length<2)lines.push(word);else{lines[1]=(lines[1]+' '+word).slice(0,maxCharacters-1)+'…';break}}return lines.map(x=>x.length>maxCharacters?x.slice(0,maxCharacters-1)+'…':x)}
