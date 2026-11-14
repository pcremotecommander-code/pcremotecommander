import test from 'node:test';
import assert from 'node:assert/strict';
import {portal,session,deviceStore,digest} from '../src/device_portal.ts';
import {JanDeviceStore} from '../src/device_store.ts';
import {authorization} from '../src/authorization.ts';
import {openRecord,sealRecord} from '../src/secure_store.ts';

const origin='https://github-link.example.workers.dev',subject='12345678-1234-4123-8123-123456789abc',other='22345678-1234-4123-8123-123456789abc';
class Storage{entries=new Map();async get(k){return structuredClone(this.entries.get(k));}async put(k,v){this.entries.set(k,structuredClone(v));}async delete(k){if(Array.isArray(k)){for(const key of k)this.entries.delete(key);return k.length;}return this.entries.delete(k);}async transaction(fn){return fn(this);}async list({prefix='',limit=1000}={}){return new Map([...this.entries].filter(([key])=>key.startsWith(prefix)).slice(0,limit));}}
const cookies=r=>r.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
const csrf=html=>/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
function fixture(){
 const stores=new Map(),objects=new Map(),user={id:subject,email:'synthetic@example.test',email_confirmed_at:new Date().toISOString(),user_metadata:{pcrc_username:'synthetic12'}},github={id:4567,login:'synthetic-github'};
 const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_PAIRING_ENABLED:'1',JAN_MULTI_USER_ENABLED:'1',PCRC_EMAIL_AUTH_ENABLED:'1',SUPABASE_URL:'https://'+'a'.repeat(20)+'.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'K'.repeat(30)};
 env.DEVICES={idFromName:id=>id,get:id=>{if(!objects.has(id)){const storage=new Storage();stores.set(id,storage);objects.set(id,new JanDeviceStore({storage},env));}return {fetch:(url,init)=>objects.get(id).fetch(new Request(url,init))};}};
 const provider=async url=>url.startsWith(env.SUPABASE_URL)?Response.json(url.endsWith('/user')?user:{access_token:'synthetic-provider-token-not-real'}):Response.json(url.includes('github.com/login/oauth/access_token')?{access_token:'synthetic-github-token'}:github);
 const call=(path,init={})=>portal(new Request(origin+path,init),env,provider);
 const post=(path,body,cookie,headers={})=>call(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded',Cookie:cookie,...headers},body:new URLSearchParams(body)});
 async function login(){const page=await call('/devices/sign-in'),html=await page.text();return cookies(await post('/devices/email/sign-in',{csrf:csrf(html),email:user.email,password:'SyntheticPassword123!'},cookies(page)));}
 async function start(cookie){const settings=await call('/devices/settings',{headers:{Cookie:cookie}}),html=await settings.text();const token=csrf(html);const response=await post('/devices/github/link',{csrf:token},cookie);return {response,csrf:token};}
 async function review(cookie){const begun=await start(cookie);assert.equal(begun.response.status,200);const state=new URL(begun.response.headers.get('Refresh').replace(/^0; url=/,'')).searchParams.get('state');const response=await call('/callback?'+new URLSearchParams({state,code:'synthetic-code'}),{headers:{Cookie:cookie+'; '+cookies(begun.response)}});return {...begun,response,html:await response.text()};}
 return {env,stores,user,github,call,post,login,start,review};
}

test('email account optionally links a reviewed GitHub identity and later GitHub login keeps its canonical account',async()=>{
 const f=fixture(),cookie=await f.login(),account='s-'+subject;
 const settings=await f.call('/devices/settings',{headers:{Cookie:cookie}});assert.match(await settings.text(),/Connect GitHub/);
 const reviewed=await f.review(cookie);assert.equal(reviewed.response.status,200);assert.match(reviewed.html,/synthetic-github/);
 const token=/name="token" value="([A-Za-z0-9_-]+)"/.exec(reviewed.html)?.[1];assert.ok(token);
 const confirmed=await f.post('/devices/github/confirm',{csrf:reviewed.csrf,token},cookie);assert.equal(confirmed.status,303);
 assert.deepEqual(await deviceStore(f.env,'/github-identity/resolve',{githubId:'4567'}),{id:account});
 const signedOut=await f.call('/devices/login'),state=new URL(signedOut.headers.get('Location')).searchParams.get('state');
 const callback=await f.call('/callback?'+new URLSearchParams({state,code:'synthetic-code'}),{headers:{Cookie:cookies(signedOut)}});assert.equal(callback.status,302);
 const owner=await session(new Request(origin+'/devices',{headers:{Cookie:cookies(callback)}}),f.env);assert.equal(owner.userId,account);assert.equal(owner.login,'synthetic12');
 assert.equal(f.stores.get('1234').entries.has('directory:account:4567'),false);
 const replay=await f.post('/devices/github/confirm',{csrf:reviewed.csrf,token},cookie);assert.equal(replay.status,403);
});

test('an existing valid session with a legacy CSRF length can link GitHub without weakening form checks',async()=>{
 const f=fixture(),cookie=await f.login(),account='s-'+subject;
 const token=/__Host-JanPortal=([^;]+)/.exec(cookie)[1].split('.')[1],key='session:'+await digest(token),storage=f.stores.get(account),record=storage.entries.get(key);
 const details=await openRecord(f.env.JAN_PROXY_KEY,account,'portal-session',record);details.csrf='L'.repeat(32);
 await storage.put(key,await sealRecord(f.env.JAN_PROXY_KEY,account,'portal-session',details,record.expires));
 const reviewed=await f.review(cookie);assert.equal(reviewed.response.status,200);
 const reviewToken=/name="token" value="([A-Za-z0-9_-]+)"/.exec(reviewed.html)[1];
 assert.equal((await f.post('/devices/github/confirm',{csrf:'wrong',token:reviewToken},cookie)).status,403);
 assert.equal((await f.post('/devices/github/confirm',{csrf:reviewed.csrf,token:reviewToken},cookie)).status,303);
});

test('GitHub linking rejects cross-site initiation and binds callback to the initiating PCRC session',async()=>{
 const f=fixture(),cookie=await f.login(),settings=await f.call('/devices/settings',{headers:{Cookie:cookie}}),token=csrf(await settings.text());
 assert.equal((await f.post('/devices/github/link',{csrf:token},cookie,{Origin:'https://evil.example'})).status,403);
 assert.equal((await f.post('/devices/github/link',{csrf:'wrong'},cookie)).status,403);
 const begun=await f.start(cookie);assert.equal(begun.response.status,200);
 f.user.id=other;f.user.email='other@example.test';f.user.user_metadata.pcrc_username='other123';const otherCookie=await f.login();
 const state=new URL(begun.response.headers.get('Refresh').replace(/^0; url=/,'')).searchParams.get('state');
 const changed=await f.call('/callback?'+new URLSearchParams({state,code:'synthetic-code'}),{headers:{Cookie:otherCookie+'; '+cookies(begun.response)}});assert.equal(changed.status,403);
});

test('a GitHub identity already reserved by another PCRC account is never merged',async()=>{
 const f=fixture(),first=await f.call('/devices/login'),state=new URL(first.headers.get('Location')).searchParams.get('state');
 assert.equal((await f.call('/callback?'+new URLSearchParams({state,code:'synthetic-code'}),{headers:{Cookie:cookies(first)}})).status,302);
 const cookie=await f.login(),reviewed=await f.review(cookie),token=/name="token" value="([A-Za-z0-9_-]+)"/.exec(reviewed.html)?.[1];
 assert.ok(token);assert.equal((await f.post('/devices/github/confirm',{csrf:reviewed.csrf,token},cookie)).status,409);
 assert.deepEqual(await deviceStore(f.env,'/github-identity/resolve',{githubId:'4567'}),{id:'4567'});
});

test('resetting the PCRC password or expiring the review prevents linking',async()=>{
 const f=fixture(),cookie=await f.login(),reviewed=await f.review(cookie),token=/name="token" value="([A-Za-z0-9_-]+)"/.exec(reviewed.html)[1];
 await deviceStore(f.env,'/account/reset-sessions',{},'s-'+subject);
 assert.equal((await f.post('/devices/github/confirm',{csrf:reviewed.csrf,token},cookie)).status,403);
 const nextCookie=await f.login(),next=await f.review(nextCookie),nextToken=/name="token" value="([A-Za-z0-9_-]+)"/.exec(next.html)[1],now=Date.now;
 try{Date.now=()=>now()+301000;assert.equal((await f.post('/devices/github/confirm',{csrf:next.csrf,token:nextToken},nextCookie)).status,403);}finally{Date.now=now;}
 assert.deepEqual(await deviceStore(f.env,'/github-identity/resolve',{githubId:'4567'}),{id:'4567'});
});

test('legacy GitHub account state cannot be moved into an email account',async()=>{
 const f=fixture();await deviceStore(f.env,'/account/reset-sessions',{},'4567');
 const cookie=await f.login(),reviewed=await f.review(cookie),token=/name="token" value="([A-Za-z0-9_-]+)"/.exec(reviewed.html)[1];
 assert.equal((await f.post('/devices/github/confirm',{csrf:reviewed.csrf,token},cookie)).status,409);
 assert.equal(f.stores.get('4567').entries.get('account:auth-version:v1'),1);
});

test('linked GitHub assistant authorization uses the email canonical account and current session version',async()=>{
 const f=fixture(),cookie=await f.login(),reviewed=await f.review(cookie),token=/name="token" value="([A-Za-z0-9_-]+)"/.exec(reviewed.html)[1];
 assert.equal((await f.post('/devices/github/confirm',{csrf:reviewed.csrf,token},cookie)).status,303);
 await deviceStore(f.env,'/account/reset-sessions',{},'s-'+subject);let grant;
 f.env.OAUTH_PROVIDER={finishUpstream:async()=>({request:{resource:origin+'/mcp',scope:['pcrc:read'],codeChallenge:'C'.repeat(43),codeChallengeMethod:'S256',redirectUri:'https://chatgpt.com/connector_platform_oauth_redirect'},data:{verifier:'V'.repeat(43)},headers:new Headers()}),completeAuthorization:async value=>{grant=value;return {redirectTo:'https://chatgpt.com/connector_platform_oauth_redirect?code=synthetic'};}};
 const response=await authorization(new Request(origin+'/callback?code=synthetic'),f.env,async url=>Response.json(url.includes('access_token')?{access_token:'synthetic-github-token'}:f.github));
 assert.equal(response.status,302);assert.equal(grant.userId,'s-'+subject);assert.equal(grant.props.accountId,'s-'+subject);assert.equal(grant.props.authVersion,1);
});

test('account closure removes linked GitHub profile metadata and prevents identity reuse',async()=>{
 const f=fixture(),cookie=await f.login(),reviewed=await f.review(cookie),token=/name="token" value="([A-Za-z0-9_-]+)"/.exec(reviewed.html)[1];
 assert.equal((await f.post('/devices/github/confirm',{csrf:reviewed.csrf,token},cookie)).status,303);
 await deviceStore(f.env,'/directory/remove',{id:'s-'+subject});
 const registry=f.stores.get('1234').entries;
 assert.equal(registry.has('github-link:v1:s-'+subject),false);assert.equal(registry.has('github-identity:v1:4567'),false);assert.ok(registry.has('github-closed:v1:4567'));
 await assert.rejects(()=>deviceStore(f.env,'/github-identity/resolve',{githubId:'4567'}),error=>error.status===410);
});
