import test from 'node:test';
import assert from 'node:assert/strict';
import {config,proxyMcp,escaped,boundedBody,controlRequired} from '../src/policy.ts';
import {authorization,consentPage} from '../src/authorization.ts';
import {authenticatedGitHubId} from '../src/account_identity.ts';
export const env={JAN_PUBLIC_ORIGIN:'https://jan-gateway.example.workers.dev',JAN_ORIGIN:'https://one-two-three-four.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClientId',GITHUB_CLIENT_SECRET:'synthetic-secret-for-tests',ALLOWED_GITHUB_ID:'1234'};
const auth={audience:env.JAN_PUBLIC_ORIGIN+'/mcp',scope:['jan:read'],userId:'1234'};

test('legacy HTTP clients receive text details only after output privacy checks',async()=>{
 let sensitive=false;
 const fetcher=async()=>Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'Status label'}],structuredContent:{ok:true,summary:'Status label',data:{value:sensitive?'password=synthetic-private-value':'synthetic-output'}}}});
 const request=()=>req({body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_connection_status',arguments:{}}})});
 let result=(await (await proxyMcp(request(),env,auth,{githubId:'1234'},fetcher)).json()).result;
 assert.deepEqual(JSON.parse(result.content.at(-1).text),result.structuredContent);
 sensitive=true;result=(await (await proxyMcp(request(),env,auth,{githubId:'1234'},fetcher)).json()).result;
 assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes('synthetic-private-value'));
});

test('document reviews and receipts are read only while application requires control',()=>{
  const tool=name=>new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}}));
  for(const name of ['inspect_document_pdf','preview_document_workflow','get_document_workflow','jan_inspect_document_pdf','jan_preview_document_workflow','jan_get_document_workflow'])assert.equal(controlRequired(tool(name)),false,name);
  for(const name of ['apply_document_workflow','jan_apply_document_workflow'])assert.equal(controlRequired(tool(name)),true,name);
});

