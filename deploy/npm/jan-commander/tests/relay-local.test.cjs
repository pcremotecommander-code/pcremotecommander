const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {performLocalCall}=require('../bin/relay-agent.cjs');
const uuid='c3e35d88-9749-4af8-8c13-0d097e89f77b';
const message={type:'request',request_id:uuid,control:false,payload:JSON.stringify({jsonrpc:'2.0',method:'ping',id:1})};
test('relay forwards harmless MCP ping to loopback with local authorization',async()=>{
 const server=http.createServer((req,res)=>{
   assert.equal(req.url,'/mcp');
   assert.equal(req.headers.authorization,'Bearer dummy-local-key');
   assert.equal(req.headers['x-jan-control'],'0');
   res.writeHead(200,{'content-type':'application/json'});
   res.end(JSON.stringify({jsonrpc:'2.0',id:1,result:{}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const reply=await performLocalCall(message,{port:server.address().port,key:'dummy-local-key'});
  assert.equal(reply.request_id,uuid);
  assert.equal(reply.status,200);
  assert.equal(JSON.parse(reply.payload).jsonrpc,'2.0');
 } finally {await new Promise(resolve=>server.close(resolve));}
});
test('relay does not return denied local calls as success',async()=>{
 const server=http.createServer((req,res)=>{res.writeHead(403);res.end('denied');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await assert.rejects(performLocalCall(message,{port:server.address().port,key:'dummy'}),error=>error.code==='LOCAL_REQUEST_REJECTED');}
 finally{await new Promise(resolve=>server.close(resolve));}
});

test('local server outages are classified without leaking bodies, while mismatched replies fail closed',async()=>{
 let mode='server';
 const server=http.createServer((req,res)=>{
  if(mode==='server'){res.writeHead(503);res.end('private local diagnostic');return;}
  res.writeHead(200,{'content-type':'application/json'});
  if(mode==='interrupted'){res.write('{"jsonrpc":');setTimeout(()=>res.destroy(),20);return;}
  res.end(JSON.stringify({jsonrpc:'2.0',id:999,result:{}}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  await assert.rejects(performLocalCall(message,{port:server.address().port,key:'dummy'}),error=>error.code==='LOCAL_SERVER_UNAVAILABLE'&&!String(error).includes('private local diagnostic'));
  mode='mismatch';await assert.rejects(performLocalCall(message,{port:server.address().port,key:'dummy'}),/Invalid MCP response/);
  mode='interrupted';await assert.rejects(performLocalCall(message,{port:server.address().port,key:'dummy'}),error=>error.code==='LOCAL_RESPONSE_INTERRUPTED');
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('relay preserves 2026 request headers and returns the final streamed MCP result',async()=>{
 const modern={type:'request',request_id:uuid,control:false,payload:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'search_workspace',arguments:{query:'readme'},_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}})};
 const server=http.createServer((req,res)=>{
  assert.equal(req.headers['mcp-protocol-version'],'2026-07-28');
  assert.equal(req.headers['mcp-method'],'tools/call');
  assert.equal(req.headers['mcp-name'],'search_workspace');
  res.writeHead(200,{'content-type':'text/event-stream'});
  res.write('data: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{progressToken:'p',progress:1}})+'\n\n');
  res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:7,result:{content:[{type:'text',text:'done'}]}})+'\n\n');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const reply=await performLocalCall(modern,{port:server.address().port,key:'dummy'});
  assert.equal(JSON.parse(reply.payload).result.content[0].text,'done');
 } finally {await new Promise(resolve=>server.close(resolve));}
});
