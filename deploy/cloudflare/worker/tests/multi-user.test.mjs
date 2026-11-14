import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {JanDeviceStore} from '../src/device_store.ts';
import {portal} from '../src/device_portal.ts';
import {pairingProof} from '../src/pairing.ts';
import {proxyMcp} from '../src/policy.ts';
import {authorization} from '../src/authorization.ts';
import {siteRouteAllowed} from '../src/site_role.ts';
import {sealRecord} from '../src/secure_store.ts';
import {accountFromDeviceProof,permittedAccount,validBetaIds} from '../src/account_identity.ts';

const origin='https://multi-user.example.workers.dev';
class Storage {
  async setAlarm(){}
  entries=new Map();queue=Promise.resolve();
  async get(key){return structuredClone(this.entries.get(key));}
  async put(key,value){this.entries.set(key,structuredClone(value));}
  async delete(key){this.entries.delete(key);}
  async list({prefix='',startAfter='',limit=1000}={}){return new Map([...this.entries].filter(([key])=>key.startsWith(prefix)&&key>startAfter).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));}
  transaction(callback){const next=this.queue.then(()=>callback(this));this.queue=next.catch(()=>{});return next;}
}
function fixture() {
  const objects=new Map(),routes=[];
  const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://legacy.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClientId',GITHUB_CLIENT_SECRET:'synthetic-secret-for-tests',ALLOWED_GITHUB_ID:'1234',JAN_PAIRING_ENABLED:'1',JAN_RELAY_ENABLED:'1',JAN_MULTI_USER_ENABLED:'1'};
  env.DEVICES={idFromName(id){routes.push(id);return id;},get(id){
    if(!objects.has(id))objects.set(id,new JanDeviceStore({storage:new Storage()},env));
    return {fetch:(input,init)=>objects.get(id).fetch(input instanceof Request?input:new Request(input,init))};
  }};
  return {env,routes,objects};
}
const request=(path,init={})=>new Request(origin+path,init);

test('concurrent first requests cannot bind one account store to two identities',async()=>{
  const {env}=fixture(),storage=new Storage(),store=new JanDeviceStore({storage},env);
  const call=id=>store.fetch(new Request('https://internal.invalid/account/auth-version',{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':id},body:'{}'}));
  const responses=await Promise.all([call('1234'),call('5678')]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,403]);
  const owner=await storage.get('account:owner:v1');
  assert.equal((await call(owner==='1234'?'5678':'1234')).status,403);
});
const cookies=response=>response.headers.get('Set-Cookie')?.split(';')[0];
async function login(env,id) {
  const start=await portal(request('/devices/login'),env);
  assert.equal(start.status,302);
  const state=new URL(start.headers.get('Location')).searchParams.get('state');
  const fetcher=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-token'}):Response.json({id,login:'user-'+id});
  const callback=await portal(request('/callback?state='+state+'&code=synthetic',{headers:{Cookie:cookies(start)}}),env,fetcher);
  assert.equal(callback.status,302);
  const cookie=cookies(callback);
  const page=await portal(request('/devices/settings',{headers:{Cookie:cookie}}),env);
  assert.equal(page.status,200);
  const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await page.text())?.[1];
  assert.ok(csrf);
  return {cookie,csrf,id:String(id)};
}
async function signedProof(pair,privateKey,action) {
  const nonce=randomBytes(32).toString('base64url'),timestamp=Date.now();
  const signature=sign('sha256',Buffer.from(pairingProof(origin,pair.id,action,pair.challenge,nonce,timestamp)),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  return {id:pair.id,action,nonce,timestamp,signature};
}

test('sharing approval rejects a Free owner added after its Pro checks',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';env.PADDLE_PRICE_ID='pri_'+'a'.repeat(26);
  const a=await login(env,5678),b=await login(env,9012);
  const settings=await portal(request('/devices/settings',{headers:{Cookie:a.cookie}}),env);
  assert.doesNotMatch(await settings.text(),/href="\/devices\/account"/,'public navigation no longer includes Account & privacy');
  await objects.get('9012').state.storage.put('billing:subscriptions:v1',{synthetic:{status:'active',priceId:env.PADDLE_PRICE_ID}});
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=key.publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const json=(path,body)=>portal(request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
  const start=async accountChoice=>(await json('/devices/pair/start',{name:'Synthetic shared PC',os:'Windows',agentVersion:'test',publicKey,browserChoice:true,...(accountChoice?{accountChoice:true}:{})})).json();
  const first=await start(false),second=await start(true);
  for(const pair of [first,second])assert.equal((await json('/devices/pair/proof',await signedProof(pair,key.privateKey,'status'))).status,200);
  let release,reached;
  const waiting=new Promise(resolve=>{release=resolve;}),paused=new Promise(resolve=>{reached=resolve;});
  const originalGet=env.DEVICES.get;
  env.DEVICES.get=id=>{
    const stub=originalGet(id);
    return {fetch:async(input,init)=>{
      const call=input instanceof Request?input:new Request(input,init);
      if(new URL(call.url).pathname==='/pairing/decide'&&JSON.parse(await call.clone().text()).ownerId==='9012'){reached();await waiting;}
      return stub.fetch(call);
    }};
  };
  const decide=(pair,user)=>portal(request('/devices/approve',{method:'POST',headers:{Cookie:user.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:user.csrf,id:pair.id,decision:'approve',codes_match:'yes',access:'read'})}),env);
  const pending=decide(second,b);
  await paused;
  let approved;
  try {approved=await decide(first,a);} finally {release();}
  assert.equal(approved.status,303);
  assert.equal((await pending).status,403,'stale Pro checks must not authorize sharing with a newly bound Free account');
  assert.deepEqual(await objects.get('1234').state.storage.get('pairing:key-owner:v1:'+publicKey),['5678']);
});

test('a delayed approved registration cannot restore access after installation release',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';await login(env,5678);
  const object=objects.get('5678'),publicKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const oldId=crypto.randomUUID(),newId=crypto.randomUUID();
  await object.state.storage.put('devices',{[oldId]:{id:oldId,ownerId:'5678',publicKey,name:'Synthetic PC',revoked:false}});
  const delayed={id:newId,ownerId:'5678',publicKey,name:'Synthetic PC',login:'user-5678',capabilities:['read'],created:Date.now()-1000};
  const internal=(path,body)=>object.fetch(new Request('https://internal.invalid'+path,{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify(body)}));
  assert.equal((await internal('/device/release',{id:oldId})).status,200);
  assert.equal((await internal('/device/import',delayed)).status,403,'in-flight registration predating release must not reactivate access');
  const devices=await object.state.storage.get('devices');
  assert.equal(devices[oldId].revoked,true);assert.equal(devices[newId],undefined);
});

test('Free imports allow one active installation and atomically replace only its matching key',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';
  await login(env,5678);
  const object=objects.get('5678');
  const key=()=>generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const publicKey=key(),a=crypto.randomUUID(),b=crypto.randomUUID();
  const add=(id,k=publicKey)=>object.fetch(new Request('https://internal.invalid/device/import',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify({id,ownerId:'5678',name:'Synthetic PC',login:'user-5678',publicKey:k,capabilities:['read']})}));
  assert.equal((await add(a)).status,200);
  assert.equal((await add(b,key())).status,429);
  assert.equal((await add(b)).status,200);
  const devices=await object.state.storage.get('devices');
  assert.equal(devices[a].revoked,true);assert.equal(devices[b].revoked,false);
  env.PADDLE_PRICE_ID='pri_'+'a'.repeat(26);
  await object.state.storage.put('billing:subscriptions:v1',{synthetic:{status:'active',priceId:env.PADDLE_PRICE_ID}});
  assert.equal((await add(crypto.randomUUID(),key())).status,200,'Pro supports multiple computers');
});