test('task and workflow inspection remain read only; reservations and replay require control',()=>{
  const tool=name=>new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}}));
  for(const name of ['list_tasks','list_workflows','inspect_workflow','stop_search'])assert.equal(controlRequired(tool(name)),false,name);
  for(const name of ['create_task','claim_task','renew_task','finish_task','reconcile_task','teach_browser_workflow','publish_workflow','start_workflow_run','run_workflow_step'])assert.equal(controlRequired(tool(name)),true,name);
  assert.equal(controlRequired(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'app://pcrc/tasks/recent'}}))),false);
});
const req=(extra={})=>new Request(env.JAN_PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer user-oauth-token','Cookie':'private-cookie','Origin':'https://untrusted.example'},body:'{"jsonrpc":"2.0","method":"tools/list","id":1}',...extra});

test('standard MCP logging level negotiation does not request computer control',()=>{
  const body=new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',id:2,method:'logging/setLevel',params:{level:'warning'}}));
  assert.equal(controlRequired(body),false);
});

test('configuration rejects unsafe public and upstream URLs and missing identity',()=>{
  assert.equal(config(env).resource,auth.audience);
  for(const JAN_ORIGIN of ['http://127.0.0.1','https://127.0.0.1','https://evil.example','https://a.trycloudflare.com@evil.example','https://a.trycloudflare.com:8443','https://a.trycloudflare.com/path','https://a.trycloudflare.com?x=1']) assert.throws(()=>config({...env,JAN_ORIGIN}));
  for(const JAN_PUBLIC_ORIGIN of ['https://localhost','http://jan-gateway.example.workers.dev','https://jan-gateway.example.workers.dev/mcp']) assert.throws(()=>config({...env,JAN_PUBLIC_ORIGIN}));
  assert.throws(()=>config({...env,ALLOWED_GITHUB_ID:''}));
  assert.throws(()=>config({...env,JAN_PROXY_KEY:'short'}));
  for (const GITHUB_CLIENT_SECRET of [undefined,'','short']) assert.throws(()=>config({...env,GITHUB_CLIENT_SECRET}));
});

test('proxy requires the canonical audience, exact owner and scope before fetching',async()=>{
  const never=()=>assert.fail('Unauthorized request reached origin');
  for(const bad of [{...auth,userId:'999'},{...auth,audience:'https://elsewhere.example/mcp'},{...auth,scope:[]}]) assert.equal((await proxyMcp(req(),env,bad,{githubId:'1234'},never)).status,403);
  assert.equal((await proxyMcp(req(),env,auth,{githubId:'999'},never)).status,403);
});

test('public computer control fails closed when the protected relay is disabled',async()=>{
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_command',arguments:{command:'echo denied',confirmed:true}}});
  const response=await proxyMcp(req({body}),{...env,JAN_SITE_ROLE:'public'}, {...auth,scope:['jan:read','jan:control']},{githubId:'1234'},()=>assert.fail('Unprotected origin reached'));
  assert.equal(response.status,503);
});

test('OAuth identity is canonical and agrees with provider identity before account routing',()=>{
  assert.equal(authenticatedGitHubId('1234','1234'),'1234');
  assert.equal(authenticatedGitHubId('5678','5678'),'5678');
  for(const pair of [['1234','5678'],['01234','01234'],['0','0'],['9007199254740992','9007199254740992'],[1234,'1234'],['1234',undefined]]) {
    assert.equal(authenticatedGitHubId(...pair),null);
  }
});

test('MCP relay selects the authenticated account state and denies foreign claims',async()=>{
  const routed=[];
  const isolated={...env,JAN_RELAY_ENABLED:'1',DEVICES:{
    idFromName(name){routed.push(name);return name;},
    get(){return {fetch:async(_url,options)=>{
      if(String(_url).endsWith('/abuse/check'))return new Response(null,{status:204});if(String(_url).endsWith('/account/auth-version'))return Response.json({authVersion:0});
      const message=JSON.parse(options.body);
      return Response.json({type:'response',request_id:message.request_id,status:200,payload:'{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'});
    }};},
  }};
  assert.equal((await proxyMcp(req(),isolated,auth,{githubId:'1234'})).status,200);
  assert.deepEqual(routed.filter(x=>!x.startsWith('abuse:')),['1234','1234']);assert.equal(routed.length,3);
  assert.equal((await proxyMcp(req(),isolated,{...auth,userId:'5678'},{githubId:'5678'})).status,403);
  assert.equal((await proxyMcp(req(),isolated,auth,{githubId:'5678'})).status,403);
  assert.deepEqual(routed.filter(x=>!x.startsWith('abuse:')),['1234','1234']);assert.equal(routed.length,3);
});

test('proxy strips caller credentials and never follows redirects or forwards cookies',async()=>{
  let called=0;
  const response=await proxyMcp(req(),env,auth,{githubId:'1234'},async(url,options)=>{
    called++;assert.equal(url,env.JAN_ORIGIN+'/mcp');assert.equal(options.redirect,'manual');
    assert.equal(options.headers.get('Authorization'),'Bearer '+env.JAN_PROXY_KEY);
    for(const name of ['Cookie','Origin','X-Forwarded-Host']) assert.equal(options.headers.get(name),null);
    return new Response('{"result":"ok"}',{headers:{'Content-Type':'application/json','Set-Cookie':'secret=should-not-leave','Location':'https://evil.example'}});
  });
  assert.equal(called,1);assert.equal(response.status,200);assert.equal(response.headers.get('Set-Cookie'),null);assert.equal(response.headers.get('Location'),null);
  assert.equal(await response.text(),'{"result":"ok"}');
  assert.equal((await proxyMcp(req(),env,auth,{githubId:'1234'},async()=>Response.redirect('https://evil.example'))).status,502);
});

test('proxy rejects oversized bodies, query credentials and unexpected methods',async()=>{
  assert.equal((await proxyMcp(req({body:'x'.repeat(262145)}),env,auth,{githubId:'1234'})).status,413);
  assert.equal((await proxyMcp(new Request(env.JAN_PUBLIC_ORIGIN+'/mcp?token=bad'),env,auth,{githubId:'1234'})).status,400);
  assert.equal((await proxyMcp(new Request(env.JAN_PUBLIC_ORIGIN+'/mcp'),env,auth,{githubId:'1234'})).status,405);
  await assert.rejects(()=>boundedBody(new Request('https://example.invalid',{method:'POST',body:'hello'}),4));
});

test('consent escapes all client-controlled details',()=>{
  const html=consentPage({clientName:'<script>alert(1)</script>',clientDomain:'evil".example',redirectHost:'<img src=x>',redirectIsLoopback:false,scope:['jan:read']},'"/><script>');
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(html.includes('&#60;script&#62;'));
  assert.equal(escaped("'"),'&#39;');
});

function helpers(overrides={}) {
 const original={responseType:'code',clientId:'test',redirectUri:'https://client.example/callback',scope:['jan:read'],state:'client-state',resource:auth.audience,issuer:env.JAN_PUBLIC_ORIGIN,codeChallenge:'C'.repeat(43),codeChallengeMethod:'S256'};
 return {parseAuthRequest:async()=>original,describeConsent:async()=>({clientName:'Test client',redirectUri:original.redirectUri,redirectHost:'client.example',redirectIsLoopback:false,scope:['jan:read']}),beginConsent:async()=>({handle:'cookie-bound-handle',headers:new Headers({'Set-Cookie':'__Host-consent=test; Secure; HttpOnly; Path=/','X-Frame-Options':'DENY'})}),approveConsent:async()=>({request:original,headers:new Headers()}),beginUpstream:async(_req,{data})=>{assert.ok(data.verifier.length>=64);return {state:'cookie-bound-state',headers:new Headers()};},finishUpstream:async()=>({request:original,data:{verifier:'upstream-pkce-verifier'},headers:new Headers()}),completeAuthorization:async()=>({redirectTo:'https://client.example/callback?code=own-code'}),...overrides};
}
test('consent page has browser binding and restrictive security headers',async()=>{
 const handle='H'.repeat(43),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(handle))).toString('hex');
 const records=new Map();const OAUTH_KV={put:async(k,v)=>records.set(k,v),get:async k=>records.has(k)?JSON.parse(records.get(k)):null};
 const bindings={...env,OAUTH_KV,OAUTH_PROVIDER:helpers({beginConsent:async()=>({handle,headers:new Headers({'Set-Cookie':'__Host-oauth-consent-'+hash.slice(0,16)+'='+hash+'; Secure; HttpOnly; Path=/'})})})};
 const result=await authorization(new Request(env.JAN_PUBLIC_ORIGIN+'/authorize'),bindings);
 assert.equal(result.status,303);assert.ok(result.headers.get('Set-Cookie').includes('__Host-'));
 assert.equal(result.headers.get('Referrer-Policy'),'no-referrer');
 const location=result.headers.get('Location');
 const missing=await authorization(new Request(location),bindings);
 assert.equal(missing.status,400);assert.ok(!(await missing.text()).includes('name="decision"'));
 const display=await authorization(new Request(location,{headers:{Cookie:result.headers.get('Set-Cookie').split(';')[0]}}),bindings);
 assert.equal(display.status,200);
 assert.ok(display.headers.get('Content-Security-Policy').includes("frame-ancestors 'none'"));
 assert.equal(display.headers.get('Referrer-Policy'),'strict-origin');
 assert.ok(display.headers.get('Content-Security-Policy').includes("form-action 'self' https://github.com https://client.example;"));
});
test('consent POST requires same origin and delegates one-time validation to library',async()=>{
 const never=async()=>assert.fail('Untrusted consent reached helper');
 const request=new Request(env.JAN_PUBLIC_ORIGIN+'/authorize',{method:'POST',body:new URLSearchParams({handle:'h',decision:'approve'})});
 assert.equal((await authorization(request,{...env,OAUTH_PROVIDER:helpers({approveConsent:never})})).status,403);
 for(const origin of ['null','https://evil.example']) {
  const rejected=new Request(env.JAN_PUBLIC_ORIGIN+'/authorize',{method:'POST',headers:{Origin:origin},body:new URLSearchParams({handle:'h',decision:'approve'})});
  assert.equal((await authorization(rejected,{...env,OAUTH_PROVIDER:helpers({approveConsent:never})})).status,403);
 }
 const good=new Request(env.JAN_PUBLIC_ORIGIN+'/authorize',{method:'POST',headers:{Origin:env.JAN_PUBLIC_ORIGIN},body:new URLSearchParams({handle:'h',decision:'approve'})});
 const result=await authorization(good,{...env,OAUTH_PROVIDER:helpers()});
 assert.equal(result.status,200);
 const url=new URL((await result.text()).match(/href="(https:\/\/github\.com[^"]+)"/)[1].replaceAll('&#38;','&'));assert.equal(url.origin,'https://github.com');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('state'),'cookie-bound-state');
});
test('invalid PKCE requests fail before displaying consent',async()=>{
 const bad=helpers({parseAuthRequest:async()=>({resource:auth.audience,scope:['jan:read'],codeChallengeMethod:'plain',codeChallenge:'bad'})});
 assert.equal((await authorization(new Request(env.JAN_PUBLIC_ORIGIN+'/authorize'),{...env,OAUTH_PROVIDER:bad})).status,400);
});
test('GitHub callback denies every non-owner and never persists upstream tokens',async()=>{
 for(const id of [999,1234]) {
  let completed=false;
  const oauth=helpers({completeAuthorization:async options=>{completed=true;assert.equal(options.userId,'1234');assert.deepEqual(options.props,{githubId:'1234',authVersion:0});return {redirectTo:'https://client.example/callback?code=own-code'};}});
  const fetcher=async(url,options)=>url.includes('access_token')?Response.json({access_token:'upstream-identity-only-token'}):Response.json({id});
  const result=await authorization(new Request(env.JAN_PUBLIC_ORIGIN+'/callback?code=synthetic'),{...env,OAUTH_PROVIDER:oauth},fetcher);
  assert.equal(result.status,id===1234?302:403);assert.equal(completed,id===1234);assert.ok(!(await result.text()).includes('upstream-identity-only-token'));
 }
});

