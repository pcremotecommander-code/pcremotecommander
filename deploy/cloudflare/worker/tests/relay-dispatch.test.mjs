import test from 'node:test';
import assert from 'node:assert/strict';
import {dispatchSelected} from '../src/relay_dispatch.ts';
import {required,developmentTools} from '../../../mcp-task-server/src/task-capabilities.ts';
import {createRequire} from 'node:module';
const {controlAllowed}=createRequire(import.meta.url)('../../../npm/jan-commander/bin/relay-agent.cjs');
const id='c3e35d88-9749-4af8-8c13-0d097e89f77b';
const valid={type:'request',request_id:id,control:false,payload:'{"jsonrpc":"2.0","method":"ping","id":1}'};
test('dispatch validates payload and routes to selected device',async()=>{
 let called=0;
 const session=()=>({online:true,forward:async()=>{called++;return {type:'response',request_id:id,status:200,payload:'{"jsonrpc":"2.0","id":1,"result":{}}'};}});
 assert.equal((await dispatchSelected(valid,id,{[id]:{revoked:false}},session)).status,200);
 assert.equal((await dispatchSelected({...valid,extra:1},id,{[id]:{}},session)).status,400);
 assert.equal(called,1);
});
test('dispatch denies revoked, offline, unselected devices',async()=>{
 assert.equal((await dispatchSelected(valid,null,{[id]:{}},()=>null)).status,503);
 assert.equal((await dispatchSelected(valid,id,{[id]:{revoked:true}},()=>null)).status,503);
 assert.equal((await dispatchSelected(valid,id,{[id]:{}},()=>({online:false,forward:async()=>null}))).status,503);
});
test('dispatch does not retry uncertain outcomes',async()=>{
 const response=await dispatchSelected(valid,id,{[id]:{}},()=>({online:true,forward:async()=>{throw Error('disconnected');}}));
 assert.equal(response.status,503);
 assert.match((await response.json()).error,/do not retry/i);
});

test('gateway capacity rejection is explicitly not executed and never retried',async()=>{
 let calls=0;
 const response=await dispatchSelected(valid,id,{[id]:{}},()=>({online:true,forward:async()=>{calls++;throw Error('Relay busy');}}));
 assert.equal(response.status,200);
 const envelope=await response.json(),rpc=JSON.parse(envelope.payload);
 assert.equal(envelope.request_id,id);
 assert.equal(rpc.id,1);
 assert.equal(rpc.error.code,-32001);
 assert.deepEqual(rpc.error.data,{error_code:'LOCAL_BUSY',executed:false,automatic_retry:false});
 assert.equal(calls,1);
});
test('read-only devices downgrade discovery but still deny control actions',async()=>{
 const forwarded=[];
 const session=()=>({online:true,forward:async message=>{forwarded.push(message);return {type:'response',request_id:id,status:200,payload:'{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'};}});
 const devices={[id]:{capabilities:['read']}};
 const discovery={...valid,control:true,payload:'{"jsonrpc":"2.0","method":"tools/list","id":1}'};
 assert.equal((await dispatchSelected(discovery,id,devices,session)).status,200);
 assert.equal(forwarded[0].control,false);
 const mutation={...discovery,payload:'{"jsonrpc":"2.0","method":"tools/call","params":{"name":"run_command"},"id":1}'};
 assert.equal((await dispatchSelected(mutation,id,devices,session)).status,403);
 assert.equal(forwarded.length,1);
});

test('missing or malformed device grants deny even AI-confirmed control requests',async()=>{
 let forwarded=0;
 const session=()=>({online:true,forward:async()=>{forwarded++;throw Error('must not forward');}});
 const mutation={...valid,control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',id:1,params:{name:'run_command',arguments:{command:'echo synthetic',confirmed:true}}})};
 for(const capabilities of [undefined,null,'control',{},[],['read']])
   assert.equal((await dispatchSelected(mutation,id,{[id]:{capabilities}},session)).status,403);
 assert.equal(forwarded,0);
});

test('each control tool needs its specific approved capability before forwarding',async()=>{
 let forwarded=0;
 const session=()=>({online:true,forward:async()=>{forwarded++;return {type:'response',request_id:id,status:204,payload:''};}});
 for(const [name,capability] of [...Object.entries(required),['toString','files'],['unknown_future_tool','files']]) {
   const call={...valid,control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',id:1,params:{name,arguments:{confirmed:true}}})};
   const needed=developmentTools.has(name)?[capability,'files']:[capability];
   assert.equal(controlAllowed(call,needed),Object.hasOwn(required,name),name+' local policy');
   if(developmentTools.has(name)){assert.equal(controlAllowed(call,['commands']),false);assert.equal(controlAllowed(call,['files']),false);assert.equal((await dispatchSelected(call,id,{[id]:{capabilities:['read','control','commands']}},session)).status,403);}
   assert.equal(controlAllowed(call,[]),false,name+' local empty grant');
   assert.equal((await dispatchSelected(call,id,{[id]:{capabilities:['read','control']}},session)).status,403,name);
   if(Object.hasOwn(required,name))assert.equal((await dispatchSelected(call,id,{[id]:{capabilities:['read','control',...needed]}},session)).status,200,name);
 }
 assert.equal(forwarded,Object.keys(required).length);
 const process={...valid,control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'resources/read',id:1,params:{uri:'app://pcrc/processes/synthetic'}})};
 assert.equal((await dispatchSelected(process,id,{[id]:{capabilities:['read','control','files']}},session)).status,403);
 assert.equal((await dispatchSelected(process,id,{[id]:{capabilities:['read','control','commands']}},session)).status,200);
 const stop={...valid,control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',id:1,params:{name:'jan_disable_control'}})};
 assert.equal((await dispatchSelected(stop,id,{[id]:{capabilities:['read','control']}},session)).status,403);
 for(const capability of ['files','commands','browser','desktop'])assert.equal((await dispatchSelected(stop,id,{[id]:{capabilities:['read','control',capability]}},session)).status,200);
});
