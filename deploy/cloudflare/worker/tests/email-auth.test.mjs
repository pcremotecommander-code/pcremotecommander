import {authorization} from '../src/authorization.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {portal,createPortalSession,session,deviceStore} from '../src/device_portal.ts';
import {JanDeviceStore} from '../src/device_store.ts';
import {proxyMcp} from '../src/policy.ts';
const origin='https://email.example.workers.dev',subject='12345678-1234-4123-8123-123456789abc',other='22345678-1234-4123-8123-123456789abc',secret='Only-a-synthetic-test-password-42';
class Storage{entries=new Map();async get(k){return structuredClone(this.entries.get(k));}async put(k,v){this.entries.set(k,structuredClone(v));}async delete(k){if(Array.isArray(k)){for(const key of k)this.entries.delete(key);return k.length;}return this.entries.delete(k);}async transaction(fn){return fn(this);}async list({prefix='',limit=1000}={}){return new Map([...this.entries].filter(([k])=>k.startsWith(prefix)).slice(0,limit));}}
function fixture(){
 const stores=new Map(),objects=new Map(),calls=[];
 const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_PAIRING_ENABLED:'1',JAN_MULTI_USER_ENABLED:'1',PCRC_EMAIL_AUTH_ENABLED:'1',SUPABASE_URL:'https://'+'a'.repeat(20)+'.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'K'.repeat(30)};
 env.DEVICES={idFromName:id=>id,get:id=>{if(!objects.has(id)){const storage=new Storage();stores.set(id,storage);objects.set(id,new JanDeviceStore({storage},env));}return {fetch:(url,init)=>objects.get(id).fetch(new Request(url,init))};}};
 const user={id:subject,email:'synthetic@example.test',user_metadata:{pcrc_username:'synthetic12'},email_confirmed_at:new Date().toISOString()};
 const provider=async(url,init)=>{assert.ok(url.startsWith(env.SUPABASE_URL+'/auth/v1/'));calls.push({url,init});if(url.endsWith('/user')&&init.method==='GET')return Response.json(user);if(url.includes('/token?'))return Response.json({access_token:'synthetic-access-token-that-is-not-a-secret',user:{id:other}});return Response.json({});};
 const request=(path,options={})=>new Request(origin+path,options);
 const call=(path,options={})=>portal(request(path,options),env,provider);
 return {env,calls,user,provider,stores,request,call};
}
const cookies=response=>response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
async function form(f,path='/devices/sign-in',extraCookie=''){
 const page=await f.call(path,{headers:{Cookie:extraCookie}}),html=await page.text();
 assert.equal(page.status,200,html.slice(-500));
 return {csrf:/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1],cookie:[cookies(page),extraCookie].filter(Boolean).join('; '),html};
}
const post=(f,path,value,fields={},headers={})=>f.call(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:value.cookie,...headers},body:new URLSearchParams({csrf:value.csrf,email:'synthetic@example.test',username:'synthetic12',password:secret,confirmation:secret,...fields})});
async function login(f,value){value??=await form(f);return post(f,'/devices/email/sign-in',value);}

test('login separates provider configuration failures from rejected credentials without exposing provider text',async()=>{
 for(const [status,code,expected] of [[401,'invalid_api_key',503],[400,'invalid_credentials',400],[400,'email_not_confirmed',400],[429,'over_request_rate_limit',429]]){
  const f=fixture(),value=await form(f);
  const response=await portal(f.request('/devices/email/sign-in',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:value.cookie},body:new URLSearchParams({csrf:value.csrf,email:'synthetic@example.test',password:secret})}),f.env,async()=>Response.json({code,message:'synthetic-private-provider-detail'},{status}));
  assert.equal(response.status,expected);
  const text=await response.text();assert.ok(!text.includes(secret)&&!text.includes('synthetic-private-provider-detail'));
  assert.ok(!cookies(response).includes('__Host-JanPortal='));
  if(code==='invalid_credentials'){assert.match(text,/PCRC username or email/);assert.match(text,/aria-invalid="true"/);}
  if(code==='email_not_confirmed')assert.match(text,/Verify your email/);
  if(expected===503)assert.doesNotMatch(text,/Check your.*password/);
 }
});