test('simultaneous Free imports cannot exceed one active computer',async()=>{
  const {env,objects}=fixture();await login(env,5678);
  const object=objects.get('5678');
  const add=()=>object.fetch(new Request('https://internal.invalid/device/import',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify({id:crypto.randomUUID(),ownerId:'5678',name:'Race PC',login:'user-5678',publicKey:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64url'),capabilities:['read']})}));
  const results=await Promise.all([add(),add()]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,429]);
  assert.equal(Object.values(await object.state.storage.get('devices')).filter(d=>!d.revoked).length,1);
});

test('owner account controls stay private and release only the reviewed computer binding',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';
  const operator=await login(env,1234),member=await login(env,5678);
  const id=crypto.randomUUID(),key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const devices={[id]:{id,publicKey:key,ownerId:'5678',name:'Synthetic PC',revoked:false}};
  await objects.get('5678').state.storage.put('devices',devices);
  const keyName='pairing:key-owner:v1:'+key;
  await objects.get('1234').state.storage.put(keyName,['5678']);
  assert.equal((await portal(request('/admin/accounts?account=5678',{headers:{Cookie:operator.cookie}}),env)).status,404);
  env.JAN_SITE_ROLE='owner';
  assert.equal((await portal(request('/admin/accounts?account=5678',{headers:{Cookie:member.cookie}}),env)).status,403);
  const page=await portal(request('/admin/accounts?account=5678',{headers:{Cookie:operator.cookie}}),env);
  assert.equal(page.status,200);assert.match(await page.text(),/Release for another account/);
  const post=confirmation=>portal(request('/admin/accounts',{method:'POST',headers:{Cookie:operator.cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:operator.csrf,account:'5678',device:id,operation:'release',confirmation})}),env);
  assert.equal((await post('REVOKE')).status,400);
  assert.equal((await objects.get('5678').state.storage.get('devices'))[id].revoked,false);
  assert.equal((await post('RELEASE')).status,200);
  assert.equal((await objects.get('5678').state.storage.get('devices'))[id].revoked,true);
  assert.equal((await objects.get('5678').state.storage.get('devices'))[id].accountReleased,true);
  assert.deepEqual(await objects.get('1234').state.storage.get(keyName),[]);
  await objects.get('5678').state.storage.put('account:deleted:v1',{at:Date.now()});
  await objects.get('5678').state.storage.delete('devices');
  env.JAN_SITE_ROLE='public';
  const restart=await portal(request('/devices/pair/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Released PC',os:'Windows',agentVersion:'test',publicKey:key,reconnect:{id,ownerId:'5678'}})}),env);
  assert.equal(restart.status,201);assert.equal((await restart.json()).accountReleased,true,'owner release survives deletion of the old account');
});

test('owner may revoke their own computer without being able to delete the operator account',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';const operator=await login(env,1234);
  const id=crypto.randomUUID(),object=objects.get('1234');
  await object.state.storage.put('devices',{[id]:{id,name:'Operator test PC',ownerId:'1234',revoked:false,publicKey:generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64url')}});
  env.JAN_SITE_ROLE='owner';
  const post=operation=>portal(request('/admin/accounts',{method:'POST',headers:{Cookie:operator.cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:operator.csrf,account:'1234',device:id,operation,confirmation:operation.toUpperCase()})}),env);
  assert.equal((await post('revoke')).status,200);assert.equal((await object.state.storage.get('devices'))[id].revoked,true);
  assert.equal((await post('delete')).status,403);assert.equal(await object.state.storage.get('account:closing:v1'),undefined);
});

test('revoked reconnect requires its original account; only explicit enrollment may share between Pro accounts',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';env.PADDLE_PRICE_ID='pri_'+'a'.repeat(26);
  const a=await login(env,5678),b=await login(env,9012);
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),publicKey=key.publicKey.export({type:'spki',format:'der'}).toString('base64url'),id=crypto.randomUUID();
  await objects.get('5678').state.storage.put('devices',{[id]:{id,ownerId:'5678',name:'Saved PC',publicKey,revoked:true}});
  const json=(path,body)=>portal(request(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);
  const start=extra=>json('/devices/pair/start',{name:'Saved PC',os:'Windows',agentVersion:'test',publicKey,browserChoice:true,reconnect:{id,ownerId:'5678'},...extra});
  const response=await start({});assert.equal(response.status,201);const pair=await response.json();
  const tracked=await portal(request('/devices/approve?id='+pair.id+'&utm_source=chatgpt.com'),env);
  assert.equal(tracked.status,302);assert.equal(tracked.headers.get('Location'),origin+'/devices/approve?id='+pair.id);
  assert.equal((await json('/devices/pair/proof',await signedProof(pair,key.privateKey,'status'))).status,200);
  const wrong=await portal(request('/devices/approve?id='+pair.id,{headers:{Cookie:b.cookie}}),env);
  assert.equal(wrong.status,403);const text=await wrong.text();assert.match(text,/not the correct account/);assert.match(text,/Sign out and use the correct account/);assert.doesNotMatch(text,new RegExp(pair.code));
  const decide=(p,user)=>portal(request('/devices/approve',{method:'POST',headers:{Cookie:user.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:user.csrf,id:p.id,decision:'approve',codes_match:'yes',access:'read'})}),env);
  assert.equal((await decide(pair,b)).status,403);assert.equal((await decide(pair,a)).status,303);
  const oldRecords=await objects.get('5678').state.storage.get('devices');
  await objects.get('5678').state.storage.delete('devices');
  assert.equal((await start({})).status,201,'persistent ownership supports repair after old revoked metadata expires');
  await objects.get('5678').state.storage.put('devices',oldRecords);
  const otherKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).publicKey.export({type:'spki',format:'der'}).toString('base64url');
  assert.equal((await json('/devices/pair/start',{name:'Fake',os:'Windows',agentVersion:'test',publicKey:otherKey,reconnect:{id,ownerId:'5678'}})).status,403,'a reconnect hint cannot bind a different key');
  assert.equal((await start({shareAllowed:true})).status,400,'native callers cannot inject server-only sharing authorization');
  const pro={synthetic:{status:'active',priceId:env.PADDLE_PRICE_ID}};
  await objects.get('5678').state.storage.put('billing:subscriptions:v1',pro);
  const explicit=await (await start({accountChoice:true})).json();
  assert.equal((await portal(request('/devices/approve?id='+explicit.id,{headers:{Cookie:b.cookie}}),env)).status,403,'Free destination cannot share a Pro installation');
  await objects.get('9012').state.storage.put('billing:subscriptions:v1',pro);
  assert.equal((await portal(request('/devices/approve?id='+explicit.id,{headers:{Cookie:b.cookie}}),env)).status,200);
  await json('/devices/pair/proof',await signedProof(explicit,key.privateKey,'status'));
  assert.equal((await decide(explicit,b)).status,303);
  const normal=await (await start({})).json();
  assert.equal((await portal(request('/devices/approve?id='+normal.id,{headers:{Cookie:b.cookie}}),env)).status,403,'ordinary repair stays on its original account even with two Pro accounts');
  const signedOut=await portal(request('/devices/approve?id='+normal.id),env);
  assert.equal(signedOut.status,303);assert.match(signedOut.headers.get('Location'),/\/devices\/sign-in\?return=/);
  const missing=await portal(request('/devices/approve?id='+'x'.repeat(43),{headers:{Cookie:a.cookie}}),env);
  assert.equal(missing.status,404);assert.match(await missing.text(),/connection request is unavailable/);
});

