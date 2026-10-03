import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import {createServer} from '../server.mjs';
async function withServer(fn){const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await fn(`http://127.0.0.1:${server.address().port}`);}finally{await new Promise(r=>server.close(r));}}
test('loopback API rejects cross-origin writes and hostile Host',()=>withServer(async base=>{
 assert.equal((await fetch(base+'/api/health')).status,200);
 const hostile=await new Promise((resolve,reject)=>{http.get(base+'/api/health',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);}); assert.equal(hostile,403);
 assert.equal((await fetch(base+'/api/analyze',{method:'POST',headers:{'content-type':'application/json',Origin:'https://evil.example'},body:'{}'})).status,403);
}));
test('API reports invalid media, malformed JSON, and missing route clearly',()=>withServer(async base=>{
 assert.equal((await fetch(base+'/api/analyze',{method:'POST',body:'{}'})).status,415);
 assert.equal((await fetch(base+'/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:'{'})).status,400);
 assert.equal((await fetch(base+'/missing')).status,404);
 assert.equal((await fetch(base+'/api/demo',{method:'POST',headers:{'content-type':'application/json'},body:'{"fixed":"false"}'})).status,400);
}));
test('API rejects oversized uploads',()=>withServer(async base=>{
 const response=await fetch(base+'/api/analyze',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({padding:'a'.repeat(2_000_001)})});assert.equal(response.status,413);
}));