test('provider requests use Workers-compatible manual redirects and never follow a redirect with credentials',async()=>{
 const f=fixture(),value=await form(f);let calls=0;
 const response=await portal(f.request('/devices/email/sign-in',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:value.cookie},body:new URLSearchParams({csrf:value.csrf,email:'synthetic@example.test',password:secret})}),f.env,async(url,init)=>{
  assert.equal(init.redirect,'manual');calls++;return new Response(null,{status:302,headers:{Location:'https://untrusted.example'}});
 });
 assert.equal(calls,1);assert.ok(response.status>=400);assert.doesNotMatch(await response.text(),/untrusted.example/);
});

test('signup enforces short lowercase usernames and marks invalid fields inline without echoing passwords',async()=>{
 const f=fixture();
 for(const username of ['Uppercase','has_symbol','has-dash','bad!name','a'.repeat(13),'ab']){
  const response=await post(f,'/devices/email/signup',await form(f,'/devices/email/signup'),{username});
  assert.equal(response.status,400);const html=await response.text();
  assert.match(html,/<input id="email-auth-username"[^>]*aria-invalid="true"/);
  assert.match(html,/data-auth-mode="signup"/);assert.ok(!html.includes(secret));
 }
 assert.equal(f.calls.length,0);
 const valid=await post(f,'/devices/email/signup',await form(f,'/devices/email/signup'),{username:'123abc'});
 assert.equal(valid.status,200);assert.equal(JSON.parse(f.calls[0].init.body).data.pcrc_username,'123abc');
 f.user.user_metadata.pcrc_username='123abc';assert.equal((await login(f)).status,302);
 assert.equal((await post(f,'/devices/email/sign-in',await form(f),{email:'123abc'})).status,302);
});

test('new passwords require every character class and mismatches mark both password fields',async()=>{
 const f=fixture();
 for(const password of ['lowercase123!a','UPPERCASE123!A','NoNumbersHere!','NoSymbolHere123']){
  const response=await post(f,'/devices/email/signup',await form(f,'/devices/email/signup'),{password,confirmation:password});
  assert.equal(response.status,400);const html=await response.text();
  assert.match(html,/<input id="email-auth-password"[^>]*aria-invalid="true"/);
  assert.ok(!html.includes(password));
 }
 const response=await post(f,'/devices/email/signup',await form(f,'/devices/email/signup'),{confirmation:secret+'different'});
 assert.equal(response.status,400);const html=await response.text();
 for(const name of ['password','confirmation'])assert.match(html,new RegExp('<input id="email-auth-'+name+'"[^>]*aria-invalid="true"'));
 assert.match(html,/name="email"[^>]*value="synthetic@example.test"/);
 assert.ok(!html.includes(secret));assert.equal(f.calls.length,0);
});

test('email login verifies provider user, stores only opaque cookies and isolates accounts',async()=>{
 const f=fixture(),value=await form(f);
 assert.match(value.html,/Forgot password/);assert.match(value.html,/Create account/);assert.match(value.html,/signin-art/);
 const result=await login(f,value);assert.equal(result.status,302);
 const byName=await post(f,'/devices/email/sign-in',await form(f),{email:'synthetic12'});assert.equal(byName.status,302);
 const cookie=cookies(result);assert.ok(cookie.includes('s-'+subject+'.'));assert.ok(!cookie.includes('synthetic-access-token'));assert.ok(!cookie.includes(secret));
 const owner=await session(f.request('/devices',{headers:{Cookie:cookie}}),f.env);assert.equal(owner.userId,'s-'+subject);
 assert.notEqual(owner.userId,'s-'+other);assert.equal(owner.authVersion,0);
 const page=await f.call('/devices',{headers:{Cookie:cookie}});assert.equal(page.status,200);
 assert.match(await page.text(),/synthetic12/);
 const all=JSON.stringify([...f.stores].map(([id,s])=>[id,[...s.entries]]));assert.ok(!all.includes(secret));assert.ok(!all.includes('synthetic-access-token'));
});

test('email forms preserve same-origin browser POST provenance without allowing null or foreign origins',async()=>{
 const f=fixture();
 for(const path of ['/devices/sign-in','/devices/email/signup','/devices/email/forgot']){
  const response=await f.call(path);
  assert.equal(response.headers.get('Referrer-Policy'),'same-origin');
 }
 for(const Origin of ['null','https://evil.example']){
  const response=await post(f,'/devices/email/sign-in',await form(f),{},{Origin});
  assert.equal(response.status,403);
 }
 assert.equal(f.calls.length,0);
});

