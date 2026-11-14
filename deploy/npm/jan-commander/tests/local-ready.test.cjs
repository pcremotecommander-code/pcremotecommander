'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {checkLocalReady}=require('../bin/pair-device.cjs');

test('readiness requires authenticated ping, catalog and backend status, not only health HTTP 200',async()=>{
 let mode='ready';const calls=[];
 const server=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer synthetic-local-key');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const rpc=JSON.parse(Buffer.concat(chunks));calls.push(rpc.method);
  const result=mode==='error'?{error:{code:-32000,message:'not ready'}}:{result:rpc.method==='tools/list'?{tools:mode==='empty'?[]:[{name:mode==='python'?'jan_status':'get_connection_status'}]}:rpc.method==='tools/call'&&mode==='backend-error'?{isError:true}:{}};
  if(rpc.method==='tools/call')assert.equal(rpc.params.name,mode==='python'?'jan_status':'get_connection_status');
  res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,...result}));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{
  const options={localKey:'synthetic-local-key',port:server.address().port,signal:new AbortController().signal};
  assert.equal(await checkLocalReady(options),true);assert.deepEqual(calls,['ping','tools/list','tools/call']);
  mode='python';assert.equal(await checkLocalReady(options),true);
  mode='empty';assert.equal(await checkLocalReady(options),false);
  mode='error';assert.equal(await checkLocalReady(options),false);
  mode='backend-error';assert.equal(await checkLocalReady(options),false);
  assert.ok(calls.every(method=>['ping','tools/list','tools/call'].includes(method)));
 }finally{await new Promise(resolve=>server.close(resolve));}
});
