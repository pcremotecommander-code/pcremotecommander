import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {totpCode} from '../src/owner_security.ts';
const require=createRequire(import.meta.url);
const {keys,proof}=require('../../../npm/jan-commander/bin/pair-device.cjs');
const {handshake}=require('../../../npm/jan-commander/bin/relay-agent.cjs');

const base='https://multi-runtime.example.workers.dev';
const bindings={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClientId',GITHUB_CLIENT_SECRET:'synthetic-secret-for-tests',ALLOWED_GITHUB_ID:'1234',JAN_PAIRING_ENABLED:'1',JAN_RELAY_ENABLED:'1',JAN_MULTI_USER_ENABLED:'1',JAN_BETA_GITHUB_IDS:'1234,5678'};
const cookie=response=>response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
const digest=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).toString('base64url');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('owner runtime routes account management through owner authentication',async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'owner',modules:true,script:readFileSync(new URL('../build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{DEVICES:{className:'JanDeviceStore',scriptName:'public-store',useSQLite:true}},bindings:{...bindings,JAN_SITE_ROLE:'owner',PCRC_OWNER_GITHUB_ID:'5678'},outboundService:async request=>{
    if(request.url==='https://github.com/login/oauth/access_token')return Response.json({access_token:'synthetic-provider-token'});
    if(request.url==='https://api.github.com/user')return Response.json({id:5678,login:'synthetic-new-owner'});
    throw Error('Unexpected provider');
  }},{name:'public-store',modules:true,script:readFileSync(new URL('../build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{DEVICES:{className:'JanDeviceStore',useSQLite:true}},bindings:{...bindings,JAN_SITE_ROLE:'public',PCRC_OWNER_GITHUB_ID:'5678'}}]}));
  try{
    const call=(route,init={})=>mf.dispatchFetch(base+route,{redirect:'manual',...init});
    const signedOut=await call('/admin/accounts');assert.equal(signedOut.status,403);assert.match(await signedOut.text(),/Owner sign-in required/);
    const start=await call('/owner/login'),state=new URL(start.headers.get('Location')).searchParams.get('state');
    const signedIn=await call('/callback?'+new URLSearchParams({state,code:'synthetic'}),{headers:{Cookie:cookie(start)}});
    assert.equal(signedIn.status,302);
    assert.match(cookie(signedIn),/__Host-JanPortal=1234\./,'owner sign-in retains the operator storage namespace');
    const page=await call('/admin/accounts',{headers:{Cookie:cookie(signedIn)}});
    assert.equal(page.status,303);assert.match(page.headers.get('Location'),/\/admin\/security$/);
    const security=await call('/admin/security',{headers:{Cookie:cookie(signedIn)}});
    const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await security.text())?.[1];assert.ok(csrf);
    const post=(route,data)=>call(route,{method:'POST',headers:{Cookie:cookie(signedIn),Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...data}).toString()});
    const setup=await post('/admin/security/setup',{});assert.equal(setup.status,200);
    const secret=/<code class="setup-key">([A-Z2-7]{32})<\/code>/.exec(await setup.text())?.[1];assert.ok(secret);
    const verified=await post('/admin/security/verify',{code:await totpCode(secret,Math.floor(Date.now()/30000))});
    assert.equal(verified.status,200);assert.match(await verified.text(),/recovery-codes/);
    assert.equal((await call('/admin',{headers:{Cookie:cookie(signedIn)}})).status,200);
  }finally{await mf.dispose();}
});