test('email forms reject forged origin, missing CSRF, cookie tampering and invalid destinations before provider requests',async()=>{
 const f=fixture(),value=await form(f);
 for(const [fields,headers] of [[{csrf:'wrong'},{}],[{}, {Origin:'https://evil.example'}],[{}, {Cookie:'__Host-PcrcEmailFlow=tampered'}]])assert.equal((await post(f,'/devices/email/sign-in',value,fields,headers)).status>=400,true);
 assert.equal(f.calls.length,0);
 for(const target of ['//evil.example','https://evil.example','/devices/state','/devices/plan?token=secret'])assert.equal((await f.call('/devices/sign-in?'+new URLSearchParams({return:target}))).status,400);
});

test('unconfirmed email cannot acquire a PCRC session',async()=>{
 const f=fixture();delete f.user.email_confirmed_at;
 const result=await login(f);assert.equal(result.status,403);assert.ok(!cookies(result).includes('__Host-JanPortal='));
});

test('signup uses browser-bound PKCE and callback creates a verified account',async()=>{
 const f=fixture(),value=await form(f,'/devices/email/signup');
 const sent=await post(f,'/devices/email/signup',value);assert.equal(sent.status,200);
 const call=f.calls.find(c=>c.url.includes('/signup?'));const body=JSON.parse(call.init.body);
 assert.equal(body.code_challenge_method,'s256');assert.equal(body.code_challenge.length,43);assert.ok(!call.init.body.includes('code_verifier'));
 assert.equal(new URL(call.url).searchParams.get('redirect_to'),origin+'/devices/email/callback');
 assert.equal((await f.call('/devices/email/callback?code=synthetic')).status,400);
 const callback=await f.call('/devices/email/callback?code=synthetic',{headers:{Cookie:value.cookie}});assert.equal(callback.status,303);
 assert.equal(callback.headers.get('Location'),origin+'/devices/email/verified');
 assert.ok(cookies(callback).includes('s-'+subject+'.'));
});

test('verification completion is bound to the original form and authenticated account, with no credentials in its URL',async()=>{
 const f=fixture(),value=await form(f,'/devices/email/signup');
 const sent=await post(f,'/devices/email/signup',value);const waiting=await sent.text();
 assert.match(waiting,/data-email-verification="waiting"/);assert.ok(waiting.includes('data-flow="'+value.csrf+'"'));
 assert.match(waiting,/nonce="[^"]+" src="\/email-verification.js"/);
 const check=Cookie=>f.call('/devices/email/verification-status',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie},body:new URLSearchParams({flow:value.csrf})});
 assert.deepEqual(await (await check(value.cookie)).json(),{verified:false});
 const callback=await f.call('/devices/email/callback?code=synthetic',{headers:{Cookie:value.cookie}}),cookie=cookies(callback);
 const page=await f.call('/devices/email/verified',{headers:{Cookie:cookie}});assert.equal(page.status,200);assert.match(await page.text(),/Verification completed/);
 assert.deepEqual(await (await check(cookie)).json(),{verified:true,target:'/devices'});
 const otherFlow=await f.call('/devices/email/verification-status',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie},body:new URLSearchParams({flow:'X'.repeat(43)})});assert.deepEqual(await otherFlow.json(),{verified:false});
 const completeOnly=cookie.split('; ').filter(part=>part.startsWith('__Host-PcrcEmailComplete=')).join('; ');
 assert.deepEqual(await (await check(completeOnly)).json(),{verified:false});
 assert.equal((await f.call('/devices/email/verified',{headers:{Cookie:completeOnly}})).status,403);
 const tampered=cookie.replace(/(__Host-PcrcEmailComplete=)[A-Za-z0-9_-]+/,'$1invalid');assert.deepEqual(await (await check(tampered)).json(),{verified:false});
 f.user.id=other;f.user.email='other@example.test';f.user.user_metadata.pcrc_username='other123';
 const otherLogin=await post(f,'/devices/email/sign-in',await form(f),{email:'other@example.test'});
 assert.deepEqual(await (await check(completeOnly+'; '+cookies(otherLogin))).json(),{verified:false});
 const foreign=await f.call('/devices/email/verification-status',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/x-www-form-urlencoded',Cookie:cookie},body:new URLSearchParams({flow:value.csrf})});assert.equal(foreign.status,403);
});

