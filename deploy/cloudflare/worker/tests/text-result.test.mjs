import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyMcp} from '../src/policy.ts';

test('text-only clients receive account, pairing and live diagnostic details after privacy checks',async()=>{
 const origin='https://text-result.example.workers.dev';let sensitive=false;
 const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticId',GITHUB_CLIENT_SECRET:'synthetic-private-key',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:id=>id,get:()=>({fetch:async(url,init)=>{
  const path=new URL(url).pathname;
  if(path==='/abuse/check')return new Response(null,{status:204});
  if(path==='/account/auth-version')return Response.json({authVersion:0});
  if(path==='/usage/increment')return Response.json({});
  if(path==='/device/list')return Response.json({active:'synthetic',devices:[{id:'synthetic',online:true,agentVersion:'saved-version'}]});
  assert.equal(path,'/relay/dispatch');const envelope=JSON.parse(init.body),call=JSON.parse(envelope.payload);
  return Response.json({type:'response',request_id:envelope.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:call.id,result:{content:[{type:'text',text:'Diagnostic label'}],structuredContent:{ok:true,summary:'Diagnostic label',data:sensitive?{text:'password=synthetic-blocked-value'}:{version:'synthetic-version',stdout:'synthetic-output',entries:['synthetic.txt']}}}})});
 }})}};
 const call=async name=>{
  const response=await proxyMcp(new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})}),env,{audience:origin+'/mcp',userId:'5678',scope:['pcrc:read']},{accountId:'5678'});
  assert.equal(response.status,200);return (await response.json()).result;
 };
 for(const name of ['who_am_i','diagnose_connection','get_connection_status','run_diagnostic','list_workspace_entries']){
  const result=await call(name);assert.equal(result.isError,undefined);
  assert.deepEqual(JSON.parse(result.content.at(-1).text),result.structuredContent,name);
  assert.equal(result._meta,undefined);
 }
 sensitive=true;const rejected=await call('run_diagnostic');
 assert.equal(rejected.isError,true);assert.ok(!JSON.stringify(rejected).includes('synthetic-blocked-value'));
});
