import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyMcp} from '../src/policy.ts';
import {JanDeviceStore} from '../src/device_store.ts';
const base='https://jan-gateway.example.workers.dev';
const key='A'.repeat(43);
const settings={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://valid.trycloudflare.com',JAN_PROXY_KEY:key,
GITHUB_CLIENT_ID:'abcdefgh123',GITHUB_CLIENT_SECRET:'very-secret-test-value',
ALLOWED_GITHUB_ID:'123456'};
const auth={audience:base+'/mcp',scope:['jan:read'],userId:'123456'};
const props={githubId:'123456'};
function req(){return new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({jsonrpc:'2.0',method:'ping',id:1})});}
test('opt-in relay dispatches only after valid OAuth owner context',async()=>{
 let calls=0;
 const env={...settings,JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:x=>x,get:()=>({fetch:async(url,options)=>{
  if(String(url).endsWith('/abuse/check'))return new Response(null,{status:204});if(String(url).endsWith('/account/auth-version'))return Response.json({authVersion:0});
  calls++; assert.match(String(url),/\/relay\/dispatch$/);
  const message=JSON.parse(options.body);
  assert.equal(message.control,false);
  return Response.json({type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{}})});
 }})}};
 const response=await proxyMcp(req(),env,auth,props,async()=>{throw Error('No tunnel expected');});
 assert.equal(response.status,200);assert.equal(calls,1);
 const denied=await proxyMcp(req(),env,{...auth,userId:'other'},props);
 assert.equal(denied.status,403);assert.equal(calls,1);
});
test('public tool calls stop at the shared per-account limit before relay dispatch',async()=>{
 const message={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'jan_read_text',arguments:{path:'marker.txt'}}};
 let dispatches=0;
 const env={...settings,JAN_SITE_ROLE:'public',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:x=>x,get:()=>({fetch:async url=>{
  if(String(url).endsWith('/abuse/check'))return new Response(null,{status:204});if(String(url).endsWith('/account/auth-version'))return Response.json({authVersion:0});
  if(String(url).endsWith('/usage/increment'))return Response.json({error:'rate limit'},{status:429});
  dispatches++;return Response.json({error:'unexpected'},{status:503});
 }})}};
 const response=await proxyMcp(new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)}),env,auth,props);
 assert.equal(response.status,429);assert.equal(response.headers.get('Retry-After'),'60');assert.equal(dispatches,0);
 const resetsAt=Date.now()+86400000;
 env.DEVICES.get=()=>({fetch:async url=>String(url).endsWith('/abuse/check')?new Response(null,{status:204}):String(url).endsWith('/account/auth-version')?Response.json({authVersion:0}):Response.json({error:'Monthly tool-call limit reached',resetsAt},{status:429})});
 const monthly=await proxyMcp(new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)}),env,auth,props);
 assert.equal(monthly.status,429);assert.match(await monthly.text(),/Monthly tool-call limit reached/);assert.ok(Number(monthly.headers.get('Retry-After'))>86000);assert.equal(dispatches,0);
 env.DEVICES.get=()=>({fetch:async()=>{throw Error('storage outage');}});
 assert.equal((await proxyMcp(new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)}),env,auth,props)).status,503);
 assert.equal((await proxyMcp(new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)}),{...settings,JAN_SITE_ROLE:'public',JAN_RELAY_ENABLED:'0'},auth,props,()=>assert.fail('Unmetered origin reached'))).status,503);
});
test('control-scoped catalog discovery reaches the local full-control catalog',async()=>{
 let observed;
 const env={...settings,JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:x=>x,get:()=>({fetch:async(url,options)=>{
  if(String(url).endsWith('/abuse/check'))return new Response(null,{status:204});if(String(url).endsWith('/account/auth-version'))return Response.json({authVersion:0});
  observed=JSON.parse(options.body);
  return Response.json({type:'response',request_id:observed.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{tools:[]}})});
 }})}};
 const response=await proxyMcp(new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}),env,{...auth,scope:['jan:read','jan:control']},props);
 assert.equal(response.status,200);
 assert.equal(observed.control,true);
});
test('opt-in relay fails closed when offline and does not use tunnel',async()=>{
 const env={...settings,JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:x=>x,get:()=>({fetch:async url=>String(url).endsWith('/abuse/check')?new Response(null,{status:204}):String(url).endsWith('/account/auth-version')?Response.json({authVersion:0}):Response.json({error:'offline'},{status:503})})}};
 const response=await proxyMcp(req(),env,auth,props,async()=>{throw Error('Tunnel must not be used');});
 assert.equal(response.status,503);
});
test('missing or offline computer gives a fixed actionable MCP error without request data',async()=>{
 for(const [relayError,code,phrase] of [
  ['No selected approved device','DEVICE_NOT_SELECTED','Use this computer'],
  ['Selected device offline','DEVICE_OFFLINE','keep its terminal open']
 ]) {
  const env={...settings,JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:x=>x,get:()=>({fetch:async url=>String(url).endsWith('/abuse/check')?new Response(null,{status:204}):String(url).endsWith('/account/auth-version')?Response.json({authVersion:0}):String(url).endsWith('/usage/increment')?Response.json({calls:1}):Response.json({error:relayError},{status:503})})}};
  const message={jsonrpc:'2.0',method:'tools/call',id:2,params:{name:'jan_read_text',arguments:{path:'private-marker.txt'}}};
  const request=new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)});
  const response=await proxyMcp(request,env,auth,props);
  assert.equal(response.status,200);
  const result=await response.json();
  assert.equal(result.result.isError,true);
  assert.match(JSON.stringify(result),new RegExp(code));
  assert.match(JSON.stringify(result),new RegExp(phrase));
  assert.ok(!JSON.stringify(result).includes('private-marker.txt'));
 }
});

