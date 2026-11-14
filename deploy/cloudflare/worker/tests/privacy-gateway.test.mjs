import test from 'node:test';
import assert from 'node:assert/strict';
import {proxyMcp} from '../src/policy.ts';

test('sensitive arguments never enter the approval queue and sensitive legacy results never reach the model',async()=>{
 const origin='https://privacy-test.example.workers.dev';let forwarded=0,output='ordinary synthetic output',rpcError=false;
 const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticId',GITHUB_CLIENT_SECRET:'synthetic-private-key',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:id=>id,get:()=>({fetch:async(url,init)=>{
  const path=new URL(url).pathname;if(path==='/abuse/check')return new Response(null,{status:204});if(path==='/account/auth-version')return Response.json({authVersion:0});if(path==='/usage/increment')return Response.json({});
  assert.equal(path,'/relay/dispatch');forwarded++;const envelope=JSON.parse(init.body),call=JSON.parse(envelope.payload);return Response.json({type:'response',request_id:envelope.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:call.id,...(rpcError?{error:{code:-32000,message:output}}:{result:{content:[{type:'text',text:output}]}})})});
 }})}};
 const auth={audience:origin+'/mcp',userId:'5678',scope:['pcrc:read','pcrc:control']};
 const call=async(name,args)=>{const r=await proxyMcp(new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}),env,auth,{accountId:'5678'});return r.json();};
 for(const args of [{path:'ordinary.txt',content:'password=synthetic-private-value'},{pin:1234},{otp:123456}]){
  const result=await call('create_text_file',args);assert.equal(result.result.structuredContent.error_code,'SENSITIVE_CONTENT_BLOCKED');assert.ok(!JSON.stringify(result).includes('synthetic-private-value'));assert.equal(forwarded,0);
 }
 output='password=synthetic-private-value';const rejected=await call('read_file_excerpt',{path:'ordinary.txt'});assert.equal(rejected.result.isError,true);assert.ok(!JSON.stringify(rejected).includes('synthetic-private-value'));assert.equal(forwarded,1);
 output='ordinary synthetic output';assert.equal((await call('read_file_excerpt',{path:'ordinary.txt'})).result.content[0].text,output);assert.equal(forwarded,2);
 output='password=synthetic-error-secret';rpcError=true;
 const error=await call('read_file_excerpt',{path:'ordinary.txt'});assert.equal(error.result.isError,true);assert.ok(!JSON.stringify(error).includes('synthetic-error-secret'));
 rpcError=false;
 const resource=await proxyMcp(new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:2,method:'resources/read',params:{uri:'app://pcrc/files/ordinary.txt'}})}),env,auth,{accountId:'5678'});
 const result=await resource.json();assert.equal(result.result.isError,true);assert.ok(!JSON.stringify(result).includes('synthetic-error-secret'));
});
