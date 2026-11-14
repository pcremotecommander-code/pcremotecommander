import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedRelayStatus} from '../src/relay_status.ts';
import {proxyMcp} from '../src/policy.ts';

for(const name of ['get_connection_status','get_capabilities'])test('only a correlated successful relayed '+name+' gains public-path evidence',()=>{
 const call={jsonrpc:'2.0',id:7,method:'tools/call',params:{name}};
 const structuredContent={ok:true,summary:'Backend only',data:{version:'synthetic',transport:'stdio',remote_enabled:false,live_remote_verified:null,capabilities:['files'],control_enabled:false,read_only:true}};
 const make=()=>({jsonrpc:'2.0',id:7,result:{structuredContent:structuredClone(structuredContent),content:[{type:'text',text:'Backend only'},{type:'text',text:JSON.stringify(structuredContent)}]}});
 const reply=make();verifiedRelayStatus(reply,call);
 const data=reply.result.structuredContent.data;
 assert.equal(data.remote_enabled,true);assert.equal(data.live_remote_verified,true);
 assert.equal(data.backend_transport,'stdio');assert.equal(data.remote_transport,'secure-websocket-relay');
 assert.equal(data.connection_details.remote_verification,data.connection_verification);
 assert.deepEqual(data.capabilities,['files']);assert.equal(data.control_enabled,false);assert.equal(data.read_only,true);
 assert.match(reply.result.structuredContent.summary,/this call/i);
 assert.ok(!JSON.stringify(reply.result.content).includes('remote_enabled'));
 for(const [value,request] of [[{...make(),id:8},call],[make(),{...call,params:{name:'read_file_excerpt'}}],[{...make(),error:{code:-32000}},call]]){
  const before=structuredClone(value);verifiedRelayStatus(value,request);assert.deepEqual(value,before);
 }
 const denied=make();denied.result.structuredContent.ok=false;const before=structuredClone(denied);
 verifiedRelayStatus(denied,call);assert.deepEqual(denied,before);
});

for(const name of ['get_connection_status','get_capabilities'])test(name+' evidence is added only on the authenticated relay path and survives text presentation',async()=>{
 const origin='https://status.example.workers.dev';
 const call={jsonrpc:'2.0',id:7,method:'tools/call',params:{name}};
 const payload=JSON.stringify({jsonrpc:'2.0',id:7,result:{content:[],structuredContent:{ok:true,summary:'Backend only',data:{transport:'stdio',remote_enabled:false,live_remote_verified:null}}}});
 const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://valid.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'synthetic',GITHUB_CLIENT_SECRET:'synthetic-secret',ALLOWED_GITHUB_ID:'1234',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:id=>id,get:()=>({fetch:async(url,init)=>{
  if(String(url).endsWith('/abuse/check')||String(url).endsWith('/usage/increment'))return new Response(null,{status:204});
  if(String(url).endsWith('/account/auth-version'))return Response.json({authVersion:0});
  const request=JSON.parse(init.body);return Response.json({type:'response',request_id:request.request_id,status:200,payload});
 }})}};
 const request=()=>new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(call)});
 const auth={audience:origin+'/mcp',userId:'1234',scope:['pcrc:read']},props={githubId:'1234'};
 const relayed=(await (await proxyMcp(request(),env,auth,props)).json()).result;
 assert.equal(relayed.structuredContent.data.live_remote_verified,true);
 assert.deepEqual(JSON.parse(relayed.content.at(-1).text),relayed.structuredContent);
 const direct=(await (await proxyMcp(request(),{...env,JAN_RELAY_ENABLED:'0'},auth,props,async()=>new Response(payload,{headers:{'Content-Type':'application/json'}}))).json()).result;
 assert.equal(direct.structuredContent.data.live_remote_verified,null);
 assert.equal(direct.structuredContent.data.remote_enabled,false);
});