test('MCP consent uses the signed-in public account without a second GitHub redirect',async()=>{
  const {env}=fixture();
  const member=await login(env,5678);
  const approved={responseType:'code',clientId:'inspector',redirectUri:'http://127.0.0.1:6276/oauth/callback',scope:['jan:read','jan:control'],resource:origin+'/mcp',codeChallenge:'C'.repeat(43),codeChallengeMethod:'S256'};
  let completed=0;
  env.OAUTH_PROVIDER={
    describeConsent:async()=>({redirectUri:approved.redirectUri}),
    approveConsent:async()=>({request:approved,headers:new Headers({'Set-Cookie':'__Host-oauth-consent=; Max-Age=0; Path=/'})}),
    beginUpstream:async()=>assert.fail('Signed-in consent must not start another GitHub login'),
    completeAuthorization:async grant=>{completed++;assert.equal(grant.userId,'5678');assert.deepEqual(grant.scope,approved.scope);assert.deepEqual(grant.props,{accountId:'5678',authVersion:0});return {redirectTo:approved.redirectUri+'?code=synthetic'};},
  };
  const consent=()=>authorization(request('/authorize',{method:'POST',headers:{Cookie:member.cookie,Origin:origin},body:new URLSearchParams({handle:'H'.repeat(43),decision:'approve'})}),env);
  const result=await consent();
  assert.equal(result.status,303);
  assert.equal(result.headers.get('Location'),approved.redirectUri+'?code=synthetic');
  assert.match(result.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.equal(completed,1);
  env.OAUTH_PROVIDER.beginUpstream=async()=>({state:'github-fallback',headers:new Headers()});
  const forged=member.cookie.slice(0,-1)+(member.cookie.endsWith('A')?'B':'A');
  const denied=await authorization(request('/authorize',{method:'POST',headers:{Cookie:forged,Origin:origin},body:new URLSearchParams({handle:'H'.repeat(43),decision:'approve'})}),env);
  assert.equal(denied.status,200);
  assert.match(await denied.text(),/Continue to GitHub/);
  assert.equal(completed,1);
});

test('native host mode follows validated OAuth consent without a selection field',async()=>{
  const {env}=fixture();const member=await login(env,5678);
  let props;
  const approved={responseType:'code',clientId:'synthetic-host',redirectUri:'https://chatgpt.com/connector_platform_oauth_redirect',scope:['jan:read','jan:control'],resource:origin+'/mcp',codeChallenge:'C'.repeat(43),codeChallengeMethod:'S256'};
  env.OAUTH_PROVIDER={describeConsent:async()=>({redirectUri:''}),approveConsent:async()=>({request:approved,headers:new Headers()}),completeAuthorization:async grant=>{props=grant.props;return {redirectTo:approved.redirectUri};}};
  const consent=choice=>authorization(request('/authorize',{method:'POST',headers:{Cookie:member.cookie,Origin:origin},body:new URLSearchParams({handle:'H'.repeat(43),decision:'approve',...(choice?{host_confirmation:choice}:{})})}),env);
  assert.equal((await consent()).status,303);assert.deepEqual(props,{accountId:'5678',authVersion:0,confirmationHost:'chatgpt'});
  assert.equal((await consent('chatgpt')).status,303);assert.deepEqual(props,{accountId:'5678',authVersion:0,confirmationHost:'chatgpt'});
  assert.equal((await consent('claude')).status,303);assert.deepEqual(props,{accountId:'5678',authVersion:0,confirmationHost:'chatgpt'});
  approved.scope=['jan:read'];
  assert.equal((await consent('chatgpt')).status,303);assert.deepEqual(props,{accountId:'5678',authVersion:0});
  approved.scope=['jan:read','jan:control'];
  approved.redirectUri='https://evil.example/callback';
  assert.equal((await consent('chatgpt')).status,303);assert.deepEqual(props,{accountId:'5678',authVersion:0});
});

test('public calls with existing host grants still require website approval',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';
  await login(env,5678);await login(env,9012);
  const object=objects.get('5678'),deviceId='11111111-1111-4111-8111-111111111111';
  const devices={[deviceId]:{id:deviceId,name:'Synthetic PC',ownerId:'5678',revoked:false,capabilities:['read','control','commands','files']}};
  await object.state.storage.put('devices',devices);await object.state.storage.put('active',deviceId);
  let forwarded=0;
  object.relay.getSession=()=>({online:true,forward:async message=>{forwarded++;return {type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'synthetic-native-success'}]}})};}});
  const auth={audience:origin+'/mcp',userId:'5678',scope:['jan:read','jan:control']};
  const run=async(props={},headers={},identity=auth,tool='run_command')=>{
    const body={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:tool==='create_text_file'?{path:'synthetic-new.txt',content:'Synthetic'}:{command:'echo synthetic-native',confirmed:true},_meta:{clientInfo:{name:'ChatGPT'},host_confirmation:'chatgpt'}}};
    return proxyMcp(request('/mcp',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)}),env,identity,{githubId:'5678',...props});
  };
  const paused=await (await run({}, {'X-PCRC-Host-Confirmation':'chatgpt','X-PCRC-Host-Verified':'1'})).json();
  assert.equal(paused.result.isError,true);assert.equal(forwarded,0);
  for(const confirmationHost of ['chatgpt','claude','forged-host']){
    const result=(await (await run({confirmationHost})).json()).result;
    assert.deepEqual(result,paused.result,'existing grants cannot bypass or replace the pending approval');
    assert.equal(forwarded,0);
  }
  assert.equal((await run({confirmationHost:'chatgpt'},{},{...auth,scope:['jan:read']})).status,403);
  assert.equal((await run({confirmationHost:'chatgpt',githubId:'9012'})).status,403);
  assert.equal((await (await run({confirmationHost:'chatgpt',confirmationVerified:true})).json()).result.content[0].text,'synthetic-native-success');assert.equal(forwarded,1,'verified hosts handle command confirmations too');
  const trusted=(await (await run({confirmationHost:'chatgpt',confirmationVerified:true},{},auth,'create_text_file')).json()).result;
  assert.equal(trusted.content[0].text,'synthetic-native-success');
  assert.equal(forwarded,2);
  for(const confirmationHost of ['chatgpt','claude']) {
    const routine=(await (await run({confirmationHost,confirmationVerified:true},{},auth,'apply_file_edit')).json()).result;
    assert.equal(routine.content[0].text,'synthetic-native-success');
    const command=(await (await run({confirmationHost,confirmationVerified:true})).json()).result;
    assert.equal(command.content[0].text,'synthetic-native-success');
  }
  assert.equal(forwarded,6,'both verified hosts forward routine edits without a website request');
  const unverified=(await (await run({confirmationHost:'chatgpt'},{},auth,'apply_file_edit')).json()).result;
  assert.equal(unverified.isError,true);assert.equal(forwarded,6,'an asserted host name does not delegate confirmation');
  devices[deviceId].capabilities=['read'];await object.state.storage.put('devices',devices);
  assert.equal((await (await run({confirmationHost:'chatgpt',confirmationVerified:true})).json()).result.isError,true);assert.equal(forwarded,6);
  devices[deviceId].capabilities=['read','control','commands'];devices[deviceId].revoked=true;await object.state.storage.put('devices',devices);
  assert.equal((await (await run({confirmationHost:'chatgpt',confirmationVerified:true})).json()).result.isError,true);assert.equal(forwarded,6);
});

test('a first-time MCP user signs in through the existing public login and returns to consent',async()=>{
  const {env}=fixture();env.JAN_SITE_ROLE='public';
  const handle='H'.repeat(43),hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(handle))).toString('hex');
  const records=new Map(),OAUTH_KV={put:async(k,v)=>records.set(k,v),get:async k=>records.has(k)?JSON.parse(records.get(k)):null};
  env.OAUTH_KV=OAUTH_KV;
  const approved={responseType:'code',clientId:'inspector',redirectUri:'http://127.0.0.1:6276/oauth/callback',scope:['jan:read'],resource:origin+'/mcp',codeChallenge:'C'.repeat(43),codeChallengeMethod:'S256'};
  env.OAUTH_PROVIDER={parseAuthRequest:async()=>approved,describeConsent:async()=>({clientName:'Inspector',redirectUri:approved.redirectUri,redirectHost:'127.0.0.1',redirectIsLoopback:true,scope:approved.scope}),beginConsent:async()=>({handle,headers:new Headers({'Set-Cookie':'__Host-oauth-consent-'+hash.slice(0,16)+'='+hash+'; Secure; HttpOnly; Path=/'})}),approveConsent:async()=>({request:approved,headers:new Headers()}),completeAuthorization:async grant=>{assert.equal(grant.userId,'5678');return {redirectTo:approved.redirectUri+'?code=synthetic'};},beginUpstream:async()=>assert.fail('Public login should avoid a second provider roundtrip')};
  const start=await authorization(request('/authorize'),env);
  const consentCookie=cookies(start);
  const consent=await authorization(request('/consent?handle='+handle,{headers:{Cookie:consentCookie}}),env);
  assert.equal(consent.status,303);
  assert.equal(new URL(consent.headers.get('Location')).search,'?consent='+handle);
  const loginStart=await portal(request('/devices/login?consent='+handle),env);
  const state=new URL(loginStart.headers.get('Location')).searchParams.get('state');
  const fetcher=async url=>url.includes('access_token')?Response.json({access_token:'synthetic'}):Response.json({id:5678,login:'member'});
  const callback=await portal(request('/callback?state='+state+'&code=synthetic',{headers:{Cookie:cookies(loginStart)}}),env,fetcher);
  assert.equal(callback.headers.get('Location'),origin+'/consent?handle='+handle);
  const browserCookies=consentCookie+'; '+cookies(callback);
  const consentPage=await authorization(request('/consent?handle='+handle,{headers:{Cookie:browserCookies}}),env);
  assert.equal(consentPage.status,200);
  assert.match(await consentPage.text(),/Signed in as <strong>member<\/strong>/);
  const grant=await authorization(request('/authorize',{method:'POST',headers:{Cookie:browserCookies,Origin:origin},body:new URLSearchParams({handle,decision:'approve'})}),env);
  assert.equal(grant.status,303);
  assert.equal(grant.headers.get('Location'),approved.redirectUri+'?code=synthetic');
});