test('read grants cannot invoke control tools or forge the origin control header',async()=>{
 const never=()=>assert.fail('Read token reached a control operation');
 for (const name of ['jan_write_text','jan_edit_text','jan_run_command','jan_start_process','jan_session_output','jan_list_sessions','jan_browser','jan_desktop','jan_future_tool']) {
  const request=req({headers:{'Content-Type':'application/json','X-JAN-Control':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:{}}})});
  assert.equal((await proxyMcp(request,env,auth,{githubId:'1234'},never)).status,403);
 }
 const controlAuth={...auth,scope:['jan:read','jan:control']};
 const result=await proxyMcp(req({body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'jan_run_command',arguments:{command:'echo synthetic'}}})}),env,controlAuth,{githubId:'1234'},async(url,options)=>{
  assert.equal(options.headers.get('X-JAN-Control'),'1');return Response.json({ok:true});
 });
 assert.equal(result.status,200);
 await proxyMcp(req({headers:{'Content-Type':'application/json','X-JAN-Control':'1'}}),env,auth,{githubId:'1234'},async(url,options)=>{
  assert.equal(options.headers.get('X-JAN-Control'),'0');return Response.json({ok:true});
 });
});

test('batch and unsupported methods fail closed even with control scope',async()=>{
 for(const body of ['[]','null','{"jsonrpc":"2.0","method":"resources/read"}','{"jsonrpc":"2.0","method":"tools/call","params":{}}']) {
  assert.equal((await proxyMcp(req({body}),env,{...auth,scope:['jan:read','jan:control']},{githubId:'1234'},()=>assert.fail('Invalid message forwarded'))).status,400);
 }
});