test('catalog reads require control scope and reach the same relay catalog used for discovery',async()=>{
 let forwarded=[];
 const env={...settings,JAN_SITE_ROLE:'public',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:x=>x,get:()=>({fetch:async(url,options)=>{
  if(String(url).endsWith('/abuse/check'))return new Response(null,{status:204});
  if(String(url).endsWith('/account/auth-version'))return Response.json({authVersion:0});
  if(String(url).endsWith('/usage/increment'))return Response.json({calls:1});
  const envelope=JSON.parse(options.body);
  forwarded.push(envelope);
  return Response.json({type:'response',request_id:envelope.request_id,status:200,payload:'{"jsonrpc":"2.0","id":1,"result":{}}'});
 }})}};
 const call=name=>new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{path:'sample.pdf'}}})});
 for(const name of ['inspect_development','get_development_change','read_pdf','inspect_media','transcribe_audio','list_applications']){
  assert.equal((await proxyMcp(call(name),env,auth,props)).status,403);
  assert.equal((await proxyMcp(call(name),env,{...auth,scope:['pcrc:read','pcrc:control']},props)).status,200);
  assert.equal(forwarded.at(-1).control,true);
 }
 assert.equal(forwarded.length,6);
 assert.equal((await proxyMcp(call('run_diagnostic'),env,auth,props)).status,200);
 assert.equal(forwarded.at(-1).control,false);
});