test('high-impact relay calls require exact one-time browser approval by the device owner',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';
  const owner=await login(env,5678),other=await login(env,9012);
  const object=objects.get('5678'),deviceId='11111111-1111-4111-8111-111111111111';
  await object.state.storage.put('devices',{[deviceId]:{id:deviceId,name:'Test PC',ownerId:'5678',revoked:false,capabilities:['read','control','commands']}});
  await object.state.storage.put('active',deviceId);
  let forwarded=0;
  object.relay.getSession=()=>({online:true,forward:async message=>{forwarded++;return {type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'done'}]}})};}});
  const call=(command,extra={})=>object.fetch(new Request('https://internal.invalid/relay/dispatch',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify({type:'request',request_id:crypto.randomUUID(),control:true,payload:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_command',arguments:{command,confirmed:true,...extra}}})})}));
  const pending=await call('echo approved');
  assert.equal(pending.status,200);
  const text=JSON.parse((await pending.json()).payload).result.content[0].text;
  const id=/\/devices\/actions\?id=([a-f0-9-]{36})/.exec(text)?.[1];
  assert.ok(id);assert.equal(forwarded,0);
  assert.ok(!JSON.stringify(await object.state.storage.get('actions:v1')).includes('echo approved'));
  const tracked=await portal(request('/devices/actions?id='+id+'&utm_source=chatgpt.com&utm_source=duplicate&gclid=ad'),env);
  assert.equal(tracked.status,302);
  assert.equal(tracked.headers.get('Location'),origin+'/devices/actions?id='+id);
  const unknown=await portal(request('/devices/actions?id='+id+'&unexpected=value&utm_source=chatgpt.com'),env);
  assert.equal(unknown.headers.get('Location'),origin+'/devices/actions?id='+id+'&unexpected=value');
  assert.equal(forwarded,0);
  const signedOut=await portal(request('/devices/actions?id='+id),env);
  assert.equal(signedOut.status,303);
  assert.equal(signedOut.headers.get('Location'),origin+'/devices/login?action='+id);
  const signIn=await portal(request('/devices/login?action='+id),env);
  const state=new URL(signIn.headers.get('Location')).searchParams.get('state');
  const fetcher=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-token'}):Response.json({id:5678,login:'user-5678'});
  const returned=await portal(request('/callback?state='+state+'&code=synthetic',{headers:{Cookie:cookies(signIn)}}),env,fetcher);
  assert.equal(returned.headers.get('Location'),origin+'/devices/actions?id='+id);
  const cross=await portal(request('/devices/actions?id='+id,{headers:{Cookie:other.cookie}}),env);
  assert.equal(cross.status,404);
  const review=await portal(request('/devices/actions?id='+id,{headers:{Cookie:owner.cookie}}),env);
  assert.equal(review.status,200);assert.match(await review.text(),/echo approved/);
  const bad=await portal(request('/devices/actions',{method:'POST',headers:{Cookie:owner.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id,decision:'approve',csrf:'forged'})}),env);
  assert.equal(bad.status,403);
  const legacyItems=await object.state.storage.get('actions:v1');
  legacyItems.find(item=>item.id===id).autoRun=false;
  await object.state.storage.put('actions:v1',legacyItems);
  const approved=await portal(request('/devices/actions',{method:'POST',headers:{Cookie:owner.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id,decision:'approve',csrf:owner.csrf})}),env);
  assert.equal(approved.status,303);
  assert.equal(JSON.parse((await (await call('echo different')).json()).payload).result.isError,true);
  assert.equal(forwarded,0);
  assert.equal(JSON.parse((await (await call('echo approved')).json()).payload).result.content[0].text,'done');
  assert.equal(forwarded,1);
  assert.equal(JSON.parse((await (await call('echo approved')).json()).payload).result.isError,true);
  assert.equal(forwarded,1);
  assert.equal(JSON.parse((await (await call('echo dry-run bypass',{dry_run:true})).json()).payload).result.isError,true);
  assert.equal(forwarded,1);
  const rejected=JSON.parse((await (await call('echo rejected')).json()).payload).result.content[0].text;
  const rejectId=/\/devices\/actions\?id=([a-f0-9-]{36})/.exec(rejected)?.[1];
  assert.ok(rejectId);
  assert.equal((await portal(request('/devices/actions',{method:'POST',headers:{Cookie:owner.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id:rejectId,decision:'deny',csrf:owner.csrf})}),env)).status,303);
  assert.match(JSON.parse((await (await call('echo rejected')).json()).payload).result.content[0].text,/denied/);
  assert.equal(forwarded,1);
  const changed=JSON.parse((await (await call('echo selection')).json()).payload).result.content[0].text;
  const changeId=/\/devices\/actions\?id=([a-f0-9-]{36})/.exec(changed)?.[1];
  assert.ok(changeId);
  await object.state.storage.delete('active');
  assert.equal((await portal(request('/devices/actions?id='+changeId,{headers:{Cookie:owner.cookie}}),env)).status,409);
  assert.equal(forwarded,1);
});

test('dashboard inbox is owner-only, requires explicit access, and executes selected requests once',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';
  const owner=await login(env,5678),other=await login(env,9012);
  const object=objects.get('5678'),deviceId='11111111-1111-4111-8111-111111111111';
  await object.state.storage.put('devices',{[deviceId]:{id:deviceId,name:'Synthetic PC',ownerId:'5678',revoked:false,capabilities:['read','control','commands','desktop','files']}});
  await object.state.storage.put('active',deviceId);
  let forwarded=0;
  object.relay.getSession=()=>({online:true,forward:async message=>{forwarded++;return {type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'synthetic done'}]}})};}});
  const internal=(path,body)=>object.fetch(new Request('https://internal.invalid'+path,{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify(body)}));
  const queue=(name,args)=>internal('/relay/dispatch',{type:'request',request_id:crypto.randomUUID(),control:true,payload:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
  await queue('create_text_file',{path:'synthetic.txt',content:'<script>synthetic</script>'});
  await queue('capture_desktop',{});
  const get=(account=owner)=>portal(request('/devices/approvals?format=json',{headers:{Cookie:account.cookie}}),env);
  const listed=await get();assert.equal(listed.status,200);assert.match(listed.headers.get('Cache-Control'),/no-store/);
  const inbox=await listed.json();assert.equal(inbox.count,2);assert.match(inbox.html,/&#60;script&#62;/);assert.ok(!inbox.html.includes('<script>synthetic'));
  const items=(await (await internal('/actions/list',{})).json()).items;
  const write=items.find(item=>item.access==='write'),read=items.find(item=>item.access==='read');assert.ok(write&&read);
  assert.equal((await (await get(other)).json()).count,0);
  assert.equal((await portal(request('/devices/approvals?format=json'),env)).status,401);
  const post=(ids,access,account=owner,extra={})=>portal(request('/devices/approvals',{method:'POST',headers:{Cookie:account.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams([['csrf',account.csrf],['reviewed','yes'],['decision','approve'],...ids.map(id=>['ids',id]),...ids.map(id=>[(access==='write'?'write_':'read_')+id,'yes']),...Object.entries(extra)])}),env);
  assert.equal((await post([write.id],'read')).status,403);assert.equal(forwarded,0);
  assert.equal((await internal('/actions/decide',{id:write.id,decision:'approve',access:'read'})).status,403);assert.equal(forwarded,0);
  assert.equal((await post([write.id],'write',other)).status,409);assert.equal(forwarded,0);
  assert.equal((await post([write.id,write.id],'write')).status,400);assert.equal(forwarded,0);
  assert.equal((await post([write.id],'write',{...owner,csrf:'forged'})).status,403);assert.equal(forwarded,0);
  assert.equal((await post([read.id],'read')).status,200);assert.equal(forwarded,1);
  assert.equal((await post([write.id],'write')).status,200);assert.equal(forwarded,2);
  assert.equal((await post([write.id],'write')).status,409);assert.equal(forwarded,2);
  assert.equal((await (await get()).json()).count,0);
  assert.equal((await (await internal('/actions/result',{id:write.id})).json()).status,'completed');
  await queue('run_command',{command:'echo never run'});
  const [expired]=(await (await internal('/actions/list',{})).json()).items;
  const stored=await object.state.storage.get('actions:v1');stored.find(item=>item.id===expired.id).expires=Date.now()-1;await object.state.storage.put('actions:v1',stored);
  assert.equal((await (await get()).json()).count,0);assert.equal((await post([expired.id],'write')).status,409);assert.equal(forwarded,2);
});

test('connection doctor identifies pairing, selection, relay and read-only discovery without running tools',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';
  const owner=await login(env,5678),other=await login(env,9012),object=objects.get('5678');
  const internal=body=>object.fetch(new Request('https://internal.invalid/connection/check',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify(body)}));
  let check=await (await internal({})).json();assert.equal(check.checks[0].status,'fail');assert.equal(check.checks[3].status,'not tested');
  const id='11111111-1111-4111-8111-111111111111';
  await object.state.storage.put('devices',{[id]:{id,name:'Synthetic test PC',revoked:false,capabilities:['read']}});
  check=await (await internal({})).json();assert.equal(check.checks[0].status,'pass');assert.equal(check.checks[1].status,'fail');
  await object.state.storage.put('active',id);
  object.relay.getSession=()=>({online:false});check=await (await internal({discover:true})).json();assert.equal(check.checks[2].status,'fail');
  let requests=0;
  object.relay.getSession=()=>({online:true,forward:async envelope=>{requests++;const call=JSON.parse(envelope.payload);assert.equal(call.method,'tools/list');assert.equal(envelope.control,false);return {type:'response',request_id:envelope.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:call.id,result:{tools:[{name:'get_connection_status'}]}})};}});
  check=await (await internal({discover:true})).json();assert.ok(check.checks.every(item=>item.status==='pass'));assert.equal(check.toolCount,1);assert.equal(requests,1);
  assert.match(check.assistantOAuth,/Not tested/);
  const route=account=>portal(request('/devices/connection-check',{method:'POST',headers:{Cookie:account.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:account.csrf})}),env);
  const page=await route(owner);assert.equal(page.status,200);assert.match(await page.text(),/1 tools discovered/);assert.equal(requests,2);
  const foreign=await route(other);assert.equal(foreign.status,200);assert.ok(!(await foreign.text()).includes('Synthetic test PC'));assert.equal(requests,2);
  assert.equal((await route({...owner,csrf:'forged'})).status,403);assert.equal(requests,2);
});

