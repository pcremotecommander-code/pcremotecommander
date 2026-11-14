import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {fileURLToPath} from 'node:url';
import {readFileSync} from 'node:fs';

const base='https://jan-gateway.example.workers.dev';
const bindings={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://one-two-three-four.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClientId',GITHUB_CLIENT_SECRET:'synthetic-secret-for-tests',ALLOWED_GITHUB_ID:'1234'};
const digest=async text=>Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))).toString('base64url');
function cookies(response){return response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');}

for (const control of [false,true]) test('real OAuth lifecycle and control scope isolation: '+control,async()=>{
 let originCalls=0;let expectedUpstreamChallenge='';
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'jan',modules:true,script:readFileSync(fileURLToPath(new URL('../build/index.js',import.meta.url)),'utf8'),compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{DEVICES:{className:'JanDeviceStore',useSQLite:true}},bindings,
  outboundService:async request=>{
   const url=new URL(request.url);
   if(url.href==='https://github.com/login/oauth/access_token') {
    const form=await request.formData();assert.equal(await digest(String(form.get('code_verifier'))),expectedUpstreamChallenge);assert.equal(form.get('client_secret'),bindings.GITHUB_CLIENT_SECRET);
    return Response.json({access_token:'synthetic-github-token'});
   }
   if(url.href==='https://api.github.com/user') {assert.equal(request.headers.get('Authorization'),'Bearer synthetic-github-token');return Response.json({id:1234});}
   if(url.origin===bindings.JAN_ORIGIN) {assert.equal(request.headers.get('X-JAN-Control'),control?'1':'0');originCalls++;assert.equal(url.pathname,'/mcp');assert.equal(request.headers.get('Authorization'),'Bearer '+bindings.JAN_PROXY_KEY);assert.equal(request.headers.get('Cookie'),null);return Response.json({jsonrpc:'2.0',id:1,result:{gateway_reached_authenticated_origin:true}});}
   throw new Error('Unexpected outbound request: '+url.origin+url.pathname);
  }}]}));
 try {
  const call=(path,init={})=>mf.dispatchFetch(base+path,{redirect:"manual",...init});
  const denied=await call('/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(denied.status,401);assert.ok(denied.headers.get('WWW-Authenticate').includes('resource_metadata'));assert.ok(denied.headers.get('WWW-Authenticate').includes('scope="pcrc:read pcrc:control"'));
  assert.ok(!denied.headers.get('WWW-Authenticate').includes('error='),'initial setup must remain an ordinary OAuth challenge');
  assert.equal(originCalls,0);
  const metadata=await (await call('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(metadata.resource,base+'/mcp');assert.deepEqual(metadata.scopes_supported,['pcrc:read','pcrc:control']);
  const rootMetadata=await (await call('/.well-known/oauth-protected-resource')).json();assert.deepEqual(rootMetadata.scopes_supported,['pcrc:read','pcrc:control']);
  const authMetadata=await (await call('/.well-known/oauth-authorization-server')).json();assert.deepEqual(authMetadata.scopes_supported,['pcrc:read','pcrc:control']);
  const registration=await call('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'JAN integration test',redirect_uris:['https://client.example/callback'],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});
  assert.equal(registration.status,201,await registration.clone().text());
  const client=await registration.json(); const verifier='V'.repeat(64);
  const params=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://client.example/callback',scope:control?'jan:read jan:control':'jan:read',state:'client-state',code_challenge:await digest(verifier),code_challenge_method:'S256',resource:base+'/mcp'});
  const consent=await call('/authorize?'+params);assert.equal(consent.status,303,await consent.clone().text());
  const consentRoute=consent.headers.get('Location').slice(base.length);
  assert.equal((await call(consentRoute)).status,400,'Missing browser cookie must not show approval buttons');
  const display=await call(consentRoute,{headers:{Cookie:cookies(consent)}});assert.equal(display.status,200);assert.equal(display.headers.get('Referrer-Policy'),'strict-origin');
  assert.ok(display.headers.get('Content-Security-Policy').includes("form-action 'self' https://github.com https://client.example;"));
  const page=await display.text();assert.ok(page.includes(control?'control locally enabled files':'read the approved workspace'));const handle=page.match(/name="handle" value="([^"]+)"/)[1];
  const refreshedPage=await call(consentRoute,{headers:{Cookie:cookies(consent)}});assert.equal(await refreshedPage.text(),page,'Refresh must keep the same transaction');
  const form=new URLSearchParams({handle,decision:'approve'});
  const forged=await call('/authorize',{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});assert.equal(forged.status,400);
  assert.equal((await forged.clone().json()).code,'AUTH_BROWSER_REQUIRED');
  assert.match(forged.headers.get('Content-Type'),/^application\/json/);
  const wrongCookie=cookies(consent).replace(/=.+$/, '='+'0'.repeat(64));
  const mismatched=await call('/authorize',{method:'POST',headers:{Origin:base,Cookie:wrongCookie,'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  assert.equal(mismatched.status,400);assert.equal((await mismatched.json()).code,'AUTH_BROWSER_MISMATCH');
  const mismatchedPage=await call('/authorize',{method:'POST',headers:{Origin:base,Cookie:wrongCookie,Accept:'text/html','Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  assert.equal(mismatchedPage.status,400);assert.match(await mismatchedPage.text(),/Start a new connection/);
  const missingCookiePage=await call('/authorize',{method:'POST',headers:{Origin:base,Accept:'text/html','Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  assert.equal(missingCookiePage.status,400);assert.match(missingCookiePage.headers.get('Content-Type'),/^text\/html/);
  const recovery=await missingCookiePage.text();assert.match(recovery,/Start a new connection/);assert.ok(!recovery.includes(handle));assert.ok(!recovery.includes('name="decision"'));
  assert.equal(missingCookiePage.headers.get('Cache-Control'),'no-store');assert.equal(missingCookiePage.headers.get('Referrer-Policy'),'no-referrer');
  const redirect=await call('/authorize',{method:'POST',headers:{Origin:base,Cookie:cookies(consent),'Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  assert.equal(redirect.status,200,await redirect.clone().text());
  assert.match(await redirect.clone().text(),new RegExp('Your '+(control?'read and control':'read-only')+' request was accepted'));
  const github=new URL((await redirect.clone().text()).match(/href="(https:\/\/github\.com[^"]+)"/)[1].replaceAll('&#38;','&'));expectedUpstreamChallenge=github.searchParams.get('code_challenge');
  const callback='/callback?'+new URLSearchParams({state:github.searchParams.get('state'),code:'synthetic-code'});
  assert.equal((await call(callback)).status,400);
  const finished=await call(callback,{headers:{Cookie:cookies(redirect)}});assert.equal(finished.status,302,await finished.clone().text());
  const replayedConsent=await call('/authorize',{method:'POST',headers:{Origin:base,Cookie:cookies(consent),Accept:'text/html','Content-Type':'application/x-www-form-urlencoded'},body:form.toString()});
  assert.equal(replayedConsent.status,400);assert.match(await replayedConsent.text(),/Start a new connection/);
  const returned=new URL(finished.headers.get('Location'));assert.equal(returned.searchParams.get('state'),'client-state');assert.equal(returned.searchParams.get('iss'),base);
  const tokenParams=new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:returned.searchParams.get('code'),redirect_uri:'https://client.example/callback',code_verifier:verifier,resource:base+'/mcp'});
  for (const changes of [{code_verifier:'W'.repeat(64)},{resource:'https://wrong.example/mcp'},{redirect_uri:'https://client.example/callback/extra'},{redirect_uri:'https://client.example/callback?next=other'}]) {
   const invalid=new URLSearchParams(tokenParams);for(const [key,value] of Object.entries(changes)) invalid.set(key,value);
   const failed=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:invalid.toString()});assert.notEqual(failed.status,200);
  }
  const tokenResult=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:tokenParams.toString()});assert.equal(tokenResult.status,200,await tokenResult.clone().text());
  const tokens=await tokenResult.json();assert.ok(tokens.access_token);assert.ok(tokens.refresh_token);
  assert.equal(tokens.expires_in,900);
  assert.equal((await call('/mcp',{method:'POST',headers:{Authorization:'Bearer invalid','Content-Type':'application/json'},body:'{}'})).status,401);
  const authorized=await call('/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json'},body:'{"jsonrpc":"2.0","method":"tools/list","id":1}'});
  assert.equal(authorized.status,200,await authorized.clone().text());assert.equal(originCalls,1);
  const kv=await mf.getKVNamespace('OAUTH_KV'),keys=await kv.list({prefix:'token:1234:'});
  assert.equal(keys.keys.length,1);
  const tokenKey=keys.keys[0].name,saved=await kv.get(tokenKey,'json');assert.ok(saved.expiresAt);
  await kv.put(tokenKey,JSON.stringify({...saved,expiresAt:Math.floor(Date.now()/1000)-1}));
  const expired=await call('/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json'},body:'{"jsonrpc":"2.0","method":"ping","id":1}'});
  assert.equal(expired.status,401);assert.equal(originCalls,1,'expired tokens never reach the computer');
  assert.match(expired.headers.get('WWW-Authenticate'), /error="invalid_token"/, 'Keep the OAuth signal that tells clients to refresh an expired access token');
  await kv.put(tokenKey,JSON.stringify(saved));
  const dangerous=await call('/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json','X-JAN-Control':'1'},body:JSON.stringify({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'jan_run_command',arguments:{command:'echo test'}}})});
  assert.equal(dangerous.status,control?200:403);assert.equal(originCalls,control?2:1);
  const escalated=new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:base+'/mcp',scope:'jan:read jan:control'});
  if(!control) {
   const answer=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:escalated.toString()});
   if(answer.status===200) {
    const narrowed=await answer.json();
    assert.ok(!String(narrowed.scope).split(' ').includes('jan:control'));
    assert.equal((await call('/mcp',{method:'POST',headers:{Authorization:'Bearer '+narrowed.access_token,'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'jan_run_command',arguments:{command:'echo test'}}})})).status,403);
   }
  }
  assert.equal((await call(callback,{headers:{Cookie:cookies(redirect)}})).status,400);
  const refresh=new URLSearchParams({grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:base+'/mcp'});
  const grants=await kv.list({prefix:'grant:1234:'});assert.equal(grants.keys.length,1);
  const grantKey=grants.keys[0].name,grant=await kv.get(grantKey,'json');
  assert.ok(Math.abs(grant.expiresAt-Math.floor(Date.now()/1000)-2592000)<60);
  // A still-valid old grant must migrate on refresh without new consent or scope changes.
  await kv.put(grantKey,JSON.stringify({...grant,expiresAt:Math.floor(Date.now()/1000)+120}));
  const refreshed=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:refresh.toString()});assert.equal(refreshed.status,200,await refreshed.clone().text());
  const renewed=await refreshed.json();assert.ok(renewed.access_token);assert.ok(renewed.refresh_token);
  assert.equal(renewed.expires_in,900);
  const sliding=await kv.get(grantKey,'json');
  assert.ok(Math.abs(sliding.expiresAt-Math.floor(Date.now()/1000)-2592000)<60);
  assert.equal(sliding.clientId,grant.clientId);assert.deepEqual(sliding.scope,grant.scope);
  assert.equal(sliding.encryptedProps,grant.encryptedProps);
  // Each request creates a new provider, as a deployment does; refresh must not require new consent.
  let rotating=renewed;
  for(let cycle=0;cycle<3;cycle++) {
   const next=new URLSearchParams(refresh);next.set('refresh_token',rotating.refresh_token);
   const answer=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:next.toString()});
   assert.equal(answer.status,200);rotating=await answer.json();assert.equal(rotating.expires_in,900);
   const reached=await call('/mcp',{method:'POST',headers:{Authorization:'Bearer '+rotating.access_token,'Content-Type':'application/json'},body:'{"jsonrpc":"2.0","method":"ping","id":1}'});
   assert.equal(reached.status,200,'a refreshed token can reach the backend without another sign-in');
  }
  const badRefresh=new URLSearchParams(refresh);badRefresh.set('refresh_token',rotating.refresh_token);badRefresh.set('resource','https://wrong.example/mcp');
  assert.notEqual((await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:badRefresh.toString()})).status,200);

  const currentGrant=await kv.get(grantKey,'json');
  await kv.put(grantKey,JSON.stringify({...currentGrant,expiresAt:Math.floor(Date.now()/1000)-1}));
  const inactive=new URLSearchParams(refresh);inactive.set('refresh_token',rotating.refresh_token);
  const afterExpiryCalls=originCalls;
  const expiredRefresh=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:inactive.toString()});
  assert.equal(expiredRefresh.status,400);assert.equal((await expiredRefresh.json()).error_description,'Refresh token has expired');
  assert.equal(originCalls,afterExpiryCalls);
  const replay=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:tokenParams.toString()});assert.notEqual(replay.status,200);
 } finally {await mf.dispose();}
});

