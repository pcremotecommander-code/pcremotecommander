import {prepareOwnerSession} from './helpers/owner-console-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {JanDeviceStore} from '../src/device_store.ts';
import {portal,digest} from '../src/device_portal.ts';
import {portalPage,deviceDashboard,connectPage,verificationPage,usagePage,subscriptionManager} from '../src/portal_ui.ts';
const base='https://ui.example.workers.dev';

test('matching-code confirmation uses a compact Verify popup without a redundant acknowledgment checkbox',async()=>{
  const owner={login:'sample-account',csrf:'C'.repeat(43)};
  const pair={id:'P'.repeat(43),name:'Sample computer',os:'Windows',agentVersion:'test',code:'123 456',status:'pending',proved:true,expires:Date.now()+300000,remainingSeconds:300,browserChoice:true,capabilities:['read','control','files','commands']};
  const standalone=await verificationPage(pair,owner,true).text();
  assert.doesNotMatch(standalone,/name="codes_match"/);
  assert.match(standalone,/Confirm &amp; connect/);assert.match(standalone,/Decline/);
  const popup=await connectPage(base,owner,undefined,'verify',true,'windows','chatgpt',pair).text();
  assert.match(popup,/data-stage="verify"/);assert.match(popup,/data-verification-form/);
  assert.ok(popup.indexOf('data-setup-progress="verify"')<popup.indexOf('data-setup-progress="assistant"'));
  assert.match(popup,/123 456/);assert.match(popup,/name="csrf"/);assert.match(popup,/name="capabilities" value="files"/);
  assert.doesNotMatch(popup,/name="codes_match"/);
  assert.doesNotMatch(popup,/Desktop access can capture/);
  const legacy=await connectPage(base,owner,undefined,'verify',true,'windows','chatgpt',{...pair,browserChoice:false,requireCode:true}).text();
  assert.match(legacy,/name="confirmation_code"/);assert.match(legacy,/with or without the space/);
});
test('public support page is available without sign-in and does not expose credentials',async()=>{
  const env={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public'};
  const response=await portal(new Request(base+'/support'),env);
  assert.equal(response.status,200);
  const html=await response.text();
  assert.match(html,/pcremotecommander@gmail\.com/);
  assert.match(html,/Do not email passwords/);
  assert.match(html,/class="pcrc-island"/);
  assert.match(html,/href="\/devices\/assistant"/);
  assert.equal((await portal(new Request(base+'/support?unexpected=1'),env)).status,404);
  assert.equal((await portal(new Request(base+'/support'),{...env,JAN_SITE_ROLE:'owner'})).status,404);
});
class Storage {
  entries=new Map();
  async get(k){return structuredClone(this.entries.get(k));}
  async put(k,v){this.entries.set(k,structuredClone(v));}
  async delete(k){return this.entries.delete(k);}
  async list({prefix='',limit=1000}={}){return new Map([...this.entries].filter(([key])=>key.startsWith(prefix)).slice(0,limit));}
  async transaction(fn){return fn(this);}
}
test('shared dashboard links discard tracking parameters and show sign-in without revealing account data',async()=>{
  const f=await fixture();
  const env={...f.env,JAN_SITE_ROLE:'public'};
  for(const path of ['/devices?fbclid=synthetic','/devices/?utm_source=instagram','/devices?code=private-marker&state=private-marker']) {
    const response=await portal(new Request(base+path),env);
    assert.equal(response.status,302);
    assert.equal(response.headers.get('Location'),base+'/devices');
    assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');
  }
  const page=await portal(new Request(base+'/devices'),env);
  assert.equal(page.status,200);
  const html=await page.text();
  assert.match(html,/Continue with GitHub/);
  assert.ok(!html.includes('Test Windows PC'));
  assert.doesNotMatch(html,/pcrc-island|site-shell\.(?:css|js)/);
  assert.equal((await portal(new Request(base+'/devices/state'),env)).status,401);
});
test('dashboard routes render account navigation without the public website menu',async()=>{
  const f=await fixture();
  f.env.JAN_SITE_ROLE='public';
  for(const path of ['/devices','/devices/connect','/devices/assistant','/devices/usage','/devices/plan','/devices/settings','/devices/approvals']) {
    const response=await f.call(path);
    assert.equal(response.status,200,path);
    const html=await response.text();
    assert.match(html,/aria-label="Main navigation"/,path);
    assert.doesNotMatch(html,/pcrc-island|site-shell\.(?:css|js)|aria-label="Site navigation"/,path);
  }
});
async function fixture() {
  const storage=new Storage();
  const env={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_PAIRING_ENABLED:'1'};
  const object=new JanDeviceStore({storage},env);
  env.DEVICES={idFromName:id=>id,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})};
  const token='T'.repeat(43),csrf='C'.repeat(43),id=crypto.randomUUID();
  await storage.put('session:'+await digest(token),{login:'test-owner',userId:'1234',csrf,expires:Date.now()+60000});
  await storage.put('devices',{[id]:{id,name:'Test Windows PC',publicKey:'test-marker',os:'Windows',agentVersion:'0.7.0',capabilities:['read'],created:Date.now(),lastSeen:0,revoked:false}});
  const call=(url,init={})=>portal(new Request(base+url,{...init,headers:{Cookie:'__Host-JanPortal='+token,...init.headers}}),env);
  const post=(url,fields={},headers={})=>call(url,{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({csrf,...fields})});
  return {storage,env,object,token,csrf,id,call,post};
}
test('sandbox payment links keep their transaction through sign-in and load Paddle on the plan page',async()=>{
  const f=await fixture();
  Object.assign(f.env,{JAN_SITE_ROLE:'public',PADDLE_CLIENT_TOKEN:'test_'+'a'.repeat(27),PADDLE_WEBHOOK_SECRET:'sandbox-secret',PADDLE_PRICE_ID:'pri_01m5z5ay4y4kv7dkrcmz7r3s7h'});
  const transaction='txn_'+'a'.repeat(26),path='/devices/plan?_ptxn='+transaction;
  const unauthenticated=await portal(new Request(base+path),f.env);
  assert.equal(unauthenticated.status,302);
  assert.equal(unauthenticated.headers.get('Location'),base+'/devices/login?checkout='+transaction);
  const login=await portal(new Request(unauthenticated.headers.get('Location')),f.env);
  const state=new URL(login.headers.get('Location')).searchParams.get('state');
  const provider=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-token'}):Response.json({id:1234,login:'test-owner'});
  const callback=await portal(new Request(base+'/callback?'+new URLSearchParams({state,code:'synthetic'}),{headers:{Cookie:login.headers.get('Set-Cookie').split(';')[0]}}),f.env,provider);
  assert.equal(callback.headers.get('Location'),base+path);
  const plan=await f.call(path);
  assert.equal(plan.status,200);
  assert.match(await plan.text(),/Paddle\.Initialize/);
  assert.equal((await f.call('/devices/plan?_ptxn=invalid')).status,404);
});
test('dashboard presents measured device state, permissions, selected feedback and a protected JSON snapshot',async()=>{
  const f=await fixture();
  const page=await f.call('/devices');assert.equal(page.status,200);
  assert.match(page.headers.get('Content-Security-Policy'),/script-src 'nonce-/);
  const html=await page.text();assert.match(html,/Read only/);assert.match(html,/Use this computer/);assert.match(html,/Device details &amp; access|Device details & access/);
  assert.doesNotMatch(html,/The pairing code appears in PowerShell/);
  assert.doesNotMatch(html,/No computer selected\. Add or choose/);
  assert.match(html,/class="dashboard-layout"/);
  assert.match(html,/class="panel usage-side"/);
  assert.match(html,/data-month-used>0<\/span> \/ 15,000 used/);
  assert.match(html,/data-month-remaining>15,000<\/strong>/);
  assert.ok(!html.includes('test-marker'));
  const selected=await f.post('/devices/select',{id:f.id});assert.equal(selected.status,303);assert.equal(new URL(selected.headers.get('Location')).searchParams.get('notice'),'selected');
  const result=await (await f.call('/devices?notice=selected')).text();assert.match(result,/Computer selected/);assert.match(result,/Selected for AI tools/);
  const snapshot=await (await f.call('/devices/state')).json();assert.equal(snapshot.active,f.id);assert.equal(snapshot.devices[0].online,false);assert.equal(snapshot.devices[0].publicKey,undefined);
  assert.match(result,/Stop AI access/);
  assert.equal((await f.post('/devices/unselect',{id:crypto.randomUUID()})).status,409);
  assert.equal((await f.post('/devices/unselect',{id:f.id})).status,303);
  assert.equal((await f.storage.get('active')),undefined);
  assert.equal((await f.storage.get('devices'))[f.id].revoked,false);
  assert.match(await (await f.call('/devices?notice=disconnected')).text(),/AI access stopped/);
  assert.equal((await portal(new Request(base+'/devices/state'),f.env)).status,401);
});
test('revocation requires review and explicit confirmation; cancel never mutates',async()=>{
  const f=await fixture();
  const review=await f.call('/devices/revoke?id='+f.id);assert.equal(review.status,200);assert.match(await review.text(),/Revoke Test Windows PC/);
  assert.equal((await f.storage.get('devices'))[f.id].revoked,false);
  const oldForm=await f.post('/devices/revoke',{id:f.id});assert.equal(oldForm.status,200);assert.equal((await f.storage.get('devices'))[f.id].revoked,false);
  assert.equal((await f.post('/devices/revoke',{id:f.id,confirmation:'revoke'})).status,303);
  assert.equal((await f.storage.get('devices'))[f.id].revoked,true);
});
test('rename validates and preserves values; revoke all and sign-out require CSRF',async()=>{
  const f=await fixture();
  const invalid=await f.post('/devices/rename',{id:f.id,name:'<bad>'});assert.equal(invalid.status,400);const text=await invalid.text();assert.match(text,/aria-invalid="true"/);assert.ok(!text.includes('value="<bad>"'));
  assert.equal((await f.post('/devices/rename',{id:f.id,name:'Office PC'})).status,303);assert.equal((await f.storage.get('devices'))[f.id].name,'Office PC');
  assert.equal((await f.post('/devices/revoke-all',{confirmation:'revoke',csrf:'wrong'})).status,403);
  assert.equal((await f.post('/devices/revoke-all')).status,200);assert.equal((await f.storage.get('devices'))[f.id].revoked,false);
  assert.equal((await f.post('/devices/revoke-all',{confirmation:'revoke'})).status,303);assert.equal((await f.storage.get('devices'))[f.id].revoked,true);
  assert.equal((await f.post('/devices/logout',{csrf:'wrong'})).status,403);
  assert.equal((await f.post('/devices/logout')).status,303);assert.equal((await f.call('/devices/state')).status,401);
});
test('first-time sign-in opens setup; setup stages and billing page make only implemented promises',async()=>{
  const f=await fixture();await f.storage.put('devices',{});
  const login=await portal(new Request(base+'/devices/login'),f.env),state=new URL(login.headers.get('Location')).searchParams.get('state');
  const provider=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-token'}):Response.json({id:1234,login:'test-owner'});
  const callback=await portal(new Request(base+'/callback?'+new URLSearchParams({state,code:'synthetic'}),{headers:{Cookie:login.headers.get('Set-Cookie').split(';')[0]}}),f.env,provider);
  assert.equal(callback.status,302);assert.equal(callback.headers.get('Location'),base+'/devices/connect');
  for(const step of ['copy','run','verify']) {const page=await f.call('/devices/connect?step='+step);assert.equal(page.status,200);const html=await page.text();assert.match(html,/aria-current="step"/);assert.match(html,/Setup-Windows\.cmd/);assert.doesNotMatch(html,/npm\.cmd --prefix/);if(step==='run'||step==='verify') assert.match(html,/PowerShell window/);if(step==='copy'){assert.match(html,/Read-Host/);assert.match(html,/Join-Path/);assert.doesNotMatch(html,/id="connect-command">\.\\PC-Remote-Commander\.cmd/);}}
  const billing=await (await f.call('/devices/plan')).text();assert.match(billing,/Free plan/);assert.ok(!billing.includes('id="pro-checkout"'));
  Object.assign(f.env,{PADDLE_CLIENT_TOKEN:'test_'+'a'.repeat(27),PADDLE_WEBHOOK_SECRET:'synthetic-secret',PADDLE_PRICE_ID:'pri_01m5z5ay4y4kv7dkrcmz7r3s7h',JAN_SITE_ROLE:'public'});
  const checkout=await f.call('/devices/plan');assert.equal(checkout.status,200);const checkoutHtml=await checkout.text();assert.match(checkoutHtml,/id="pro-checkout"/);assert.match(checkoutHtml,/checkout\.completed/);assert.match(checkoutHtml,/\/devices\/state/);assert.match(checkout.headers.get('Content-Security-Policy'),/cdn\.paddle\.com/);
  const scripts=[...checkoutHtml.matchAll(/<script(?: data-pcrc-checkout)? nonce="[^"]+">([\s\S]*?)<\/script>/g)].map(match=>match[1]);
  for(const javascript of scripts)new Function(javascript);
  let onCheckout,redirect,status,reads=0;
  const button={addEventListener(){},parentElement:{firstElementChild:{append(element){status=element;}}}};
  const document={getElementById:id=>id==='pro-checkout'?button:null,createElement:()=>({setAttribute(){},className:'',textContent:''})};
  const Paddle={Environment:{set(){}},Initialize(options){onCheckout=options.eventCallback;},Checkout:{open(){}}};
  new Function('Paddle','document','fetch','location','setTimeout',scripts.at(-1))(Paddle,document,async()=>({ok:true,json:async()=>({plan:++reads===1?'free':'pro'})}),{assign:path=>{redirect=path;}},resolve=>resolve());
  await onCheckout({name:'checkout.completed'});
  assert.equal(reads,2);assert.equal(redirect,'/devices?notice=pro');assert.match(status.textContent,/Waiting for Pro activation/);
  assert.doesNotMatch(await (await f.call('/devices?notice=pro')).text(),/Welcome to Pro!/);
  await f.storage.put('billing:subscriptions:v1',{['sub_'+'a'.repeat(26)]:{status:'active',priceId:f.env.PADDLE_PRICE_ID}});
  const welcome=await (await f.call('/devices?notice=pro')).text();
  assert.match(welcome,/id="pro-welcome" class="welcome-dialog"/);
  assert.match(welcome,/Enjoy unlimited monthly tool calls and connect as many devices/);
  const publicPage=await (await portal(new Request(base+'/devices'),f.env)).text();assert.match(publicPage,/Continue with GitHub/);assert.match(publicPage,/class="app auth landing"/);
});
test('public setup keeps commands first, then assistant setup, verification and dashboard with troubleshooting collapsed',async()=>{
  const f=await fixture();f.env.JAN_SITE_ROLE='public';f.env.JAN_MULTI_USER_ENABLED='1';
  const signIn=await (await portal(new Request(base+'/devices'),f.env)).text();
  assert.match(signIn,/Continue with GitHub/);
  assert.match(signIn,/class="app auth landing"/);
  assert.match(signIn,/src="\/brand\/pcrc-logo\.svg"/);
  assert.match(signIn,/Use your own GitHub account/);
  assert.doesNotMatch(signIn,/Google and email sign-in are being prepared/);
  const dashboard=await (await f.call('/devices')).text();
  const billing=await (await f.call('/devices/plan')).text();
  assert.doesNotMatch(billing,/Public release/);assert.match(billing,/View billing history/);
  assert.match(billing,/15,000 MCP tool calls per UTC month/);
  assert.match(billing,/Free plan/);
  assert.doesNotMatch(dashboard,/href="\/admin">Operations/);
  const revoked=await (await f.call('/devices?notice=revoked')).text();
  assert.match(revoked,/Fresh browser approval starts automatically/);
  assert.doesNotMatch(revoked,/PC-Remote-Commander\.cmd --enroll/);
  const response=await f.call('/devices/connect?step=copy');
  assert.equal(response.status,200);
  const page=await response.text();
  assert.match(page,/npx --yes pcremotecommander@beta setup/);
  assert.ok(page.indexOf('id="bootstrap-command"')<page.indexOf('id="connect-command"'));
  assert.match(page,/<dialog open data-setup-dialog/);
  assert.match(page,/powershell -NoProfile -Command/);
  assert.match(page,/\/install\.ps1/);
  assert.doesNotMatch(page,/--package=|\/downloads\/windows\/|--gateway/);
  assert.equal((page.match(/id="connect-command"/g)??[]).length,1);
  assert.doesNotMatch(page,/id="control-command"/);
  assert.doesNotMatch(page,/id="recover-command"/);
  assert.doesNotMatch(page,/Run it|Show run instructions|Staging beta:|Google sign-in/);
  assert.match(page,/Next: Connect AI/);
  assert.match(page,/aria-label="Computer operating system"/);
  assert.match(page,/Download Start-PCRC\.cmd/);
  assert.doesNotMatch(page,/PC-Remote-Commander-Windows\.zip|Extract All/);
  assert.match(page,/Start-PCRC\.cmd/);
  for(const os of ['linux','macos']) {
    const other=await (await f.call('/devices/connect?step=copy&os='+os)).text();
    assert.match(other,/Quick setup/);
    assert.ok(other.includes('install-posix-beta45.sh | bash'));
    assert.ok(other.includes('data-copy-target="'+os+'-doctor-command"'));
    assert.match(other,/<div id="setup-windows" hidden>/);
    assert.ok(other.includes('<div id="setup-'+os+'"><h2 class="setup-platform-title">'));
  }
  assert.equal((await f.call('/devices/connect?step=copy&os=invalid')).status,404);
  const assistant=await (await f.call('/devices/connect?step=assistant')).text();
  assert.match(assistant,/id="assistant-endpoint-chatgpt"/);
  assert.match(assistant,/Add custom MCP server/);
  assert.match(assistant,/Choose AI assistant/);
  assert.match(assistant,/Connect your assistant once/);
  assert.match(assistant,/temporary network interruptions reconnect automatically/);
  assert.match(assistant,/data-assistant-panel="claude" hidden/);
  assert.match(assistant,/data-assistant-panel="cursor" hidden/);
  assert.match(assistant,/Back to Verify/);
  assert.match(assistant,/https:\/\/ui\.example\.workers\.dev\/mcp/);
  assert.match(assistant,/data-copy-target="assistant-endpoint-chatgpt"/);
  assert.match(assistant,/data-copy-target="assistant-install-prompt-chatgpt"/);
  assert.match(assistant,/\/mcp\/media\/chatgpt\.mp4/);
  const claude=await f.call('/devices/connect?step=assistant&client=claude');
  assert.match(claude.headers.get('Content-Security-Policy'),/media-src 'self'/);
  const claudeHtml=await claude.text();
  assert.match(claudeHtml,/data-copy-target="assistant-install-prompt-claude"/);
  assert.match(claudeHtml,/\/mcp\/media\/claude-recorded\.mp4/);
  assert.ok(page.indexOf('Choose method')<page.indexOf('Connect AI'));
  assert.ok(page.indexOf('Start on device')<page.indexOf('>Verify<'));
  assert.ok(page.indexOf('>Verify<')<page.indexOf('Connect AI'));
  assert.match(page,/<details class="help"><summary>Need help/);
  const verify=await (await f.call('/devices/connect?step=verify')).text();
  assert.match(verify,/both codes match/);
  assert.match(verify,/Confirm &amp; connect/);
  assert.match(verify,/data-setup-stage="assistant" href="\/devices\/connect\?step=assistant">Next: Connect AI/);
  assert.doesNotMatch(verify,/Run it|Show run instructions/);
  const legacy=await (await f.call('/devices/connect?step=run')).text();
  assert.match(legacy,/id="connect-command"/);
  assert.doesNotMatch(legacy,/Run it|Show run instructions/);
  assert.match(page,/opens fresh approval automatically/);
  assert.doesNotMatch(page,/Paste the full path to your PC Remote Commander folder/);
  assert.doesNotMatch(page,/Get the source preview package from its owner/);
});
test('owner subscription page searches an account and only a confirmed CSRF form cancels it',async()=>{
  const f=await fixture(),subscription='sub_'+'a'.repeat(26),price='pri_01m5z5ay4y4kv7dkrcmz7r3s7h',calls=[];
  Object.assign(f.env,{JAN_SITE_ROLE:'owner',JAN_MULTI_USER_ENABLED:'1',PADDLE_PRICE_ID:price,PADDLE_SANDBOX_API_KEY:'synthetic-sandbox-key'});
  await prepareOwnerSession(f.storage,f.env,f.token,f.csrf);
  await f.storage.put('directory:account:1234','test-owner');
  await f.storage.put('directory:login:test-owner','1234');
  await f.storage.put('billing:subscriptions:v1',{[subscription]:{id:subscription,eventId:'evt_'+'a'.repeat(26),occurredAt:1,status:'active',priceId:price}});
  const api=async (url,init)=>{
    calls.push({url,method:init.method,body:init.body});
    if(url.endsWith('/cancel'))return Response.json({data:{id:subscription,status:'active',scheduled_change:{action:'cancel',effective_at:'2026-11-27T00:00:00Z'}}});
    if(url.endsWith('/subscriptions/'+subscription))return Response.json({data:{id:subscription,status:'active',custom_data:{account_id:'1234'}}});
    if(url.includes('/transactions?'))return Response.json({data:[]});
    return Response.json({}, {status:404});
  };
  assert.equal((await portal(new Request(base+'/admin/subscriptions?q=test-owner'),f.env,api)).status,403);
  const page=await portal(new Request(base+'/admin/subscriptions?q=test-owner',{headers:{Cookie:'__Host-JanPortal='+f.token}}),f.env,api);
  assert.equal(page.status,200);
  const ownerHtml=await page.text();assert.match(ownerHtml,/Search by GitHub account ID or username/);assert.match(ownerHtml,/href="\/admin\/subscriptions" aria-current="page"/);
  assert.equal((await f.post('/admin/subscriptions',{account:'1234',id:subscription,action:'cancel',confirm:'yes',csrf:'wrong'})).status,403);
  assert.equal((await f.post('/admin/subscriptions',{account:'1234',id:subscription,action:'cancel'})).status,403);
  assert.equal((await f.post('/admin/subscriptions',{account:'9999',id:subscription,action:'cancel',confirm:'yes'})).status,404);
  const wrongBinding=await portal(new Request(base+'/admin/subscriptions',{method:'POST',headers:{Cookie:'__Host-JanPortal='+f.token,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf,account:'1234',id:subscription,action:'cancel',confirm:'yes'})}),f.env,async()=>Response.json({data:{id:subscription,status:'active',custom_data:{account_id:'9999'}}}));
  assert.equal(wrongBinding.status,403);
  const valid=await portal(new Request(base+'/admin/subscriptions',{method:'POST',headers:{Cookie:'__Host-JanPortal='+f.token,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf,account:'1234',id:subscription,action:'cancel',confirm:'yes'})}),f.env,api);
  assert.equal(valid.status,303);
  assert.equal(calls.filter(call=>call.url.endsWith('/cancel')).length,1);
  const data=await (await f.call('/devices/state')).json();
  assert.equal(data.billing[0].cancelAt,'2026-11-27T00:00:00Z');
  assert.match(await (await f.call('/devices')).text(),/Your Pro subscription will end on/);
});
test('owner username search resolves a registered older account without exposing an unregistered GitHub user',async()=>{
  const f=await fixture();
  Object.assign(f.env,{JAN_SITE_ROLE:'owner',JAN_MULTI_USER_ENABLED:'1'});
  await prepareOwnerSession(f.storage,f.env,f.token,f.csrf);
  await f.storage.put('directory:account:1234',true);
  const request=()=>new Request(base+'/admin/subscriptions?q=OldUser',{headers:{Cookie:'__Host-JanPortal='+f.token}});
  const found=await portal(request(),f.env,async (url,init)=>{
    assert.equal(url,'https://api.github.com/users/OldUser');
    assert.equal(init.headers.Authorization,'Basic '+btoa('syntheticClient:synthetic-client-secret'));
    return Response.json({id:1234,login:'OldUser'});
  });
  assert.match(await found.text(),/Account 1234 · OldUser/);
  assert.equal(await f.storage.get('directory:login:olduser'),'1234');
  await f.storage.delete('directory:login:olduser');
  const missing=await portal(request(),f.env,async()=>Response.json({id:5678,login:'OldUser'}));
  assert.match(await missing.text(),/No account found/);
});
test('assistant setup gives a real MCP endpoint and current connection steps only after sign-in',async()=>{
  const f=await fixture();f.env.JAN_SITE_ROLE='public';
  const dashboard=await (await f.call('/devices')).text();
  assert.match(dashboard,/href="\/devices\/assistant">Setup guide/);
  const page=await f.call('/devices/assistant');assert.equal(page.status,200);
  const guide=await page.text();
  assert.match(guide,/Add custom MCP server/);
  assert.match(guide,/OAuth authentication/);
  assert.match(guide,/pcrc:control/);
  assert.match(guide,/No computer selected/);
  assert.match(dashboard,/href="\/devices\/assistant\?client=claude"/);
  assert.match(dashboard,/href="\/devices\/assistant\?client=cursor"/);
  const claude=await (await f.call('/devices/assistant?client=claude')).text();
  const cursor=await (await f.call('/devices/assistant?client=cursor')).text();
  assert.match(claude,/Add custom connector/);
  assert.match(claude,/Sign in now/);
  assert.doesNotMatch(claude,/Add custom MCP server/);
  assert.match(cursor,/~\/\.cursor\/mcp\.json/);
  assert.match(cursor,/mcpServers/);
  assert.match(cursor,/Official Cursor guide/);
  assert.doesNotMatch(cursor,/chatgpt\.com|Add custom connector/);
  assert.doesNotMatch(guide,/id="claude"|id="cursor"/);
  assert.doesNotMatch(claude,/id="chatgpt"|id="cursor"/);
  assert.doesNotMatch(cursor,/id="chatgpt"|id="claude"/);
  for(const client of ['chatgpt','claude','cursor']) {
    const wizard=await f.call('/devices/connect?step=assistant&client='+client);
    assert.equal(wizard.status,200);
    const html=await wizard.text();
    assert.match(html,new RegExp('id="'+client+'"'));
    assert.match(html,new RegExp('data-assistant-panel="'+client+'">'));
    for(const other of ['chatgpt','claude','cursor'].filter(x=>x!==client))assert.match(html,new RegExp('data-assistant-panel="'+other+'" hidden'));
  }
  assert.equal((await f.call('/devices/assistant?client=unknown')).status,404);
  assert.equal((await f.call('/devices/connect?step=assistant&client=unknown')).status,404);

  assert.match(guide,/https:\/\/ui\.example\.workers\.dev\/mcp/);
  const signedOut=await portal(new Request(base+'/devices/assistant'),f.env);
  assert.equal(signedOut.status,303);
  assert.equal(new URL(signedOut.headers.get('Location')).searchParams.get('return'),'/devices/assistant');
});
test('usage stores actual bounded daily counters and labels missing historical data honestly',async()=>{
  const f=await fixture();
  const internal=()=>f.object.fetch(new Request('https://internal.invalid/usage/increment',{method:'POST',body:'{}'}));
  await internal();await internal();
  const state=await (await f.call('/devices/state')).json();assert.equal(state.calls,2);assert.equal(Object.values(state.usage.days).reduce((a,b)=>a+b,0),2);
  const page=await (await f.call('/devices/usage')).text();assert.match(page,/Tool calls this month/);assert.match(page,/UTC/);assert.match(page,/not recorded/);assert.match(page,/data-call-count>2</);
  for(const range of ['today','week','last-week','months']){
    const response=await f.call('/devices/usage?range='+range);assert.equal(response.status,200);
    const html=await response.text();assert.match(html,new RegExp('href="/devices/usage\\?range='+range+'" aria-current="page"'));
    assert.match(html,/class="chart-scroll"/);
  }
  assert.equal((await f.call('/devices/usage?range=invalid')).status,404);
});
test('activity records bounded tool metadata without arguments or tool output',async()=>{
  const f=await fixture();
  await f.post('/devices/select',{id:f.id});
  f.object.relay.getSession=()=>({online:true,forward:async message=>({type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{content:[{type:'text',text:'private output'}]}})})});
  for(let i=0;i<52;i++) {
    const response=await f.object.fetch(new Request('https://internal.invalid/relay/dispatch',{method:'POST',body:JSON.stringify({type:'request',request_id:crypto.randomUUID(),control:false,payload:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'jan_read_file',arguments:{path:'private-name.txt'}}})})}));
    assert.equal(response.status,200);
  }
  const state=await (await f.call('/devices/state')).json();
  assert.equal((await f.storage.get('activity:recent:v1')).length,50);
  assert.equal(state.activity.length,20);
  assert.equal(state.devices[0].calls,52);
  assert.equal(state.activity[0].tool,'jan_read_file');
  assert.equal(state.activity[0].outcome,'completed');
  assert.ok(!JSON.stringify(state).includes('private-name.txt'));
  assert.ok(!JSON.stringify(state).includes('private output'));
  const html=await (await f.call('/devices')).text();
  assert.match(html,/Recent activity/);
  assert.match(html,/Selected tool requests: 52/);
  assert.equal((html.match(/jan_read_file/g)??[]).length,10);
  await f.post('/devices/revoke',{id:f.id,confirmation:'revoke'});
  assert.match(await (await f.call('/devices')).text(),/jan_read_file<\/strong><p>Test Windows PC/);
});
test('activity counts task-oriented control tools without retaining arguments',async()=>{
  const f=await fixture();
  const devices=await f.storage.get('devices');devices[f.id].capabilities=['read','control','commands'];await f.storage.put('devices',devices);
  await f.post('/devices/select',{id:f.id});
  f.object.relay.getSession=()=>({online:true,forward:async message=>({type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:1,result:{structuredContent:{ok:true}}})})});
  const command=()=>f.object.fetch(new Request('https://internal.invalid/relay/dispatch',{method:'POST',body:JSON.stringify({type:'request',request_id:crypto.randomUUID(),control:true,payload:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'run_command',arguments:{command:'private-command'}}})})}));
  const pending=JSON.parse((await (await command()).json()).payload).result.content[0].text;
  const id=/\/devices\/actions\?id=([a-f0-9-]{36})/.exec(pending)?.[1];
  assert.ok(id);
  assert.equal((await f.post('/devices/actions',{id,decision:'approve'})).status,303);
  const receipt=await f.object.fetch(new Request('https://internal.invalid/actions/result',{method:'POST',body:JSON.stringify({id})}));assert.equal(receipt.status,200);assert.equal((await receipt.json()).status,'completed');
  const state=await (await f.call('/devices/state')).json();
  assert.equal(state.activity[0].tool,'run_command');
  assert.equal(state.devices[0].calls,1);
  assert.ok(!JSON.stringify(state).includes('private-command'));
});