test('real two-account OAuth tokens route only to their approved WebSocket devices',{timeout:30000},async()=>{
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'jan',modules:true,script:readFileSync(new URL('../build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{DEVICES:{className:'JanDeviceStore',useSQLite:true}},bindings,
    outboundService:async request=>{
      const url=new URL(request.url);
      if(url.href==='https://github.com/login/oauth/access_token'){
        const form=await request.formData();
        return Response.json({access_token:'provider-'+String(form.get('code')).split('-').at(-1)});
      }
      if(url.href==='https://api.github.com/user'){
        const id=Number(request.headers.get('Authorization')?.split('-').at(-1));
        assert.ok([1234,5678].includes(id));
        return Response.json({id,login:'user-'+id});
      }
      throw Error('Unexpected outbound request: '+url.href);
    }}]}));
  const sockets=[];
  try {
    const call=(route,init={})=>mf.dispatchFetch(base+route,{redirect:'manual',...init});
    const json=(route,body,headers={})=>call(route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
    async function signIn(id){
      const start=await call('/devices/login');assert.equal(start.status,302);
      const state=new URL(start.headers.get('Location')).searchParams.get('state');
      const result=await call('/callback?'+new URLSearchParams({state,code:'portal-'+id}),{headers:{Cookie:cookie(start)}});
      assert.equal(result.status,302,await result.clone().text());
      const browserCookie=cookie(result);
      const page=await call('/devices/settings',{headers:{Cookie:browserCookie}});
      assert.equal(page.status,200);
      const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await page.text())?.[1];
      assert.ok(csrf);
      return {id,cookie:browserCookie,csrf};
    }
    const form=(user,route,data)=>call(route,{method:'POST',headers:{Cookie:user.cookie,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:user.csrf,...data}).toString()});
    async function pair(user){
      const key=keys();
      const started=await json('/devices/pair/start',{name:'PC '+user.id,os:'Windows',agentVersion:'test',publicKey:key.publicKey,capabilities:['commands']});
      assert.equal(started.status,201,await started.clone().text());
      const transaction=await started.json();
      assert.equal((await json('/devices/pair/proof',proof(transaction,'status',key.privateKey,base))).status,200);
      const review=await call('/devices/approve?id='+transaction.id,{headers:{Cookie:user.cookie}});
      assert.equal(review.status,200);
      const html=await review.text();
      assert.doesNotMatch(html,new RegExp(transaction.code));
      assert.match(html,/name="confirmation_code"/);
      assert.equal((await form(user,'/devices/approve',{id:transaction.id,decision:'approve'})).status,403);
      assert.equal((await form(user,'/devices/approve',{id:transaction.id,decision:'approve',confirmation_code:user.id===5678?transaction.code.replace(' ',''):transaction.code})).status,303);
      await pause(1100);
      const collected=await json('/devices/pair/proof',proof(transaction,'collect',key.privateKey,base));
      assert.equal(collected.status,200,await collected.clone().text());
      const session=(await collected.json()).session;
      assert.equal(session.owner_id,String(user.id));
      assert.equal((await form(user,'/devices/select',{id:session.id})).status,303);
      return {session,key};
    }
    async function tokenFor(id,client,host){
      const verifier='V'.repeat(64),redirectUri=client.redirect_uris[0];
      const params=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirectUri,scope:host?'pcrc:read pcrc:control':'pcrc:read',state:'state-'+id,code_challenge:await digest(verifier),code_challenge_method:'S256',resource:base+'/mcp'});
      const consent=await call('/authorize?'+params);assert.equal(consent.status,303);
      const review=await call(consent.headers.get('Location').slice(base.length),{headers:{Cookie:cookie(consent)}});
      assert.equal(review.status,200);
      const handle=/name="handle" value="([^"]+)"/.exec(await review.text())?.[1];assert.ok(handle);
      const upstream=await call('/authorize',{method:'POST',headers:{Cookie:cookie(consent),Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,decision:'approve'}).toString()});
      assert.equal(upstream.status,200);
      const github=new URL((await upstream.text()).match(/href="(https:\/\/github\.com[^"]+)"/)[1].replaceAll('&#38;','&'));
      const callback=await call('/callback?'+new URLSearchParams({state:github.searchParams.get('state'),code:'oauth-'+id}),{headers:{Cookie:cookie(upstream)}});
      assert.equal(callback.status,302,await callback.clone().text());
      const result=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:new URL(callback.headers.get('Location')).searchParams.get('code'),redirect_uri:redirectUri,code_verifier:verifier,resource:base+'/mcp'}).toString()});
      assert.equal(result.status,200,await result.clone().text());
      return (await result.json()).access_token;
    }
    const a=await signIn(1234),b=await signIn(5678);
    const aDevice=await pair(a),bDevice=await pair(b);
    const state=async user=>(await (await call('/devices/state',{headers:{Cookie:user.cookie}})).json());
    assert.deepEqual((await state(a)).devices.map(device=>device.id),[aDevice.session.id]);
    assert.deepEqual((await state(b)).devices.map(device=>device.id),[bDevice.session.id]);
    assert.equal((await form(a,'/devices/select',{id:bDevice.session.id})).status,404);
    const wrongSocket=await call('/jan-relay/connect',{headers:{Upgrade:'websocket','X-JAN-Device-Proof':JSON.stringify(handshake({...bDevice.session,owner_id:String(a.id)},bDevice.key.privateKey))}});
    assert.equal(wrongSocket.status,403);
    const commands=[];
    for(const [user,device] of [[a,aDevice],[b,bDevice]]){
      const upgraded=await call('/jan-relay/connect',{headers:{Upgrade:'websocket','X-JAN-Device-Proof':JSON.stringify(handshake(device.session,device.key.privateKey))}});
      assert.equal(upgraded.status,101);
      const ws=upgraded.webSocket;ws.accept();sockets.push(ws);
      ws.addEventListener('message',event=>{
        const message=JSON.parse(event.data),request=JSON.parse(message.payload);
        if(request.params?.name==='run_command')commands.push({account:user.id,command:request.params.arguments.command});
        const result=request.method==='tools/list'?{tools:[{name:'create_text_file',annotations:{readOnlyHint:false}}]}:{account:String(user.id)};
        ws.send(JSON.stringify({type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:request.id,result})}));
      });
    }
    const registration=await json('/register',{client_name:'Multi-user runtime test',redirect_uris:['https://client.example/callback'],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'});
    assert.equal(registration.status,201);
    const client=await registration.json();
    const aToken=await tokenFor(a.id,client),bToken=await tokenFor(b.id,client);
    const mcp=token=>json('/mcp',{jsonrpc:'2.0',id:1,method:'ping'},{Authorization:'Bearer '+token});
    assert.deepEqual((await (await mcp(aToken)).json()).result,{account:'1234'});
    assert.deepEqual((await (await mcp(bToken)).json()).result,{account:'5678'});
    const foreignHints={Authorization:'Bearer '+aToken,'X-Jan-Account-Id':String(b.id),'X-PCRC-Host-Verified':'1'};
    const read=await json('/mcp',{jsonrpc:'2.0',id:20,method:'tools/call',params:{name:'read_file_excerpt',arguments:{path:'synthetic.txt',device_id:bDevice.session.id,account_id:String(b.id)}}},foreignHints);
    assert.deepEqual((await read.json()).result,{account:'1234'},'caller-supplied routing hints cannot read another account file');
    for(const name of ['capture_desktop','capture_browser','run_command','create_text_file']) {
      const denied=await json('/mcp',{jsonrpc:'2.0',id:21,method:'tools/call',params:{name,arguments:{confirmed:true,device_id:bDevice.session.id}}},foreignHints);
      assert.equal(denied.status,403,name+' cannot escalate read-only scope');
    }
    const otherClientTools=await (await json('/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'},{Authorization:'Bearer '+bToken})).json();
    assert.ok(otherClientTools.result.tools.some(tool=>tool.name==='test_approval_card'));
    for(const [host,redirect] of [['chatgpt','https://chatgpt.com/connector_platform_oauth_redirect'],['claude','https://claude.ai/api/mcp/auth_callback']]){
      const registered=await json('/register',{client_name:'Synthetic '+host,redirect_uris:[redirect],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'});
      assert.equal(registered.status,201);
      const nativeToken=await tokenFor(b.id,await registered.json(),host);
      const command='echo synthetic-'+host;
      const nativeCall=await json('/mcp',{jsonrpc:'2.0',id:10,method:'tools/call',params:{name:'run_command',arguments:{command,confirmed:true}}},{Authorization:'Bearer '+nativeToken});
      assert.equal(nativeCall.status,200);
      const pending=(await nativeCall.json()).result;
      assert.equal(pending.isError,true,'a self-registered callback must not authorize execution');
      const id=/actions\?id=([a-f0-9-]{36})/.exec(pending.content[0].text)?.[1];
      assert.ok(id);
      assert.ok(!commands.some(entry=>entry.command===command));
      const foreignReview=await call('/devices/actions?id='+id,{headers:{Cookie:a.cookie}});
      assert.notEqual(foreignReview.status,200);
      assert.ok(!(await foreignReview.text()).includes(command));
      assert.equal((await form(a,'/devices/actions',{id,decision:'approve'})).status,409);
      const foreignReceipt=await (await json('/mcp',{jsonrpc:'2.0',id:22,method:'tools/call',params:{name:'get_action_result',arguments:{action_id:id,wait_seconds:0}}},{Authorization:'Bearer '+aToken})).json();
      assert.equal(foreignReceipt.result.isError,true);
      assert.ok(!JSON.stringify(foreignReceipt).includes(command));
      assert.equal((await form(b,'/devices/actions',{id,decision:'approve'})).status,303);
      for(let attempt=0;attempt<30&&!commands.some(entry=>entry.command===command);attempt++)await pause(50);
      assert.deepEqual(commands.filter(entry=>entry.command===command),[{account:5678,command}]);
      const receipt=await (await json('/mcp',{jsonrpc:'2.0',id:12,method:'tools/call',params:{name:'get_action_result',arguments:{action_id:id,wait_seconds:0}}},{Authorization:'Bearer '+nativeToken})).json();
      assert.equal(receipt.result.structuredContent.status,'completed');
      assert.equal((await form(b,'/devices/actions',{id,decision:'approve'})).status,409);
      assert.equal(commands.filter(entry=>entry.command===command).length,1);
      const toolReply=await (await json('/mcp',{jsonrpc:'2.0',id:11,method:'tools/list'},{Authorization:'Bearer '+nativeToken})).json();
      assert.ok(!toolReply.result.tools.some(tool=>['test_approval_card','test_approval_dialog'].includes(tool.name)));
      assert.equal(toolReply.result.tools.find(tool=>tool.name==='create_text_file').annotations.readOnlyHint,false);
    }
    assert.equal((await form(b,'/devices/revoke',{id:aDevice.session.id,confirmation:'revoke'})).status,404);
    assert.equal((await form(a,'/devices/revoke',{id:aDevice.session.id,confirmation:'revoke'})).status,303);
    for(let attempt=0;attempt<20&&sockets[0].readyState===1;attempt++)await pause(10);
    assert.notEqual(sockets[0].readyState,1,'revocation closes the already-connected account A socket');
    assert.equal((await mcp(aToken)).status,503);
    assert.equal((await call('/jan-relay/connect',{headers:{Upgrade:'websocket','X-JAN-Device-Proof':JSON.stringify(handshake(aDevice.session,aDevice.key.privateKey))}})).status,403);
    assert.deepEqual((await (await mcp(bToken)).json()).result,{account:'5678'});
  } finally {
    for(const socket of sockets)try{socket.close();}catch{}
    await mf.dispose();
  }
});
