'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const relayModule=path.resolve(process.env.PCRC_TEST_RELAY_MODULE||path.join(__dirname,'../bin/relay-agent.cjs'));

test('not-ready local MCP retries before opening a relay or announcing Ready',()=>{
 const script=String.raw`
  const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
  const controller=new AbortController();let attempts=0,sockets=0,ready=0;
  console.log=message=>{if(message.includes('Ready to work'))ready++;};console.error=()=>{};
  class Socket extends EventEmitter {
   static OPEN=1;
   constructor(){super();sockets++;this.readyState=1;setImmediate(()=>this.emit('open'));}
   addEventListener(name,fn,options){options?.once?this.once(name,fn):this.on(name,fn);}
   close(){this.readyState=3;this.emit('close');}ping(){}terminate(){this.close();}
  }
  const target=process.argv[1],wsPath=require.resolve('ws',{paths:[require('node:path').dirname(target)]});
  require.cache[wsPath]={id:wsPath,filename:wsPath,loaded:true,exports:Socket};
  global.fetch=async url=>{assert.ok(url.startsWith('https:'));return new Response('',{headers:{Date:new Date().toUTCString()}});};
  const {privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  require(target).run({credential:{privateKey:privateKey.export({type:'pkcs8',format:'pem'}),session:{worker:'https://current.example.workers.dev',id:crypto.randomUUID(),owner_id:'1234',protocol:2}},localKey:'a'.repeat(43),port:18866,signal:controller.signal,
   beforeConnect:async()=>{attempts++;assert.equal(sockets,0);assert.equal(ready,0);if(attempts<3)throw Error('Local not ready');},onOnline:()=>setImmediate(()=>controller.abort())
  }).then(()=>{assert.equal(attempts,3);assert.equal(sockets,1);assert.equal(ready,1);}).catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
 `;
 const result=spawnSync(process.execPath,['-e',script,relayModule],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr||String(result.error));
});

test('five concurrent relay requests return busy without dropping admitted work or closing the connection',()=>{
 const script=String.raw`
  const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
  const controller=new AbortController(),replies=[],calls=[];let connections=0,closedEarly=false;
  console.log=()=>{};console.error=()=>{};
  const packet=id=>({type:'request',control:true,request_id:crypto.randomUUID(),payload:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:'run_command',arguments:{command:'echo synthetic '+id,password:id===5?'never-echo-overload-secret':'',confirmed:true}}})});
  class Socket extends EventEmitter {
   static OPEN=1;
   constructor(){super();connections++;this.readyState=1;setImmediate(()=>{this.emit('open');setImmediate(()=>{for(let id=1;id<=5;id++)this.emit('message',{data:JSON.stringify(packet(id))});});});}
   addEventListener(name,fn,options){if(options?.once)this.once(name,fn);else this.on(name,fn);}
   send(value){
    replies.push(JSON.parse(value));
    if(replies.length===5)setImmediate(()=>this.emit('message',{data:JSON.stringify(packet(6))}));
    if(replies.length===6)controller.abort();
   }
   close(){if(this.readyState!==3){this.readyState=3;if(!controller.signal.aborted){closedEarly=true;controller.abort();}this.emit('close');}}
   terminate(){this.close();}ping(){this.emit('pong');}
  }
  const target=process.argv[1],wsPath=require.resolve('ws',{paths:[require('node:path').dirname(target)]});
  require.cache[wsPath]={id:wsPath,filename:wsPath,loaded:true,exports:Socket};
  global.fetch=async(url,options)=>{
   if(url.startsWith('https:'))return new Response('',{headers:{Date:new Date().toUTCString()}});
   const request=JSON.parse(options.body);calls.push(request.id);
   await new Promise(resolve=>setTimeout(resolve,30));
   return Response.json({jsonrpc:'2.0',id:request.id,result:{finished:request.id}});
  };
  const {privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const {run}=require(target);
  run({credential:{privateKey:privateKey.export({type:'pkcs8',format:'pem'}),session:{worker:'https://current.example.workers.dev',id:crypto.randomUUID(),name:'Synthetic PC',owner_id:'1234',protocol:2,capabilities:['read','control','commands']}},localKey:'a'.repeat(43),port:18866,enabledCapabilities:['commands'],signal:controller.signal}).then(async()=>{
   await new Promise(resolve=>setTimeout(resolve,60));
   assert.equal(closedEarly,false,'overload closed the transport and discarded admitted requests');
   assert.equal(connections,1);assert.deepEqual(calls,[1,2,3,4,6],'the excess request must not execute or be replayed');
   assert.equal(replies.length,6);
   const busy=JSON.parse(replies.find(reply=>JSON.parse(reply.payload).id===5).payload);
   assert.equal(busy.error.data.error_code,'LOCAL_BUSY');assert.equal(busy.error.data.executed,false);assert.equal(busy.error.data.automatic_retry,false);
   assert.ok(Buffer.byteLength(JSON.stringify(busy))<1024);
   for(const id of [1,2,3,4,6])assert.equal(JSON.parse(replies.find(reply=>JSON.parse(reply.payload).id===id).payload).result.finished,id);
   assert.ok(!JSON.stringify(replies).includes('never-echo-overload-secret'));
  }).catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
 `;
 const result=spawnSync(process.execPath,['-e',script,relayModule],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr||String(result.error));
});