test('live financial confirmations say real payments and portal disables unnecessary browser sensors',async()=>{
  const owner={login:'operator',csrf:'synthetic-csrf'};
  const account={id:'1234',login:'member',subscriptions:[{id:'sub_'+'a'.repeat(26),status:'active',priceId:'pri_'+'b'.repeat(26),cancelAt:null,verified:true,refundTransaction:'txn_'+'c'.repeat(26)}]};
  const live=subscriptionManager(owner,'1234',account,true,null,true);
  assert.equal(live.headers.get('Permissions-Policy'),'camera=(), microphone=(), geolocation=()');
  const html=await live.text();
  assert.match(html,/LIVE Paddle account \(real payments\)/);
  assert.doesNotMatch(html,/Paddle sandbox/);
  assert.match(await subscriptionManager(owner,'1234',account,true,null,false).text(),/Paddle sandbox \(test payments\)/);
});


test('authenticated portal shows escaped account identity outside the hidden sidebar',async()=>{
 const html=await portalPage('<h1>Test page</h1>','Test',{owner:{login:'<test-user>',userId:'1234',csrf:'private-csrf'}}).text();
 assert.match(html,/<header class="account-hero" data-account-identity><p class="account-welcome">Welcome, <strong>&#60;test-user&#62;<\/strong><\/p><p class="account-id">Account ID: <code>1234<\/code><\/p><\/header>/);
 assert.ok(html.indexOf('<header class="account-hero" data-account-identity>')>html.indexOf('<main'));
 assert.doesNotMatch(html,/<strong><test-user>/);
 for(const owner of [{login:'github-member',userId:'1234567890',csrf:'test'},{login:'emailmember',userId:'s-00000000-0000-4000-8000-000000000001',csrf:'test'}]){
  const page=await portalPage('<h1>Devices</h1>','Devices',{owner}).text();
  assert.ok(page.includes('Welcome, <strong>'+owner.login+'</strong></p><p class="account-id">Account ID: <code>'+owner.userId+'</code>'));
 }
 const escapedId=await portalPage('<h1>Devices</h1>','Devices',{owner:{login:'member',userId:'<synthetic-id>',csrf:'test'}}).text();
 assert.match(escapedId,/<code>&#60;synthetic-id&#62;<\/code>/);
 const anonymous=await portalPage('<h1>Public page</h1>').text();
 assert.doesNotMatch(anonymous,/<header class="account-hero" data-account-identity>/);
 const operator=await portalPage('<h1>Operations</h1>','Operations',{ownerSite:true,owner:{login:'operator',userId:'1234',csrf:'test'}}).text();
 assert.doesNotMatch(operator,/<header class="account-hero" data-account-identity>/);
 assert.doesNotMatch(operator,/html\[data-pcrc-ui\] \.content:has\(>\[data-account-identity\]\)/);
});


test('signed-out dashboard pages redirect to sign-in and preserve only known return routes',async()=>{
  const {env}=await fixture();env.JAN_SITE_ROLE='public';
  for(const path of ['/devices/connect?step=assistant&os=windows&client=claude','/devices/assistant?client=cursor','/devices/settings','/devices/plan','/devices/usage?range=week','/devices/account','/devices/billing/history']) {
    const response=await portal(new Request(base+path),env);
    assert.equal(response.status,303,path);
    const login=new URL(response.headers.get('Location'));
    assert.equal(login.pathname,'/devices/sign-in');
    assert.equal(login.searchParams.get('return'),path);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
    const page=await portal(new Request(login),env);
    assert.equal(page.status,200);
    assert.match(await page.text(),/Continue with GitHub/);
    const start=await portal(new Request(base+'/devices/login?'+new URLSearchParams({return:path})),env);
    assert.equal(start.status,302);
    const state=new URL(start.headers.get('Location')).searchParams.get('state');
    const provider=async url=>url.includes('access_token')?Response.json({access_token:'synthetic-token'}):Response.json({id:1234,login:'test-owner'});
    const callback=await portal(new Request(base+'/callback?'+new URLSearchParams({state,code:'synthetic'}),{headers:{Cookie:start.headers.get('Set-Cookie').split(';')[0]}}),env,provider);
    assert.equal(callback.headers.get('Location'),base+path);
  }
  for(const path of ['https://evil.example/','//evil.example','/devices/state','/devices/select','/devices/plan?token=secret','/devices/account/delete','/devices/settings#secret']) {
    const response=await portal(new Request(base+'/devices/login?'+new URLSearchParams({return:path})),env);
    assert.equal(response.status,400,path);
    assert.equal(response.headers.get('Set-Cookie'),null);
  }
  assert.equal((await portal(new Request(base+'/devices/state'),env)).status,401);
  const mutation=await portal(new Request(base+'/devices/select',{method:'POST'}),env);
  assert.equal(mutation.headers.get('Location'),null);
});


test('public sign-in restores desktop promotion beside the new login panel',async()=>{
  const {env}=await fixture();env.JAN_SITE_ROLE='public';
  const response=await portal(new Request(base+'/devices'),env);
  const html=await response.text();
  assert.match(html,/data-login-panel/);
  assert.match(html,/<h1 id="signin-title">Welcome back<\/h1>/);
  assert.match(html,/src="\/brand\/pcrc-logo.svg"/);
  assert.match(html,/<section class="signin-art"/);
  assert.match(html,/Your computer, connected on your terms/);
  assert.doesNotMatch(html,/type="password"/); // Email authentication is not configured yet.
});


test('sign-in uses only this browser session and API authentication failures stay JSON',async()=>{
  const f=await fixture();f.env.JAN_SITE_ROLE='public';
  const path='/devices/sign-in?'+new URLSearchParams({return:'/devices/settings'});
  const existing=await f.call(path);
  assert.equal(existing.status,303);
  assert.equal(existing.headers.get('Location'),base+'/devices/settings');
  const newBrowser=await portal(new Request(base+path),f.env);
  assert.equal(newBrowser.status,200);
  assert.doesNotMatch(await newBrowser.text(),/Test Windows PC/);
  const expired=await portal(new Request(base+'/devices/settings',{headers:{Cookie:'__Host-JanPortal='+'X'.repeat(43)}}),f.env);
  assert.equal(expired.status,303);
  const api=await portal(new Request(base+'/devices/state'),f.env);
  assert.equal(api.status,401);
  assert.equal(api.headers.get('Location'),null);
  assert.match(api.headers.get('Content-Type'),/application\/json/);
});


test('public portal pages share blue-white tokens and a persistent accessible theme switch',async()=>{
  for(const response of [portalPage('<h1>Settings</h1>','Settings',{owner:{login:'member',csrf:'synthetic'}}),await portal(new Request(base+'/devices'),{...(await fixture()).env,JAN_SITE_ROLE:'public'})]) {
    const html=await response.text();
    assert.match(html,/data-pcrc-ui/);
    assert.match(html,/data-theme-toggle/);
    assert.match(html,/aria-label="Dark mode" aria-pressed="false"/);
    assert.match(html,/pcrc-color-theme/);
    assert.ok(html.indexOf('pcrc-color-theme')<html.indexOf('<style>'));
    assert.match(html,/--accent:#1269c7/);
    assert.match(html,/data-theme=dark/);
  }
  const owner=await portalPage('<h1>Operations</h1>','Operations',{ownerSite:true,owner:{login:'operator',csrf:'synthetic'}}).text();
  assert.doesNotMatch(owner,/data-theme-toggle/);
  assert.doesNotMatch(owner,/<html lang="en" data-pcrc-ui/);
});

test('public verification stays in the setup popup and the confirm button preserves server proof and CSRF checks',async()=>{
  const f=await fixture();f.env.JAN_SITE_ROLE='public';await f.storage.put('devices',{});
  const id='V'.repeat(43),key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const publicKey=Buffer.from(await crypto.subtle.exportKey('spki',key.publicKey)).toString('base64url');
  const pair={id,deviceId:crypto.randomUUID(),ownerId:'1234',name:'Sample PC',os:'Windows',agentVersion:'test',publicKey,capabilities:['read','control','files'],code:'123 456',challenge:'C'.repeat(43),expires:Date.now()+300000,status:'pending',proved:false,attempts:0,nonces:[],lastPoll:0,browserChoice:true};
  await f.storage.put('pairing:v1',{[id]:pair});
  let page=await f.call('/devices/approve?id='+id),html=await page.text();
  assert.equal(page.status,200);assert.match(html,/data-setup-dialog/);assert.match(html,/data-stage="verify"/);assert.match(html,/value="approve"[^>]*disabled/);assert.doesNotMatch(html,/name="codes_match"/);
  assert.equal((await f.post('/devices/approve',{id,decision:'approve',access:'control',capabilities:'files',csrf:'invalid'})).status,403);
  assert.equal((await f.post('/devices/approve',{id,decision:'approve',access:'control',capabilities:'files'})).status,409);
  pair.proved=true;await f.storage.put('pairing:v1',{[id]:pair});
  const assistant=await f.call('/devices/approve?id='+id+'&step=assistant&client=claude');
  assert.equal(assistant.status,200);html=await assistant.text();
  assert.match(html,/data-stage="assistant"/);assert.ok(html.includes('/devices/approve?id='+id+'&amp;step=verify'));assert.match(html,/123 456/);
  for(const [os,platform] of [['linux 6.8','linux'],['darwin 24','macos']]){
    pair.os=os;await f.storage.put('pairing:v1',{[id]:pair});
    const platformHtml=await (await f.call('/devices/approve?id='+id)).text();
    assert.ok(platformHtml.includes('data-os="'+platform+'" href="/devices/approve?id='+id+'&amp;step=copy&amp;os='+platform+'" aria-current="page"'));
  }
  const override=await (await f.call('/devices/approve?id='+id+'&os=windows')).text();
  assert.ok(override.includes('data-os="windows" href="/devices/approve?id='+id+'&amp;step=copy&amp;os=windows" aria-current="page"'));
  const approved=await f.post('/devices/approve',{id,decision:'approve',access:'control',capabilities:'files',select_for_ai:'yes'});
  assert.equal(approved.status,303);assert.equal(approved.headers.get('Location'),base+'/devices/connect?step=assistant');
  assert.equal((await f.storage.get('pairing:v1'))[id].status,'approved');
});