test('tool-call budget is atomic per account across concurrent Worker requests',async()=>{
  const {env}=fixture();
  const count=id=>env.DEVICES.get(id).fetch(new Request('https://internal.invalid/usage/increment',{method:'POST',headers:{'X-Jan-Account-Id':id},body:'{}'}));
  const first=await Promise.all(Array.from({length:120},()=>count('5678')));
  assert.ok(first.every(response=>response.status===200));
  assert.equal((await count('5678')).status,429);
  assert.equal((await count('9012')).status,200);
  const state=await env.DEVICES.get('5678').fetch(new Request('https://internal.invalid/device/list',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:'{}'}));
  assert.equal((await state.json()).calls,120);
});
test('monthly free allowance stops at 15,000 calls per account and resets in UTC',async()=>{
  const {env,objects}=fixture(),date=new Date(),today=date.toISOString().slice(0,10);
  const count=id=>env.DEVICES.get(id).fetch(new Request('https://internal.invalid/usage/increment',{method:'POST',headers:{'X-Jan-Account-Id':id},body:'{}'}));
  env.DEVICES.get('5678');
  const storage=objects.get('5678').state.storage;
  const priorMonth=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),0)).toISOString().slice(0,10);
  await storage.put('usage:daily:v1',{started:Date.now(),days:{[priorMonth]:15000,[today]:14999}});
  await storage.put('calls',29999);
  assert.equal((await count('5678')).status,200);
  const denied=await count('5678');assert.equal(denied.status,429);
  const reset=Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
  assert.deepEqual(await denied.json(),{error:'Monthly tool-call limit reached',resetsAt:reset});
  const state=await env.DEVICES.get('5678').fetch(new Request('https://internal.invalid/device/list',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:'{}'}));
  const data=await state.json();assert.equal(data.calls,30000);assert.deepEqual(data.monthly,{used:15000,limit:15000,resetsAt:reset});
  assert.equal((await count('9012')).status,200);
});
async function pair(env,user) {
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const start=await portal(request('/devices/pair/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({publicKey,name:'PC '+user.id,os:'Windows',agentVersion:'0.7.0-rc.1'})}),env);
  assert.equal(start.status,201);
  const transaction=await start.json();
  const proof=await portal(request('/devices/pair/proof',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signedProof(transaction,keys.privateKey,'status'))}),env);
  assert.equal(proof.status,200);
  const approve=await portal(request('/devices/approve?id='+transaction.id,{headers:{Cookie:user.cookie}}),env);
  assert.equal(approve.status,200);
  const approvalHtml=await approve.text();
  assert.doesNotMatch(approvalHtml,new RegExp(transaction.code));
  const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(approvalHtml)?.[1];
  assert.ok(csrf);user.csrf=csrf;
  const form=new URLSearchParams({id:transaction.id,csrf,decision:'approve',confirmation_code:transaction.code});
  const decision=await portal(request('/devices/approve',{method:'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:form}),env);
  assert.equal(decision.status,303);
  await new Promise(resolve=>setTimeout(resolve,1100));
  const collected=await portal(request('/devices/pair/proof',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(await signedProof(transaction,keys.privateKey,'collect'))}),env);
  assert.equal(collected.status,200,await collected.clone().text());
  const result=await collected.json();
  assert.equal(result.session.owner_id,user.id);
  assert.equal(result.registration,undefined);
  return result.session.id;
}

test('multi-user portal sign-in has a durable per-client limit without storing raw IPs',async()=>{
  const {env,objects}=fixture();
  const start=ip=>portal(request('/devices/login',{headers:{'CF-Connecting-IP':ip}}),env);
  for(let n=0;n<5;n++)assert.equal((await start('192.0.2.1')).status,302);
  assert.equal((await start('192.0.2.1')).status,429);
  assert.equal((await start('192.0.2.2')).status,302);
  const values=[...objects.get('1234').state.storage.entries.values()];
  assert.ok(!JSON.stringify(values).includes('192.0.2.1'));
  assert.ok(!JSON.stringify(values).includes('192.0.2.2'));
  assert.equal(Object.keys(objects.get('1234').state.storage.entries.get('oauth:pending:v1')).length,6);
});

test('multi-user account stores at most 32 active browser sessions',async()=>{
  const {env,objects}=fixture();
  const stub=env.DEVICES.get(env.DEVICES.idFromName('1234'));
  const call=(path,body)=>stub.fetch('https://internal.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':'1234'},body:JSON.stringify(body)});
  for(let n=0;n<33;n++)assert.equal((await call('/session/create',{hash:n.toString(16).padStart(64,'0'),login:'owner',csrf:'C'.repeat(43),userId:'1234'})).status,200);
  const stored=objects.get('1234').state.storage.entries;
  assert.equal(Object.keys(stored.get('session:index:v1')).length,32);
  assert.equal([...stored.keys()].filter(key=>key.startsWith('session:')&&key!=='session:index:v1').length,32);
  assert.equal(await (await call('/session/get',{hash:'0'.repeat(64)})).json(),null);
});