test('one failed loopback request does not disconnect a concurrent successful request or replay a write',()=>{
 const script=String.raw`
  const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
  const controller=new AbortController(),replies=[],calls=[];let connections=0,closedEarly=false;
  console.log=()=>{};console.error=()=>{};
  class Socket extends EventEmitter {
   static OPEN=1;
   constructor(){super();connections++;this.readyState=1;setImmediate(()=>{this.emit('open');setImmediate(()=>{for(const id of [1,2])this.emit('message',{data:JSON.stringify({type:'request',control:id===1,request_id:crypto.randomUUID(),payload:JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name:id===1?'run_command':'get_connection_status',arguments:id===1?{command:'echo synthetic',confirmed:true}:{}}})})});});});}
   addEventListener(name,fn,options){if(options?.once)this.once(name,fn);else this.on(name,fn);}
   send(value){replies.push(JSON.parse(value));if(replies.length===2)controller.abort();}
   close(){if(this.readyState!==3){this.readyState=3;if(!controller.signal.aborted){closedEarly=true;controller.abort();}this.emit('close');}}
   terminate(){this.close();}ping(){this.emit('pong');}
  }
  const target=process.argv[1],wsPath=require.resolve('ws',{paths:[require('node:path').dirname(target)]});
  require.cache[wsPath]={id:wsPath,filename:wsPath,loaded:true,exports:Socket};
  global.fetch=async(url,options)=>{
   if(url.startsWith('https:'))return new Response('',{headers:{Date:new Date().toUTCString()}});
   const request=JSON.parse(options.body);calls.push(request.id);
   if(request.id===1){
    if(process.argv[2]==='server')return new Response('synthetic-private-network-detail',{status:503});
    if(process.argv[2]==='denied')return new Response('synthetic-private-network-detail',{status:400});
    if(process.argv[2]==='invalid')return Response.json({jsonrpc:'2.0',id:999,result:{private:'synthetic-private-network-detail'}});
    if(process.argv[2]==='malformed')return new Response('synthetic-private-network-detail',{headers:{'content-type':'application/json'}});
    if(process.argv[2]==='oversized')return new Response('synthetic-private-network-detail'.repeat(50000),{headers:{'content-type':'application/json'}});
    throw Error('synthetic-private-network-detail');
   }
   await new Promise(resolve=>setTimeout(resolve,30));
   return Response.json({jsonrpc:'2.0',id:2,result:{connected:true}});
  };
  const {privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const {run}=require(target);
  run({credential:{privateKey:privateKey.export({type:'pkcs8',format:'pem'}),session:{worker:'https://current.example.workers.dev',id:crypto.randomUUID(),name:'Synthetic PC',owner_id:'1234',protocol:2,capabilities:['read','control','commands']}},localKey:'a'.repeat(43),port:18866,enabledCapabilities:['commands'],signal:controller.signal}).then(async()=>{
   await new Promise(resolve=>setTimeout(resolve,50));
   assert.equal(closedEarly,false,'a single local request failure disconnected unrelated calls');
   assert.equal(connections,1);assert.deepEqual(calls,[1,2],'neither request, especially the write, may be replayed');
   assert.equal(replies.length,2);
   const failed=JSON.parse(replies.find(reply=>JSON.parse(reply.payload).id===1).payload);
   assert.equal(failed.error.data.outcome_unknown,true);assert.equal(failed.error.data.automatic_retry,false);
   const expected={network:'LOCAL_TRANSPORT_UNAVAILABLE',server:'LOCAL_SERVER_UNAVAILABLE',denied:'LOCAL_REQUEST_REJECTED',invalid:'LOCAL_RESPONSE_INVALID',malformed:'LOCAL_RESPONSE_INVALID',oversized:'LOCAL_RESPONSE_INVALID'};
   assert.equal(failed.error.data.error_code,expected[process.argv[2]]);
   assert.equal(JSON.parse(replies.find(reply=>JSON.parse(reply.payload).id===2).payload).result.connected,true);
   assert.ok(!JSON.stringify(replies).includes('synthetic-private-network-detail'));
  }).catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
 `;
 const failures=[];
 for(const mode of ['network','server','denied','invalid','malformed','oversized']){
  const result=spawnSync(process.execPath,['-e',script,relayModule,mode],{encoding:'utf8',timeout:15000});
  if(result.status!==0)failures.push(mode+': '+(result.stderr||String(result.error)));
 }
 assert.deepEqual(failures,[]);
});