test('public email sign-in preserves ChatGPT callback code, exact opaque state and issuer through real OAuth runtime',async()=>{
 const redirect='https://chatgpt.com/connector_platform_oauth_redirect',opaqueState='client_state +/=?&opaque-value',verifier='V'.repeat(64);
 const env={...bindings,JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_PAIRING_ENABLED:'1',PCRC_EMAIL_AUTH_ENABLED:'1',SUPABASE_URL:'https://'+'a'.repeat(20)+'.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'K'.repeat(30)};
 const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'pcrc-public',modules:true,script:readFileSync(fileURLToPath(new URL('../build/index.js',import.meta.url)),'utf8'),compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{DEVICES:{className:'JanDeviceStore',useSQLite:true}},bindings:env,outboundService:async request=>{
  const url=new URL(request.url);assert.equal(url.origin,env.SUPABASE_URL);
  if(url.pathname==='/auth/v1/token')return Response.json({access_token:'synthetic-provider-token-not-real'});
  assert.equal(url.pathname,'/auth/v1/user');return Response.json({id:'12345678-1234-4123-8123-123456789abc',email:'synthetic@example.test',email_confirmed_at:new Date().toISOString(),user_metadata:{pcrc_username:'synthetic12'}});
 }}]}));
 try{
  const jar=new Map();const call=async(path,init={})=>{const response=await mf.dispatchFetch(base+path,{redirect:'manual',...init,headers:{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...(init.headers??{})}});for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}return response;};
  const registered=await call('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'PCRC callback regression',redirect_uris:[redirect],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'})});assert.equal(registered.status,201);const client=await registered.json();
  const params=new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:redirect,scope:'pcrc:read',state:opaqueState,code_challenge:await digest(verifier),code_challenge_method:'S256',resource:base+'/mcp'});
  const begun=await call('/authorize?'+params);assert.equal(begun.status,303);const consentPath=begun.headers.get('Location').slice(base.length);
  const unsigned=await call(consentPath);assert.equal(unsigned.status,303);const signInPath=unsigned.headers.get('Location').slice(base.length);
  const signIn=await call(signInPath),html=await signIn.text(),csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)[1];
  const logged=await call('/devices/email/sign-in',{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,email:'synthetic@example.test',password:'SyntheticPassword123!'}).toString()});assert.equal(logged.status,302);assert.equal(logged.headers.get('Location'),base+consentPath);
  const display=await call(consentPath),page=await display.text();assert.equal(display.status,200);assert.ok(page.includes('synthetic12'));const handle=/name="handle" value="([^"]+)"/.exec(page)[1];
  const finished=await call('/authorize',{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({handle,decision:'approve'}).toString()});assert.equal(finished.status,303);
  const returned=new URL(finished.headers.get('Location'));assert.equal(returned.origin+returned.pathname,redirect);assert.ok(returned.searchParams.get('code'));assert.equal(returned.searchParams.get('state'),opaqueState);assert.equal(returned.searchParams.get('iss'),base);
  const token=await call('/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:client.client_id,code:returned.searchParams.get('code'),redirect_uri:redirect,code_verifier:verifier,resource:base+'/mcp'}).toString()});assert.equal(token.status,200);assert.ok((await token.json()).access_token);
 }finally{await mf.dispose();}
});