test('catalog reads reach selected relay while PDF writes and app launches still pause',async()=>{
 const id=crypto.randomUUID();
 const values=new Map([['active',id],['devices',{[id]:{ownerId:'123456',capabilities:['read','control','files','commands']}}]]);
 const storage={get:async k=>values.get(k),put:async(k,v)=>values.set(k,v),transaction:async fn=>fn(storage)};
 const store=new JanDeviceStore({storage},settings);
 const observed=[];
 store.relay.getSession=()=>({online:true,forward:async message=>{
  observed.push(message);
  return {type:'response',request_id:message.request_id,status:200,payload:'{"jsonrpc":"2.0","id":1,"result":{"verified":true}}'};
 }});
 const send=name=>store.fetch(new Request('https://internal.invalid/relay/dispatch',{method:'POST',headers:{'X-Jan-Account-Id':'123456'},body:JSON.stringify({
  type:'request',request_id:crypto.randomUUID(),control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',id:1,params:{name,arguments:{path:'sample.pdf'}}})
 })}));
 const read=await (await send('read_pdf')).json();
 assert.equal(JSON.parse(read.payload).result.verified,true);
 const apps=await (await send('list_applications')).json();
 assert.equal(JSON.parse(apps.payload).result.verified,true);
 for(const name of ['inspect_development','get_development_change']){
  const read=await (await send(name)).json();
  assert.equal(JSON.parse(read.payload).result.verified,true,name);
 }
 for(const name of ['preview_development_change','apply_development_change']){
  const change=await (await send(name)).json();
  assert.match(JSON.parse(change.payload).result.content[0].text,/Action paused/,name);
 }
 const launch=await (await send('open_application')).json();
 assert.match(JSON.parse(launch.payload).result.content[0].text,/Action paused/);
 const write=await (await send('rewrite_pdf')).json();
 assert.match(JSON.parse(write.payload).result.content[0].text,/Action paused/);
 assert.equal(observed.length,4);
});

test('who_am_i uses authenticated identity and list_processes requires control scope',async()=>{
 const call=(name,arguments_={})=>new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:arguments_}})});
 let dispatched=0;
 const env={...settings,JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:x=>x,get:()=>({fetch:async(url,options)=>{
  if(String(url).endsWith('/abuse/check'))return new Response(null,{status:204});
  if(String(url).endsWith('/account/auth-version'))return Response.json({authVersion:0});
  if(String(url).endsWith('/usage/increment'))return new Response(null,{status:204});
  const message=JSON.parse(options.body);
  assert.equal(message.control,true);dispatched++;
  return Response.json({type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{}})});
 }})}};
 const identity=await proxyMcp(call('who_am_i',{account_id:'654321'}),env,auth,props);
 assert.deepEqual((await identity.json()).result.structuredContent.data,{authenticated_pcrc_account:true,account_id:'123456'});
 assert.equal((await proxyMcp(call('list_processes'),env,auth,props)).status,403);
 assert.equal(dispatched,0);
 assert.equal((await proxyMcp(call('list_processes'),env,{...auth,scope:['jan:read','jan:control']},props)).status,200);
 assert.equal(dispatched,1);
});


test('connection diagnosis reports selected device and scope without contacting its relay',async()=>{
 const request=()=>new Request(base+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'diagnose_connection'}})});
 let deviceState={active:'device',devices:[{id:'device',online:false,agentVersion:'0.7.0-beta.26',login:'private'}]};
 const env={...settings,JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:x=>x,get:()=>({fetch:async url=>{
  if(String(url).endsWith('/abuse/check')||String(url).endsWith('/usage/increment'))return new Response(null,{status:204});
  if(String(url).endsWith('/account/auth-version'))return Response.json({authVersion:0});
  assert.match(String(url),/\/device\/list$/);
  return Response.json(deviceState);
 }})}};
 const first=await (await proxyMcp(request(),env,auth,props)).json();
 assert.deepEqual(first.result.structuredContent.data,{account_id:'123456',status:'offline',
  agent_version:'0.7.0-beta.26',agent_version_source:'pairing_metadata',control_scope:false,portal:base+'/devices'});
 assert.match(first.result.structuredContent.summary,/pairing metadata/);
 assert.match(first.result.structuredContent.summary,/not.*current runtime version/);
 assert.ok(!JSON.stringify(first).includes('private'));
 deviceState.devices[0].online=true;
 const online=await (await proxyMcp(request(),env,auth,props)).json();
 assert.equal(online.result.structuredContent.data.status,'online');
 assert.equal(online.result.structuredContent.data.agent_version,'0.7.0-beta.26');
 assert.equal(online.result.structuredContent.data.agent_version_source,'pairing_metadata');
 assert.match(online.result.structuredContent.summary,/get_connection_status/);
 deviceState={devices:[]};
 const second=await (await proxyMcp(request(),env,auth,props)).json();
 assert.equal(second.result.structuredContent.data.status,'not_selected');
});