test('terminal goes offline, reconnects and previews requests without changing forwarded payloads',()=>{
 const script=String.raw`
  const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),crypto=require('node:crypto');
  const controller=new AbortController(),lines=[];let connections=0,forwarded=0;
  console.log=(...args)=>lines.push(args.join(' '));console.error=()=>{};
  const request=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_command',arguments:{command:'echo synthetic',password:'never-print-password'}}});
  class Socket extends EventEmitter {
   static OPEN=1;
   constructor(){super();connections++;this.readyState=1;setImmediate(()=>{this.emit('upgrade',{headers:{'x-pcrc-account-id':'1234','x-pcrc-account-name':'test-owner'}});this.emit('open');setImmediate(()=>this.emit('message',{data:JSON.stringify({type:'request',control:true,request_id:crypto.randomUUID(),payload:request})}));});}
   addEventListener(name,fn,options){if(options?.once)this.once(name,fn);else this.on(name,fn);}
   send(value){const reply=JSON.parse(value);assert.equal(JSON.parse(reply.payload).result.apiKey,'never-print-key');if(connections===1)this.close();else controller.abort();}
   close(){if(this.readyState!==3){this.readyState=3;this.emit('close');}}
   terminate(){this.close();}
   ping(){this.emit('pong');}
  }
  const target=process.argv[1],wsPath=require.resolve('ws',{paths:[require('node:path').dirname(target)]});
  require.cache[wsPath]={id:wsPath,filename:wsPath,loaded:true,exports:Socket};
  global.fetch=async(url,options)=>{
   if(url.startsWith('https:'))return new Response('',{headers:{Date:new Date().toUTCString()}});
   assert.equal(options.body,request,'preview must not modify execution payload');forwarded++;
   return Response.json({jsonrpc:'2.0',id:1,result:{message:'synthetic result',apiKey:'never-print-key'}});
  };
  const {privateKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const {run}=require(target);
  run({credential:{privateKey:privateKey.export({type:'pkcs8',format:'pem'}),session:{worker:'https://current.example.workers.dev',id:crypto.randomUUID(),name:'Synthetic PC',owner_id:'1234',protocol:2,capabilities:['read','control','commands']}},localKey:'a'.repeat(43),port:18866,enabledCapabilities:['commands'],signal:controller.signal,livePreview:true}).then(()=>{
   assert.equal(connections,2);assert.equal(forwarded,2);
   const output=lines.join('\n');assert.match(output,/OFFLINE/);assert.match(output,/ONLINE/);assert.doesNotMatch(output,/Ready for requests|workflow skills|Transport:/);assert.match(output,/Ready to work/);assert.doesNotMatch(output,/Live request\/result previews/);assert.match(output,/test-owner/);assert.match(output,/REQUEST 1/);assert.match(output,/RESULT 2/);assert.doesNotMatch(output,/never-print/);
  }).catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
 `;
 const result=spawnSync(process.execPath,['-e',script,relayModule],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr||String(result.error));
});