test('recovery requires its own flow, does not grant computer access, resets sessions and forces fresh sign-in',async()=>{
 const f=fixture(),logged=await login(f),oldCookie=cookies(logged);
 const value=await form(f,'/devices/email/forgot');assert.equal((await post(f,'/devices/email/forgot',value)).status,200);
 const recovered=await f.call('/devices/email/callback?code=synthetic',{headers:{Cookie:value.cookie}});assert.equal(recovered.status,303);assert.ok(!cookies(recovered).includes('__Host-JanPortal='));
 const reset=await f.call('/devices/email/reset',{headers:{Cookie:cookies(recovered)}}),html=await reset.text();assert.equal(reset.status,200);
 const resetForm={csrf:/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)[1],cookie:cookies(recovered)};
 assert.ok(!html.includes('synthetic-access-token'));
 assert.equal((await post(f,'/devices/email/reset',resetForm,{confirmation:'mismatch'})).status,400);
 const changed=await post(f,'/devices/email/reset',resetForm);assert.equal(changed.status,200);
 assert.ok((await post(f,'/devices/email/reset',resetForm)).status>=400);
 assert.equal(f.calls.filter(c=>c.url.endsWith('/user')&&c.init.method==='PUT').length,1);
 assert.match(await changed.text(),/Password updated/);
 assert.equal(await session(f.request('/devices',{headers:{Cookie:oldCookie}}),f.env),null);
 const current=await deviceStore(f.env,'/account/auth-version',{},'s-'+subject);assert.equal(current.authVersion,2);
 const mcp=()=>new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})});
 assert.equal((await proxyMcp(mcp(),f.env,{audience:origin+'/mcp',userId:'s-'+subject,scope:['pcrc:read']},{accountId:'s-'+subject,authVersion:0})).status,401);
 const fresh=await login(f);const owner=await session(f.request('/devices',{headers:{Cookie:cookies(fresh)}}),f.env);assert.equal(owner.authVersion,2);
});

test('a verified email links only with proof of the current GitHub PCRC account and keeps its account ID',async()=>{
 const f=fixture(),existing=await createPortalSession(f.env,{id:'9876',login:'existing-user'}),oldCookie=cookies(existing);
 assert.equal((await f.call('/devices/email/link')).status,403);
 const value=await form(f,'/devices/email/link',oldCookie);
 const linked=await post(f,'/devices/email/link',value,{action:'login'});assert.equal(linked.status,302);
 assert.equal((await session(f.request('/devices',{headers:{Cookie:cookies(linked)}}),f.env)).userId,'9876');
 const later=await login(f);assert.equal((await session(f.request('/devices',{headers:{Cookie:cookies(later)}}),f.env)).userId,'9876');
 const another=await createPortalSession(f.env,{id:'9877',login:'another-user'}),value2=await form(f,'/devices/email/link',cookies(another));
 const denied=await post(f,'/devices/email/link',value2,{action:'login'});assert.ok(denied.status>=400);
 assert.equal((await session(f.request('/devices',{headers:{Cookie:cookies(later)}}),f.env)).userId,'9876');
});

test('weak signup passwords are rejected and provider failures do not expose credentials',async()=>{
 const f=fixture(),value=await form(f,'/devices/email/signup');
 assert.equal((await post(f,'/devices/email/signup',value,{password:'short',confirmation:'short'})).status,400);assert.equal(f.calls.length,0);
 const failed=await portal(f.request('/devices/email/signup',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:value.cookie},body:new URLSearchParams({csrf:value.csrf,email:'synthetic@example.test',username:'synthetic12',password:secret,confirmation:secret})}),f.env,async()=>Response.json({error:secret},{status:429}));
 assert.equal(failed.status,429);assert.ok(!(await failed.text()).includes(secret));
});