test('read tokens can use safe task-server resources and prompts but not process output',async()=>{
 const forwarded=[];
 const fetcher=async(_url,options)=>{forwarded.push(JSON.parse(new TextDecoder().decode(options.body)));return Response.json({jsonrpc:'2.0',id:1,result:{contents:[]}});};
 for(const message of [
  {method:'resources/list'},
  {method:'resources/templates/list'},
  {method:'resources/read',params:{uri:'app://pcrc/files/readme.md'}},
  {method:'prompts/list'},
  {method:'prompts/get',params:{name:'find_and_review_file',arguments:{goal:'find readme'}}},
  {method:'completion/complete',params:{ref:{type:'ref/prompt',name:'find_and_review_file'},argument:{name:'goal',value:'find'}}},
 ]) {
  const result=await proxyMcp(req({body:JSON.stringify({jsonrpc:'2.0',id:1,...message})}),env,auth,{githubId:'1234'},fetcher);
  assert.equal(result.status,200,message.method);
 }
 assert.equal(forwarded.length,6);
 const process=req({body:JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'app://pcrc/processes/secret'}})});
 assert.equal((await proxyMcp(process,env,auth,{githubId:'1234'},()=>assert.fail('Read token reached process output'))).status,403);
});

test('2026 HTTP method headers cannot disagree with the JSON-RPC body',async()=>{
 const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{_meta:{'io.modelcontextprotocol/protocolVersion':'2026-07-28'}}});
 const headers={'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','Mcp-Method':'tools/call'};
 const result=await proxyMcp(req({headers,body}),env,auth,{githubId:'1234'},()=>assert.fail('Mismatched headers forwarded'));
 assert.equal(result.status,400);
});

test('control consent describes OS and screen access; read consent stays read-only',()=>{
 const details={clientName:'Test',redirectHost:'client.example',redirectIsLoopback:false,scope:['jan:read','jan:control']};
 assert.ok(consentPage(details,'handle').includes('Commands are not confined to the workspace'));
 assert.ok(consentPage({...details,scope:['jan:read']},'handle').includes('read-only grant cannot'));
});


test('non-owner reads never fall back to the global owner tunnel without relay',async()=>{
 for(const JAN_RELAY_ENABLED of [undefined,'0']){
  let originCalls=0;
  const settings={...env,JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_RELAY_ENABLED,DEVICES:{idFromName:id=>id,get:()=>({fetch:async url=>String(url).endsWith('/abuse/check')?new Response(null,{status:204}):String(url).endsWith('/account/auth-version')?Response.json({authVersion:0}):String(url).endsWith('/usage/increment')?Response.json({calls:1}):Response.json({enrolled:false,device:null})})}};
  const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'jan_read_text',arguments:{path:'synthetic.txt'}}});
  const response=await proxyMcp(req({body}),settings,{...auth,userId:'5678'},{githubId:'5678'},async()=>{originCalls++;return Response.json({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'synthetic owner data'}]}});});
  assert.equal(originCalls,0);const failure=await response.json();assert.equal(failure.result.isError,true);
  assert.doesNotMatch(JSON.stringify(failure),/synthetic owner data/);
 }
});