test('sign-in verifier and per-account session details are sealed at rest',async()=>{
  const {env,objects}=fixture();
  const stub=env.DEVICES.get('5678');
  const call=(path,body)=>stub.fetch('https://internal.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':'5678'},body:JSON.stringify(body)});
  const state='janportal.'+'s'.repeat(43),verifier='V'.repeat(43),hash='a'.repeat(64),csrf='C'.repeat(43);
  assert.equal((await call('/oauth/start',{state,verifier,clientKey:'k'.repeat(43)})).status,200);
  const storage=objects.get('5678').state.storage;
  const oauth=await storage.get('oauth:'+state);
  assert.equal(oauth.v,1);
  assert.ok(!JSON.stringify(oauth).includes(verifier));
  assert.deepEqual(await (await call('/oauth/consume',{state})).json(),{verifier,returnTo:'/devices'});
  assert.equal((await call('/session/create',{hash,login:'private-login',csrf,userId:'5678'})).status,200);
  const session=await storage.get('session:'+hash);
  assert.equal(session.v,1);
  assert.ok(!JSON.stringify(session).includes('private-login'));
  assert.ok(!JSON.stringify(session).includes(csrf));
  assert.equal((await (await call('/session/get',{hash})).json()).login,'private-login');
  session.ciphertext=(session.ciphertext.startsWith('A')?'B':'A')+session.ciphertext.slice(1);
  await storage.put('session:'+hash,session);
  assert.equal(await (await call('/session/get',{hash})).json(),null);
  const foreign=env.DEVICES.get('1234');
  const denied=await foreign.fetch('https://internal.invalid/session/get',{method:'POST',headers:{'X-Jan-Account-Id':'1234'},body:JSON.stringify({hash})});
  assert.equal(await denied.json(),null);
});

test('owner operations view shows only beta account IDs, device names and presence',async()=>{
  const {env,objects}=fixture();env.JAN_BETA_GITHUB_IDS='1234,5678';
  const owner=await login(env,1234),member=await login(env,5678);
  const id='12345678-1234-1234-1234-123456789abc';
  await objects.get('1234').state.storage.put('devices',{legacy:{id:'legacy',name:'Old tunnel PC',ownerId:'1234',created:Date.now(),revoked:false,lastSeen:Date.now()}});
  await objects.get('5678').state.storage.put('devices',{[id]:{id,name:'Member PC',os:'Private system description',ownerId:'5678',publicKey:'key-marker',created:Date.now(),revoked:false,lastSeen:0}});
  objects.get('5678').relay.getSession=()=>({online:true});
  const summary=await objects.get('5678').fetch(request('/device/status-summary',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:'{}'}));
  assert.deepEqual(await summary.json(),{activeBrowserSessions:1,recordedToolCalls:0,plan:'free',devices:[{name:'Member PC',online:true}]});
  const ownerPage=await portal(request('/admin',{headers:{Cookie:owner.cookie}}),env);
  assert.equal(ownerPage.status,200);
  const html=await ownerPage.text();
  for(const text of ['Account 1234','Account 5678','Member PC','Old tunnel PC','Unknown','Operations','Signed-in accounts','Online computers','Recorded tool calls','Free accounts have a 15,000-call monthly allowance'])assert.ok(html.includes(text));
  assert.match(html,/Signed-in accounts<\/div><div class="stat-value">2<\/div>/);
  for(const secret of ['Private system description','key-marker','Use this computer','Revoke access'])assert.ok(!html.includes(secret));
  assert.equal((await portal(request('/admin',{headers:{Cookie:member.cookie}}),env)).status,403);
  assert.equal((await portal(request('/admin'),env)).status,403);
  assert.match(await (await portal(request('/devices',{headers:{Cookie:owner.cookie}}),env)).text(),/href="\/admin">Operations/);
  assert.doesNotMatch(await (await portal(request('/devices',{headers:{Cookie:member.cookie}}),env)).text(),/href="\/admin">Operations/);
});

test('separate site roles keep public users out of owner monitoring and owner pages out of MCP',async()=>{
  const {env}=fixture();
  env.JAN_SITE_ROLE='public';
  assert.equal(siteRouteAllowed('public','/admin'),false);
  assert.equal(siteRouteAllowed('public','/admin/subscriptions'),false);
  assert.equal(siteRouteAllowed('public','/owner/login'),false);
  assert.equal(siteRouteAllowed('public','/devices'),true);
  env.JAN_SITE_ROLE='owner';
  assert.equal(siteRouteAllowed('owner','/devices'),false);
  assert.equal(siteRouteAllowed('owner','/mcp'),false);
  assert.equal(siteRouteAllowed('owner','/admin/subscriptions'),true);
  assert.equal(siteRouteAllowed('owner','/callback',true),true);
  assert.equal(siteRouteAllowed('owner','/callback',false),false);
  const signIn=await portal(request('/admin'),env);
  assert.equal(signIn.status,200);
  assert.match(await signIn.text(),/href="\/owner\/login"/);
  const start=await portal(request('/owner/login'),env);
  assert.equal(start.status,302);
  const state=new URL(start.headers.get('Location')).searchParams.get('state');
  const fetcher=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-token'}):Response.json({id:1234,login:'operator'});
  const callback=await portal(request('/callback?state='+state+'&code=synthetic',{headers:{Cookie:cookies(start)}}),env,fetcher);
  assert.equal(callback.status,302);
  assert.equal(callback.headers.get('Location'),origin+'/admin');
  const memberStart=await portal(request('/owner/login'),env);
  const memberState=new URL(memberStart.headers.get('Location')).searchParams.get('state');
  const memberProvider=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-member-token'}):Response.json({id:5678,login:'member'});
  const memberCallback=await portal(request('/callback?state='+memberState+'&code=synthetic',{headers:{Cookie:cookies(memberStart)}}),env,memberProvider);
  assert.equal(memberCallback.status,403);
  assert.match(await memberCallback.text(),/Owner account required/);
  assert.equal(memberCallback.headers.get('Set-Cookie'),null);
  const signed=await portal(request('/admin',{headers:{Cookie:cookies(callback)}}),env);
  assert.equal(signed.status,200);
  const page=await signed.text();
  assert.match(page,/action="\/owner\/logout"/);
  assert.doesNotMatch(page,/href="\/devices">Devices/);
  const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(page)?.[1];
  const logout=await portal(request('/owner/logout',{method:'POST',headers:{Cookie:cookies(callback),Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf})}),env);
  assert.equal(logout.status,303);
  assert.equal(logout.headers.get('Location'),origin+'/admin');
  const otherStart=await portal(request('/owner/login'),env);
  const otherState=new URL(otherStart.headers.get('Location')).searchParams.get('state');
  const otherFetcher=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-token'}):Response.json({id:5678,login:'other-user'});
  const rejected=await portal(request('/callback?state='+otherState+'&code=synthetic',{headers:{Cookie:cookies(otherStart)}}),env,otherFetcher);
  assert.equal(rejected.status,403);
  assert.equal(rejected.headers.get('Set-Cookie'),null);
});

test('public-mode account directory registers sign-ins and paginates status-only owner access',async()=>{
  const {env,objects}=fixture();
  const owner=await login(env,1234),member=await login(env,5678),another=await login(env,9999);
  assert.equal((await portal(request('/devices',{headers:{Cookie:another.cookie}}),env)).status,200);
  assert.equal((await portal(request('/admin',{headers:{Cookie:another.cookie}}),env)).status,403);
  const memberStore=objects.get('5678');
  await memberStore.state.storage.put('devices',{privateDevice:{id:'privateDevice',name:'Member laptop',os:'Sensitive OS detail',publicKey:'private-key-marker',ownerId:'5678',revoked:false}});
  const first=await portal(request('/admin',{headers:{Cookie:owner.cookie}}),env);
  assert.equal(first.status,200);
  const html=await first.text();
  for(const text of ['Account 1234','Account 5678','Account 9999','Member laptop','Offline'])assert.ok(html.includes(text));
  for(const secret of ['Sensitive OS detail','private-key-marker','Use this computer','Revoke access'])assert.ok(!html.includes(secret));
  assert.equal((await portal(request('/admin',{headers:{Cookie:member.cookie}}),env)).status,403);
  assert.match(await (await portal(request('/devices',{headers:{Cookie:owner.cookie}}),env)).text(),/href="\/admin">Operations/);
  const directory=objects.get('1234');
  const register=id=>directory.fetch(request('/directory/register',{method:'POST',headers:{'X-Jan-Account-Id':'1234'},body:JSON.stringify({id:String(id)})}));
  for(let id=1000;id<1026;id++)assert.equal((await register(id)).status,200);
  assert.equal((await register('01000')).status,403);
  const page=await portal(request('/admin',{headers:{Cookie:owner.cookie}}),env);
  assert.equal(page.status,200);
  const pageHtml=await page.text();
  const cursor=/href="\/admin\?after=([0-9]+)"/.exec(pageHtml)?.[1];
  assert.ok(cursor);
  assert.equal((pageHtml.match(/<h2>Account /g)??[]).length,25);
  const next=await portal(request('/admin?after='+cursor,{headers:{Cookie:owner.cookie}}),env);
  assert.equal(next.status,200);
  assert.match(await next.text(),/Account 5678/);
  assert.equal((await portal(request('/admin?after=0001',{headers:{Cookie:owner.cookie}}),env)).status,404);
});