test('username aliases are unique and cannot expose another account email or overwrite its ownership',async()=>{
 const f=fixture(),first=await login(f);assert.equal(first.status,302);
 const firstId=(await session(f.request('/devices',{headers:{Cookie:cookies(first)}}),f.env)).userId;
 f.user.id=other;f.user.email='another@example.test';
 const second=await login(f);assert.equal(second.status,302);
 const secondOwner=await session(f.request('/devices',{headers:{Cookie:cookies(second)}}),f.env);
 assert.notEqual(secondOwner.userId,firstId);
 const lookup=await deviceStore(f.env,'/email-identity/lookup',{username:'synthetic12'});
 assert.equal(lookup.email,'synthetic@example.test');
 assert.match(secondOwner.login,/^pcrc-/);
 const storageDump=JSON.stringify([...f.stores].map(([id,s])=>[id,[...s.entries]]));
 assert.ok(!storageDump.includes('synthetic@example.test'));assert.ok(!storageDump.includes('another@example.test'));
 const forbidden=await f.env.DEVICES.get('s-'+other).fetch('https://internal.invalid/email-identity/lookup',{method:'POST',headers:{'X-Jan-Account-Id':'s-'+other},body:JSON.stringify({username:'synthetic12'})});assert.equal(forbidden.status,403);
});

test('latest reset supersedes previous recovery and upstream failure consumes recovery without leaving old sessions active',async()=>{
 const f=fixture(),logged=await login(f),old=cookies(logged);
 const begin=async()=>{const formValue=await form(f,'/devices/email/forgot');await post(f,'/devices/email/forgot',formValue);const callback=await f.call('/devices/email/callback?code=synthetic',{headers:{Cookie:formValue.cookie}});const page=await f.call('/devices/email/reset',{headers:{Cookie:cookies(callback)}});return {csrf:/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await page.text())[1],cookie:cookies(callback)};};
 const a=await begin(),b=await begin();assert.ok((await post(f,'/devices/email/reset',a)).status>=400);
 const original=f.provider;const failing=async(url,init)=>url.endsWith('/user')&&init.method==='PUT'?Response.json({error:'Synthetic provider outage'},{status:503}):original(url,init);
 const request=()=>f.request('/devices/email/reset',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:b.cookie},body:new URLSearchParams({csrf:b.csrf,password:secret,confirmation:secret})});
 assert.ok((await portal(request(),f.env,failing)).status>=400);
 assert.equal(await session(f.request('/devices',{headers:{Cookie:old}}),f.env),null);
 assert.ok((await portal(request(),f.env,failing)).status>=400);
});


test('fresh direct GitHub authorization includes the reset version and consent return survives email or GitHub sign-in',async()=>{
 const f=fixture();await deviceStore(f.env,'/account/reset-sessions',{},'9876');
 let grant;
 f.env.OAUTH_PROVIDER={finishUpstream:async()=>({request:{resource:origin+'/mcp',scope:['pcrc:read'],codeChallenge:'C'.repeat(43),codeChallengeMethod:'S256',redirectUri:'https://chatgpt.com/connector_platform_oauth_redirect'},data:{verifier:'V'.repeat(43)},headers:new Headers()}),completeAuthorization:async value=>{grant=value;return {redirectTo:'https://chatgpt.com/connector_platform_oauth_redirect?code=synthetic'};}};
 const provider=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-github-token'}):Response.json({id:9876});
 assert.equal((await authorization(f.request('/callback?code=synthetic'),f.env,provider)).status,302);
 assert.equal(grant.props.authVersion,1);assert.equal(grant.props.githubId,'9876');
 const handle='H'.repeat(43),value=await form(f,'/devices/sign-in?consent='+handle);
 const href=/class="button neutral pcrc-login-button github-option" href="([^"]+)"/.exec(value.html)[1].replaceAll('&#38;','&');
 const github=await f.call(href);assert.equal(github.status,302);assert.equal(new URL(github.headers.get('Location')).hostname,'github.com');
 const signedIn=await login(f,value);assert.equal(signedIn.headers.get('Location'),origin+'/consent?handle='+handle);
});