test('two users have isolated sessions, pairing, devices and MCP routing',async()=>{
  const {env,routes}=fixture();
  const a=await login(env,1234),b=await login(env,5678);
  assert.notEqual(a.cookie,b.cookie);
  const aDevice=await pair(env,a);
  const list=async user=>(await (await portal(request('/devices/state',{headers:{Cookie:user.cookie}}),env)).json()).devices;
  assert.deepEqual((await list(a)).map(item=>item.id),[aDevice]);
  assert.deepEqual((await list(b)).map(item=>item.id),[]);
  const forged=a.cookie.replace('1234.','5678.');
  assert.equal((await portal(request('/devices/state',{headers:{Cookie:forged}}),env)).status,401);
  const select=async(user,id)=>portal(request('/devices/select',{method:'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id,csrf:user.csrf})}),env);
  assert.equal((await select(b,aDevice)).status,404);
  assert.equal((await select(a,aDevice)).status,303);
  const before=routes.length;
  const mcp=()=>request('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"jsonrpc":"2.0","method":"tools/list","id":1}'});
  const auth=id=>({audience:origin+'/mcp',scope:['jan:read'],userId:id});
  const aCall=await proxyMcp(mcp(),env,auth(a.id),{githubId:a.id});
  const bCall=await proxyMcp(mcp(),env,auth(b.id),{githubId:b.id});
  assert.match(await aCall.text(),/offline/i);
  assert.match(await bCall.text(),/No computer is selected/i);
  assert.deepEqual(routes.slice(before).filter(id=>!id.startsWith('abuse:v1:')),[a.id,a.id,env.ALLOWED_GITHUB_ID,b.id,b.id]);
  assert.equal(routes.slice(before).filter(id=>id.startsWith('abuse:v1:')).length,2);
  assert.equal((await proxyMcp(mcp(),env,auth(a.id),{githubId:b.id})).status,403);
  const bDevice=await pair(env,b);
  assert.deepEqual((await list(a)).map(item=>item.id),[aDevice]);
  assert.deepEqual((await list(b)).map(item=>item.id),[bDevice]);
  const revoke=async(user,id)=>portal(request('/devices/revoke',{method:'POST',headers:{Cookie:user.cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id,csrf:user.csrf,confirmation:'revoke'})}),env);
  assert.equal((await revoke(b,aDevice)).status,404);
  assert.equal((await revoke(a,aDevice)).status,303);
  assert.deepEqual((await list(b)).filter(item=>!item.revoked).map(item=>item.id),[bDevice]);
});

test('WebSocket routing hint is canonical and owner-restricted until enabled',()=>{
  const proof=id=>JSON.stringify({owner_id:id,device_id:'12345678-1234-1234-1234-123456789abc'});
  assert.equal(accountFromDeviceProof(proof('5678'),'1234','1'),'5678');
  assert.equal(accountFromDeviceProof(proof('5678'),'1234','0'),null);
  assert.equal(accountFromDeviceProof(proof('05678'),'1234','1'),null);
  assert.equal(accountFromDeviceProof('{','1234','1'),null);
});

test('temporary beta allowlist is canonical and blocks every account entry point',async()=>{
  const ids='1234,5678';
  assert.equal(validBetaIds(ids,'1234'),true);
  for(const bad of ['5678','1234,1234','1234,05678','1234,5678,','1234,not-an-id'])assert.equal(validBetaIds(bad,'1234'),false);
  assert.equal(permittedAccount('5678','1234','1',ids),'5678');
  assert.equal(permittedAccount('9999','1234','1',ids),null);
  assert.equal(accountFromDeviceProof(JSON.stringify({owner_id:'9999'}),'1234','1',ids),null);
  const {env}=fixture();env.JAN_BETA_GITHUB_IDS=ids;
  assert.equal((await portal(request('/devices/login'),env)).status,302);
  const start=await portal(request('/devices/login'),env);
  const state=new URL(start.headers.get('Location')).searchParams.get('state');
  const fetcher=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-token'}):Response.json({id:9999,login:'outsider'});
  const denied=await portal(request('/callback?state='+state+'&code=synthetic',{headers:{Cookie:cookies(start)}}),env,fetcher);
  assert.equal(denied.status,403);
  const message=await denied.text();
  assert.match(message,/approved test accounts/);
  assert.ok(!message.includes('synthetic-token'));
  assert.ok(!denied.headers.get('Set-Cookie').includes('__Host-JanPortal='));
});

test('OAuth callback issues a distinct identity only after the multi-user setting is enabled',async()=>{
  const {env}=fixture();
  const requestData={resource:origin+'/mcp',scope:['jan:read'],codeChallengeMethod:'S256',codeChallenge:'C'.repeat(43)};
  let completed=null;
  env.OAUTH_PROVIDER={describeConsent:async()=>({redirectUri:''}),finishUpstream:async()=>({request:requestData,data:{verifier:'synthetic-verifier'},headers:new Headers()}),completeAuthorization:async input=>{completed=input;return {redirectTo:'https://client.example/callback?code=synthetic'};}};
  const fetcher=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-github-token'}):Response.json({id:5678});
  const result=await authorization(request('/callback?code=synthetic'),env,fetcher);
  assert.equal(result.status,302);
  assert.equal(completed.userId,'5678');
  assert.deepEqual(completed.props,{githubId:'5678',authVersion:0});
  completed=null;
  const ownerOnly=await authorization(request('/callback?code=synthetic'),{...env,JAN_MULTI_USER_ENABLED:'0'},fetcher);
  assert.equal(ownerOnly.status,403);
  assert.equal(completed,null);
});

test('account storage refuses a foreign routing header and revoked pairing cannot be re-imported',async()=>{
  const {env,objects}=fixture();
  const a=await login(env,1234),b=await login(env,5678);
  const id=await pair(env,a);
  const accountStore=objects.get(a.id);
  const internal=(path,account,body={})=>accountStore.fetch(new Request('https://internal.invalid'+path,{method:'POST',headers:{'X-Jan-Account-Id':account,'Content-Type':'application/json'},body:JSON.stringify(body)}));
  assert.equal((await internal('/device/list',b.id)).status,403);
  assert.equal((await internal('/device/list',a.id)).status,200);
  const device=(await (await internal('/device/list',a.id)).json()).devices.find(item=>item.id===id);
  assert.ok(device);
  assert.equal((await internal('/device/revoke',a.id,{id})).status,200);
  const pending=await objects.get(a.id).state.storage.get('devices');
  const old=pending[id];
  assert.equal((await internal('/device/import',a.id,{...old,revoked:false})).status,403);
  assert.equal((await portal(request('/devices/state',{headers:{Cookie:b.cookie}}),env)).status,200);
});


test('website approval runs the immutable queued action once and exposes only its owner result',async()=>{
  const {env,objects}=fixture();env.JAN_SITE_ROLE='public';
  const owner=await login(env,5678),other=await login(env,9012);
  const object=objects.get('5678'),deviceId='22222222-2222-4222-8222-222222222222';
  await object.state.storage.put('devices',{[deviceId]:{id:deviceId,name:'Synthetic PC',ownerId:'5678',revoked:false,capabilities:['read','control','commands']}});
  await object.state.storage.put('active',deviceId);
  let forwarded=0,mode='ok';
  const imageData=Buffer.alloc(500000,113).toString('base64');
  object.relay.getSession=()=>({online:true,forward:async message=>{
    forwarded++;
    const original=JSON.parse(message.payload);
    assert.equal(original.params.arguments.command,'echo synthetic-auto');
    assert.equal(original.params.arguments.lease_token,'b'.repeat(43),'review redaction must not alter immutable execution arguments');
    if(mode==='unknown')throw Error('Relay timeout');
    if(mode==='rpc-error')return {type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:original.id,error:{code:-32000,message:'Local request outcome unknown',data:{outcome_unknown:true,automatic_retry:false}}})};
    if(mode.startsWith('rpc-busy'))return {type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:original.id,error:{code:mode==='rpc-busy-wrong-code'?-32000:-32001,message:'password=SYNTHETIC_BUSY_MESSAGE_PRIVATE',data:{error_code:'LOCAL_BUSY',executed:mode==='rpc-busy-executed',automatic_retry:false,...(mode==='rpc-busy-extra'?{extra:true}:{})}}})};
    if(mode==='image'||mode==='huge-image')return {type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:original.id,result:{content:[{type:'text',text:'Synthetic screenshot'},{type:'image',mimeType:'image/jpeg',data:imageData+(mode==='huge-image'?'a'.repeat(160000):'')}],structuredContent:{frame_id:'synthetic-frame'}}})};
    const text=mode==='large'?'x'.repeat(40000):'SYNTHETIC_RESULT';
    return {type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:original.id,result:{isError:mode==='large',content:[{type:'text',text}]}})};
  }});
  const queue=async()=>{
    const envelope={type:'request',request_id:crypto.randomUUID(),control:true,payload:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_command',arguments:{command:'echo synthetic-auto',confirmed:true,task_id:'a'.repeat(32),lease_token:'b'.repeat(43)}}})};
    const response=await object.fetch(new Request('https://internal.invalid/relay/dispatch',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify(envelope)}));
    const text=JSON.parse((await response.json()).payload).result.content[0].text;
    return /actions\?id=([a-f0-9-]{36})/.exec(text)[1];
  };
  const decide=(id,decision='approve',user=owner)=>portal(request('/devices/actions',{method:'POST',headers:{Cookie:user.cookie,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({id,decision,csrf:user.csrf})}),env);
  const result=async(id,userId='5678')=>env.DEVICES.get(userId).fetch(new Request('https://internal.invalid/actions/result',{method:'POST',headers:{'X-Jan-Account-Id':userId},body:JSON.stringify({id})}));
  const id=await queue();assert.equal(forwarded,0);
  const review=await portal(request('/devices/actions?id='+id,{headers:{Cookie:owner.cookie}}),env);
  const reviewText=await review.text();
  assert.match(reviewText,/Approve and run once/);
  assert.ok(!reviewText.includes('b'.repeat(43)));
  assert.equal((await decide(id,'approve',other)).status,409);
  assert.equal(forwarded,0);
  const outcomes=await Promise.all([decide(id),decide(id)]);
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[303,409]);
  assert.equal(forwarded,1,'website approval executes without retrying the tool');
  assert.equal((await result(id,'9012')).status,404);
  const receipt=await (await result(id)).json();
  assert.equal(receipt.status,'completed');
  assert.equal(receipt.result.content[0].text,'SYNTHETIC_RESULT');
  assert.ok(!JSON.stringify(await object.state.storage.get('actions:result:'+id)).includes('SYNTHETIC_RESULT'));
  const finished=await portal(request('/devices/actions?id='+id,{headers:{Cookie:owner.cookie}}),env);
  assert.match(await finished.text(),/No retry is needed/);
  await result(id);await result(id);assert.equal(forwarded,1);
  const denied=await queue();assert.equal((await decide(denied,'deny')).status,303);
  assert.equal((await (await result(denied)).json()).status,'denied');assert.equal(forwarded,1);
  // Remove a denied synthetic intent so the same exact command can test another outcome.
  await object.state.storage.put('actions:v1',[]);
  mode='unknown';const unknown=await queue();
  assert.equal((await decide(unknown)).status,303);
  assert.equal((await (await result(unknown)).json()).status,'unknown');
  assert.equal(forwarded,2);assert.equal((await decide(unknown)).status,409);assert.equal(forwarded,2);
  mode='image';const image=await queue();await decide(image);
  const captured=await (await result(image)).json();
  assert.equal(captured.result.content[1].type,'image');
  assert.equal(captured.result.content[1].data,imageData);
  assert.equal(captured.result.structuredContent.frame_id,'synthetic-frame');
  const parts=await object.state.storage.list({prefix:'actions:result-part:'+image+':'});
  assert.ok(parts.size>1);
  assert.ok([...parts.values()].every(part=>!JSON.stringify(part).includes(imageData.slice(0,80))));
  assert.ok([...parts.values()].every(part=>Buffer.byteLength(JSON.stringify(part))<128*1024));
  assert.equal((await result(image,'9012')).status,404);
  const firstPart=[...parts.keys()][0],savedPart=await object.state.storage.get(firstPart);
  await object.state.storage.delete(firstPart);assert.equal((await result(image)).status,503);
  await object.state.storage.put(firstPart,savedPart);
  const savedImage=await object.state.storage.get('actions:result:'+image);
  await object.state.storage.put('actions:result:'+image,{...savedImage,parts:49});assert.equal((await result(image)).status,503);
  await object.state.storage.put('actions:result:'+image,savedImage);
  mode='huge-image';const huge=await queue();await decide(huge);
  const tooLarge=await (await result(huge)).json();
  assert.equal(tooLarge.result.isError,true);assert.match(tooLarge.result.content[0].text,/768 KiB/);
  assert.equal((await object.state.storage.list({prefix:'actions:result-part:'+huge+':'})).size,0);
  mode='large';const large=await queue();await decide(large);
  const bounded=await (await result(large)).json();assert.equal(bounded.result.isError,true);
  assert.match(bounded.result.content[0].text,/32 KiB/);assert.equal(forwarded,5);
  const stale=await queue();await object.state.storage.delete('active');
  assert.equal((await decide(stale)).status,409);assert.equal(forwarded,5);
  await object.state.storage.put('active',deviceId);
  const devices=await object.state.storage.get('devices');devices[deviceId].revoked=true;await object.state.storage.put('devices',devices);
  assert.equal((await decide(stale)).status,409);assert.equal(forwarded,5);
  devices[deviceId].revoked=false;await object.state.storage.put('devices',devices);
  for(let i=0;i<64;i++)await object.state.storage.put('actions:result:limit-'+i,{expires:Date.now()+600000});
  assert.equal((await decide(stale)).status,429);assert.equal(forwarded,5);
  for(let i=0;i<64;i++)await object.state.storage.delete('actions:result:limit-'+i);
  const interruptedId='44444444-4444-4444-8444-444444444444',interruptedExpiry=Date.now()+569000;
  await object.state.storage.put('actions:result:'+interruptedId,{deviceId,expires:interruptedExpiry,status:'running',sealed:await sealRecord(env.JAN_PROXY_KEY,'5678','action-result',{name:'run_command',args:{}},interruptedExpiry)});
  assert.equal((await (await result(interruptedId)).json()).status,'unknown');assert.equal(forwarded,5);
  const expired=await object.state.storage.get('actions:result:'+id);expired.expires=Date.now()-1;await object.state.storage.put('actions:result:'+id,expired);
  assert.equal((await result(id)).status,404);
  await object.state.storage.put('actions:v1',[]);
  mode='rpc-error';const rpcError=await queue();await decide(rpcError);
  assert.equal((await (await result(rpcError)).json()).status,'unknown');
  assert.equal(forwarded,6);assert.equal((await decide(rpcError)).status,409);assert.equal(forwarded,6);
  mode='rpc-busy';const busy=await queue();await decide(busy);
  const busyReceipt=await (await result(busy)).json();
  assert.equal(busyReceipt.status,'completed');
  assert.equal(busyReceipt.result.isError,true);
  assert.deepEqual(busyReceipt.result.structuredContent,{error_code:'LOCAL_BUSY',executed:false,automatic_retry:false});
  assert.match(busyReceipt.result.content[0].text,/not executed/);
  assert.ok(!JSON.stringify(busyReceipt).includes('SYNTHETIC_BUSY_MESSAGE_PRIVATE'));
  assert.equal(forwarded,7);await result(busy);assert.equal(forwarded,7);
  assert.equal((await decide(busy)).status,409);assert.equal(forwarded,7);
  for(const unsafe of ['rpc-busy-executed','rpc-busy-wrong-code','rpc-busy-extra']) {
    mode=unsafe;const id=await queue();await decide(id);
    const receipt=await (await result(id)).json();
    assert.equal(receipt.status,'unknown');
    assert.ok(!JSON.stringify(receipt).includes('SYNTHETIC_BUSY_MESSAGE_PRIVATE'));
    const count=forwarded;assert.equal((await decide(id)).status,409);assert.equal(forwarded,count);
  }

});