test('unknown usernames and wrong passwords return the same generic error and recovery hides provider account errors',async()=>{
 const f=fixture();await login(f);
 const unknown=await post(f,'/devices/email/sign-in',await form(f),{email:'no-such-user'});assert.equal(unknown.status,400);
 const unknownPage=await unknown.text();assert.match(unknownPage,/Sign-in failed. Check your PCRC username or email and password/);
 const value=await form(f),wrong=await portal(f.request('/devices/email/sign-in',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:value.cookie},body:new URLSearchParams({csrf:value.csrf,email:'synthetic12',password:'wrong'})}),f.env,async()=>Response.json({error:'synthetic provider details'},{status:400}));
 const wrongPage=await wrong.text();assert.equal(wrong.status,400);assert.match(wrongPage,/Sign-in failed. Check your PCRC username or email and password/);
 assert.deepEqual(unknownPage.match(/aria-invalid="true"/g),wrongPage.match(/aria-invalid="true"/g));
 const reset=await form(f,'/devices/email/forgot');
 const denied=await portal(f.request('/devices/email/forgot',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:reset.cookie},body:new URLSearchParams({csrf:reset.csrf,email:'synthetic@example.test'})}),f.env,async()=>Response.json({error:'Email not authorized'},{status:400}));
 assert.equal(denied.status,200);assert.doesNotMatch(await denied.text(),/Email not authorized/);
});


test('password recovery blocks login during PUT and rejects a login authenticated against an older version',async()=>{
 const f=fixture();await login(f);
 const begin=async()=>{const value=await form(f,'/devices/email/forgot');await post(f,'/devices/email/forgot',value);const callback=await f.call('/devices/email/callback?code=synthetic',{headers:{Cookie:value.cookie}});const page=await f.call('/devices/email/reset',{headers:{Cookie:cookies(callback)}});return {cookie:cookies(callback),csrf:/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await page.text())[1]};};
 const reset=await begin();let resumeLogin,loginStarted;const waitingLogin=new Promise(resolve=>loginStarted=resolve),original=f.provider;
 const value=await form(f);
 const slowLogin=portal(f.request('/devices/email/sign-in',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:value.cookie},body:new URLSearchParams({csrf:value.csrf,email:'synthetic12',password:secret})}),f.env,async(url,init)=>{if(url.includes('grant_type=password')){loginStarted();await new Promise(resolve=>resumeLogin=resolve);}return original(url,init);});
 await waitingLogin;
 let resumeReset,resetStarted;const waitingReset=new Promise(resolve=>resetStarted=resolve);
 const changing=portal(f.request('/devices/email/reset',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:reset.cookie},body:new URLSearchParams({csrf:reset.csrf,password:secret,confirmation:secret})}),f.env,async(url,init)=>{if(url.endsWith('/user')&&init.method==='PUT'){resetStarted();await new Promise(resolve=>resumeReset=resolve);}return original(url,init);});
 await waitingReset;
 assert.ok((await login(f)).status>=400,'old password login while recovery is pending');
 resumeReset();assert.equal((await changing).status,200);
 resumeLogin();assert.ok((await slowLogin).status>=400,'credential check begun before reset must not create a fresh session afterward');
 assert.equal((await login(f)).status,302,'fresh authentication after reset still succeeds');
});

test('account closure removes email and username indexes and a subject tombstone prevents recreation',async()=>{
 for(const linked of [false,true]){
  const f=fixture();let identity;
  if(linked){const original=await createPortalSession(f.env,{id:'9876',login:'existing-user'});const value=await form(f,'/devices/email/link',cookies(original));identity=await post(f,'/devices/email/link',value,{action:'login'});}else identity=await login(f);
  const owner=await session(f.request('/devices',{headers:{Cookie:cookies(identity)}}),f.env);
  await deviceStore(f.env,'/directory/remove',{id:owner.userId});
  assert.deepEqual(await deviceStore(f.env,'/email-identity/lookup',{username:'synthetic12'}),{email:null});
  assert.deepEqual(await deviceStore(f.env,'/email-identity/lookup-email',{email:'synthetic@example.test'}),{id:null});
  const next=await login(f);assert.ok(next.status>=400);
  const registry=f.stores.get('1234').entries;
  assert.equal(registry.has('email-closed:v1:'+subject),true);
  assert.equal(registry.has('email-username:v1:'+subject),false);assert.equal(registry.has('email-identity:v1:'+subject),false);assert.equal(registry.has('email-link:v1:'+owner.userId),false);
 }
});
