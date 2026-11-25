import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {JanDeviceStore} from '../src/device_store.ts';
import {portal,digest,createPortalSession,session} from '../src/device_portal.ts';
import {ownerSecurityStore,totpSecret,totpCode} from '../src/owner_security.ts';
import {operatorProof,indexMember} from '../src/owner_data.ts';
import {costAmount,refreshRevenue} from '../src/owner_finance.ts';
import {sealRecord} from '../src/secure_store.ts';
import {siteRouteAllowed} from '../src/site_role.ts';
import {retainAccountData} from '../src/account_lifecycle.ts';

import {ownerFixture,unlockOwner} from './helpers/owner-console-fixture.mjs';
import {ownerConsole} from '../src/owner_console.ts';

test('changing the owner GitHub identity preserves customer storage and rejects previous owner sessions and MFA',async()=>{
  const f=await ownerFixture({PCRC_OWNER_GITHUB_ID:'5678'}),storage=f.storages.get('1234');
  const devices={synthetic:{id:'synthetic',name:'Preserved customer PC',revoked:false}};
  await storage.put('devices',devices);const directory=await storage.get('directory:account:1234');
  await storage.put('owner:totp:v1',{record:await sealRecord(f.env.JAN_PROXY_KEY,'1234','owner-totp',{secret:totpSecret()},Date.now()+86400000),lastStep:-1,recovery:[]});
  await storage.put('owner:mfa-session:'+f.binding,{expires:Date.now()+3600000});
  assert.equal((await f.request('/admin')).status,403);
  assert.equal((await f.callStore('/owner-auth/status',{session:f.binding})).status,403);
  assert.equal((await f.callStore('/owner-auth/status',{session:f.binding,principal:'1234'})).status,403);
  assert.deepEqual(await (await f.callStore('/owner-auth/status',{session:f.binding,principal:'5678'})).json(),{enabled:false,verified:false});
  const cookies=r=>r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  async function signIn(id,env=f.env,path='/owner/login'){
    const start=await portal(new Request(f.origin+path),env),state=new URL(start.headers.get('Location')).searchParams.get('state');
    return portal(new Request(f.origin+'/callback?'+new URLSearchParams({state,code:'synthetic'}),{headers:{Cookie:cookies(start)}}),env,async url=>url.includes('access_token')?Response.json({access_token:'synthetic-provider-token'}):Response.json({id,login:id===5678?'new-owner':'previous-owner'}));
  }
  const denied=await signIn(1234);assert.equal(denied.status,403);assert.equal(denied.headers.get('Set-Cookie'),null);
  const signed=await signIn(5678);assert.equal(signed.status,302);assert.match(cookies(signed),/__Host-JanPortal=1234\./);
  assert.equal(await session(new Request(f.origin+'/devices',{headers:{Cookie:cookies(signed)}}),{...f.env,JAN_SITE_ROLE:'public'}),null,'owner sessions cannot authenticate as the storage account on the public site');
  assert.equal(await storage.get('directory:account:1234'),directory);assert.deepEqual(await storage.get('devices'),devices);
  const cookie=cookies(signed),page=await portal(new Request(f.origin+'/admin/security',{headers:{Cookie:cookie}}),f.env);
  assert.equal(page.status,200);const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await page.text())[1];
  const post=(path,values={})=>portal(new Request(f.origin+path,{method:'POST',headers:{Cookie:cookie,Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...values})}),f.env);
  const setup=await post('/admin/security/setup');assert.equal(setup.status,200);
  const secret=/<code class="setup-key">([A-Z2-7]{32})<\/code>/.exec(await setup.text())[1];
  const verified=await post('/admin/security/verify',{code:await totpCode(secret,Math.floor(Date.now()/30000))});assert.equal(verified.status,200);
  assert.ok(await storage.get('owner:totp:v1:5678'));assert.ok(await storage.get('owner:totp:v1'));
  assert.equal((await f.request('/admin')).status,403,'old owner cannot use the new owner MFA grant');
  const member=await signIn(5678,{...f.env,JAN_SITE_ROLE:'public'},'/devices/login');assert.equal(member.status,302);assert.match(cookies(member),/__Host-JanPortal=5678\./);
  assert.equal((await portal(new Request(f.origin+'/admin',{headers:{Cookie:cookies(member)}}),f.env)).status,403);
});

test('expired owner setup directs fresh GitHub sign-in instead of blaming an authenticator code',async()=>{
  const f=await ownerFixture();
  await f.callStore('/session/create',{hash:await digest(f.token),login:'pcrc-owner',csrf:f.csrf,userId:'1234',ownerOrigin:f.origin,ownerLoginAt:Date.now()-660000});
  const response=await f.post('/admin/security/setup');assert.equal(response.status,403);
  const html=await response.text();assert.match(html,/href="\/owner\/login"/);assert.match(html,/Sign in again with GitHub/);
  assert.doesNotMatch(html,/Code could not be verified|<code class="setup-key"|action="\/admin\/security\/setup"/);
  assert.equal(await f.storages.get('1234').get('owner:totp-pending:'+f.binding),undefined);
});

test('owner security separates rejected forms, code throttling and setup service failures',async()=>{
  const f=await ownerFixture();
  const rejected=await f.post('/admin/security/setup',{csrf:'wrong'});assert.equal(rejected.status,403);
  assert.match(await rejected.text(),/This form expired or came from another site/);
  assert.equal(await f.storages.get('1234').get('owner:totp-pending:'+f.binding),undefined);
  const request=new Request(f.origin+'/admin/security/setup',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf})});
  const unavailable=await ownerConsole(request,f.env,{userId:'1234',login:'pcrc-owner',csrf:f.csrf,ownerOrigin:f.origin,ownerLoginAt:Date.now()},async path=>{
    if(path==='/owner-auth/status')return {enabled:false,verified:false};
    throw Object.assign(Error('synthetic internal detail must remain private'),{status:503});
  });
  assert.equal(unavailable.status,503);const message=await unavailable.text();assert.match(message,/No code was checked/);assert.doesNotMatch(message,/synthetic internal detail/);
  await f.callStore('/owner-auth/enroll',{session:f.binding,recent:true});
  for(let i=0;i<5;i++)await f.callStore('/owner-auth/verify',{session:f.binding,recent:true,code:'xxxxxx'});
  const throttled=await f.post('/admin/security/verify',{code:'xxxxxx'});assert.equal(throttled.status,429);assert.match(await throttled.text(),/Too many code attempts/);
});

test('authenticator matches RFC6238 vector, encrypts secrets, blocks replay, throttles and supports single-use recovery',async()=>{
  const secret=totpSecret(new TextEncoder().encode('12345678901234567890'));assert.equal(await totpCode(secret,1),'287082');
  const f=await ownerFixture(),{secret:enrolled,response}=await unlockOwner(f),html=await response.text();
  assert.doesNotMatch(JSON.stringify([...f.storages.get('1234').entries.values()]),new RegExp(enrolled));
  assert.match(html,/recovery-codes/);const recovery=/<li>([A-Z2-7]{16})<\/li>/.exec(html)[1];
  const other='d'.repeat(64),code=await totpCode(enrolled,Math.floor(Date.now()/30000));
  assert.equal((await f.callStore('/owner-auth/verify',{session:other,code})).status,403);
  assert.equal((await f.callStore('/owner-auth/verify',{session:other,code:recovery})).status,200);
  assert.equal((await f.callStore('/owner-auth/verify',{session:'e'.repeat(64),code:recovery})).status,403);
  for(let i=0;i<5;i++)await f.callStore('/owner-auth/verify',{session:other,code:'xxxxxx'});
  assert.equal((await f.callStore('/owner-auth/verify',{session:other,code:'xxxxxx'})).status,429);
  assert.equal((await f.callStore('/owner-auth/status',{session:other},'5678')).status,403);
});

test('public hosts reject all owner routes, public cookies cannot enroll, MFA protects every admin mutation',async()=>{
  const f=await ownerFixture();
  for(const path of ['/admin','/admin/users','/admin/users/action','/admin/security/setup','/admin/prompts','/admin/subscriptions','/admin/support','/admin/not-a-route','/owner/login']){
    assert.equal(siteRouteAllowed('public',path),false,path);
    const response=await portal(new Request(f.origin+path,{headers:{Cookie:'__Host-JanPortal='+f.token}}),{...f.env,JAN_SITE_ROLE:'public'});assert.ok(response.status>=400,path);
  }
  assert.equal((await f.request('/admin')).status,303);
  assert.equal((await f.post('/admin/users/action',{action:'delete',account:'5678',confirmation:'DELETE'})).status,303);
  const storage=f.storages.get('1234'),session=await storage.get('session:'+await digest(f.token));
  await f.callStore('/session/create',{hash:await digest('P'.repeat(43)),login:'pcrc-owner',csrf:'Q'.repeat(43),userId:'1234'});
  assert.equal((await portal(new Request(f.origin+'/admin/security',{headers:{Cookie:'__Host-JanPortal='+'P'.repeat(43)}}),f.env)).status,403);
  await unlockOwner(f);assert.equal((await f.request('/admin')).status,200);
  assert.equal((await f.post('/admin/analytics/refresh',{csrf:'bad'})).status,403);
  assert.equal((await f.request('/admin/users/action',{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf})})).status,403);
});

test('users are bounded/searchable and complimentary Pro changes effective entitlements without fake subscriptions',async()=>{
  const f=await ownerFixture();await unlockOwner(f);
  for(let i=0;i<26;i++)await f.callStore('/directory/register',{id:String(6000+i),login:'member'+i});
  const listing=await (await f.callStore('/owner-data/users',{q:''})).json();assert.equal(listing.users.length,20);assert.ok(listing.next);
  await indexMember(f.storages.get('1234'),'6000','member0',Date.now(),['Demo Laptop']);
  assert.equal((await (await f.callStore('/owner-data/users',{q:'demo laptop'})).json()).users[0].id,'6000');
  const until=Date.now()+86400000,body={nonce:crypto.randomUUID(),until,reason:'Synthetic grant'};
  const raw=JSON.stringify(body),timestamp=String(Date.now()),proof=await operatorProof(f.env.JAN_PROXY_KEY,'/operator/pro','6000',timestamp,raw);
  assert.equal((await f.callStore('/operator/pro',body,'6000')).status,403);
  assert.equal((await f.callStore('/operator/pro',body,'6000',{'X-PCRC-Operator-Time':timestamp,'X-PCRC-Operator-Proof':proof})).status,200);
  assert.equal((await (await f.callStore('/device/list',{},'6000')).json()).plan,'pro');
  assert.deepEqual(await (await f.callStore('/billing/summary',{},'6000')).json(),[]);
  assert.equal((await f.callStore('/operator/pro',body,'6000',{'X-PCRC-Operator-Time':timestamp,'X-PCRC-Operator-Proof':proof})).status,409);
  await f.storages.get('6000').put('billing:complimentary:v1',{until:Date.now()-1});
  assert.equal((await (await f.callStore('/device/list',{},'6000')).json()).plan,'free');
  const response=await f.request('/admin/users?q=demo+laptop');assert.match(await response.text(),/Search results/);
});

test('selected devices must all belong to the exact account before revocation starts',async()=>{
  const f=await ownerFixture();await unlockOwner(f);await f.callStore('/directory/register',{id:'5678',login:'synthetic-member'});
  const a=crypto.randomUUID(),b=crypto.randomUUID();await f.callStore('/device/list',{},'5678');
  await f.storages.get('5678').put('devices',{[a]:{id:a,name:'Demo PC',revoked:false,created:Date.now()}});
  const denied=await f.post('/admin/users/action',{account:'5678',action:'revoke',confirmation:'REVOKE',device:b});assert.equal(denied.status,400);
  assert.equal((await f.storages.get('5678').get('devices'))[a].revoked,false);
  assert.equal((await f.post('/admin/users/action',{account:'5678',action:'revoke',confirmation:'REVOKE',device:a})).status,303);
  assert.equal((await f.storages.get('5678').get('devices'))[a].revoked,true);
});

test('support is account scoped, messages are encrypted and credentials rejected',async()=>{
  const f=await ownerFixture();
  assert.equal((await f.callStore('/support/create',{title:'Help',text:'password=synthetic-password-forbidden'},'5678')).status,400);
  const ticket=await (await f.callStore('/support/create',{title:'Synthetic support',text:'Please help with my demo connection.'},'5678')).json();
  assert.doesNotMatch(JSON.stringify([...f.storages.get('5678').entries.values()]),/Please help with my demo connection/);
  assert.equal((await f.callStore('/support/get',{id:ticket.id},'9012')).status,404);
  await f.callStore('/support/reply',{id:ticket.id,text:'Another user message',operator:true},'5678');
  const thread=await (await f.callStore('/support/get',{id:ticket.id},'5678')).json();assert.equal(thread.messages.at(-1).author,'user');
});

test('financial snapshots preserve currencies, handle adjustments and never claim profit without costs',async()=>{
  const f=await ownerFixture();f.env.PADDLE_SANDBOX_API_KEY='synthetic-paddle-key';
  const store=async(p,d)=>(await f.callStore(p,d)).json();let requests=0;
  const fetcher=async(url,init)=>{requests++;assert.equal(init.method,'GET');assert.match(url,/include=adjustments_totals/);return Response.json({data:[{id:'txn_'+'a'.repeat(26),status:'completed',currency_code:'USD',items:[{price:{id:f.env.PADDLE_PRICE_ID}}],details:{totals:{total:'1200',earnings:'1000'}},adjustments_totals:{total:'200',earnings:'150'}}],meta:{pagination:{has_more:false}}});};
  const revenue=await refreshRevenue(f.env,store,'2026-11',fetcher);assert.equal(requests,1);assert.equal(revenue.currencies.USD.earnings,850);assert.equal(revenue.complete,true);
  const mixed=await refreshRevenue(f.env,store,'2026-10',async()=>Response.json({data:[{id:'txn_'+'m'.repeat(26),status:'completed',currency_code:'USD',items:[{price:{id:f.env.PADDLE_PRICE_ID}},{price:{id:'pri_other'}}],details:{totals:{total:'9900',earnings:'9000'}}}],meta:{pagination:{has_more:false}}}));assert.equal(mixed.excluded,1);assert.deepEqual(mixed.currencies,{});
  assert.equal(costAmount('12.34','USD'),1234);assert.equal(costAmount('12','JPY'),12);assert.throws(()=>costAmount('12.1','JPY'));
});

test('post-MFA legacy prompt and cancellation forms retain their body and dispatch once',async()=>{
  const f=await ownerFixture();await unlockOwner(f);
  const id=crypto.randomUUID();assert.equal((await f.post('/admin/prompts',{action:'category-add',id,name:'Synthetic category'})).status,303);
  assert.equal((await (await f.callStore('/website-prompts/categories')).json()).filter(x=>x.id===id).length,1);
  await f.callStore('/directory/register',{id:'5678',login:'billing-demo'});await f.callStore('/device/list',{},'5678');
  const sub='sub_'+'b'.repeat(26);await f.storages.get('5678').put('billing:subscriptions:v1',{[sub]:{id:sub,status:'active',priceId:f.env.PADDLE_PRICE_ID,occurredAt:1}});
  f.env.PADDLE_SANDBOX_API_KEY='synthetic-owner-paddle';let cancellations=0;
  const fetcher=async(url,init)=>{
    if(url.endsWith('/cancel')){cancellations++;return Response.json({data:{id:sub,status:'active',scheduled_change:{effective_at:'2026-12-01T00:00:00Z'}}});}
    if(url.includes('/subscriptions/'))return Response.json({data:{id:sub,status:'active',custom_data:{account_id:'5678'}}});
    if(url.includes('/transactions?'))return Response.json({data:[]});throw Error('Unexpected request');
  };
  const response=await portal(new Request(f.origin+'/admin/subscriptions',{method:'POST',headers:{Cookie:'__Host-JanPortal='+f.token,Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf,account:'5678',id:sub,action:'cancel',confirm:'yes'})}),f.env,fetcher);
  assert.equal(response.status,303);assert.equal(cancellations,1);
});

test('deletion removes owner indexes and retention removes expired ticket, MFA and nonce records',async()=>{
  const f=await ownerFixture();await f.callStore('/directory/register',{id:'5678',login:'deletion-demo'});
  const storage=f.storages.get('1234'),ticket=crypto.randomUUID();
  await f.callStore('/owner-data/support-index-add',{id:ticket,accountId:'5678',created:Date.now()});
  await indexMember(storage,'5678','deletion-demo',Date.now()+1000,['Disposable system']);
  for(let n=0;n<30;n++)await f.callStore('/owner-data/support-index-add',{id:crypto.randomUUID(),accountId:'5678',created:Date.now()-n*86400000});
  const otherTicket=crypto.randomUUID();await f.callStore('/owner-data/support-index-add',{id:otherTicket,accountId:'9012',created:Date.now()});
  assert.equal((await f.callStore('/directory/remove',{id:'5678'})).status,200);
  assert.equal((await storage.list({prefix:'owner:account-ticket:5678:'})).size,0);
  assert.equal((await storage.list({prefix:'owner:ticket:'})).size,1);
  assert.equal((await storage.list({prefix:'owner:account-ticket:9012:'})).size,1);
  for(const [key,value]of storage.entries)if(key.startsWith('owner:'))assert.ok(!JSON.stringify({key,value}).includes('deletion-demo')&&!JSON.stringify({key,value}).includes('Disposable system')&&!key.includes(ticket));
  const expired=Date.now()-1;
  for(const key of ['owner:totp-pending:test','owner:mfa-session:test','operator:nonce:test','owner:ticket:test'])await storage.put(key,{expires:expired});
  await storage.put('support:tickets:v1',[{record:{expires:expired}}]);
  await retainAccountData(storage);
  for(const key of ['owner:totp-pending:test','owner:mfa-session:test','operator:nonce:test','owner:ticket:test'])assert.equal(await storage.get(key),undefined);
  assert.deepEqual(await storage.get('support:tickets:v1'),[]);
});

test('expired grant cleanup cannot race away a fresh operator grant',async()=>{
  const f=await ownerFixture();await f.callStore('/device/list',{},'5678');const storage=f.storages.get('5678');
  await storage.put('billing:complimentary:v1',{until:Date.now()-1});
  let release,observed;const wait=new Promise(r=>release=r),seen=new Promise(r=>observed=r),get=storage.get.bind(storage);let paused=false;
  storage.get=async key=>{const value=await get(key);if(key==='billing:complimentary:v1'&&!paused){paused=true;observed();await wait;}return value;};
  const summary=f.callStore('/device/list',{},'5678');await seen;
  const body={nonce:crypto.randomUUID(),until:Date.now()+86400000,reason:'Fresh synthetic grant'},raw=JSON.stringify(body),stamp=String(Date.now());
  const update=f.callStore('/operator/pro',body,'5678',{'X-PCRC-Operator-Time':stamp,'X-PCRC-Operator-Proof':await operatorProof(f.env.JAN_PROXY_KEY,'/operator/pro','5678',stamp,raw)});
  release();await Promise.all([summary,update]);assert.equal((await get('billing:complimentary:v1')).until,body.until);
});

test('pairing hub rejects a dormant expired complimentary owner without waiting for maintenance',async()=>{
  const f=await ownerFixture();await f.callStore('/directory/register',{id:'5678',login:'primary-demo'});
  const hub=f.storages.get('1234'),key='synthetic-installation-key';await hub.put('pairing:key-owner:v1:'+key,['5678','9012']);
  await f.callStore('/pairing/plan',{ownerId:'5678',pro:true,revision:1,validUntil:Date.now()-1});
  const access=await (await f.callStore('/pairing/access',{ownerId:'9012',publicKey:key,pro:true,revision:1,validUntil:null})).json();assert.equal(access.allowed,false);
  assert.equal((await f.callStore('/pairing/plan',{ownerId:'5678',pro:true,revision:1,validUntil:null})).status,400,'an equal revision cannot remove expiry');
  await f.callStore('/device/list',{},'5678');await f.storages.get('5678').put('billing:complimentary:v1',{until:Date.now()-1});await f.storages.get('5678').put('billing:plan-revision:v1',1);
  assert.equal((await f.callStore('/account/retention',{},'5678')).status,200);assert.equal((await hub.get('pairing:pro:v1:5678')).pro,false);
});

test('member support reaches the owner inbox and owner replies return only to that member',async()=>{
  const f=await ownerFixture();await unlockOwner(f);const publicEnv={...f.env,JAN_SITE_ROLE:'public'};
  const session=await createPortalSession(publicEnv,{id:'5678',login:'support-demo'}),cookie=session.headers.get('Set-Cookie').split(';')[0];
  const member=async(path,init={})=>portal(new Request(f.origin+path,{...init,headers:{Cookie:cookie,...init.headers}}),publicEnv);
  const supportPage=await member('/devices/support');assert.equal(supportPage.headers.get('Referrer-Policy'),'same-origin');
  const html=await supportPage.text(),csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(html)[1];
  const opened=await member('/devices/support',{method:'POST',headers:{Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,title:'Connection help',text:'Synthetic support request'})});assert.equal(opened.status,303);
  const index=await (await f.callStore('/owner-data/support-index',{})).json();assert.equal(index.tickets.length,1);const id=index.tickets[0].id;
  assert.match(await (await f.request('/admin/support?account=5678&ticket='+id)).text(),/Synthetic support request/);
  assert.equal((await f.post('/admin/support',{account:'5678',ticket:id,text:'Synthetic owner reply',close:'yes'})).status,303);
  const response=await member('/devices/support?ticket='+id);assert.match(await response.text(),/Synthetic owner reply/);
  assert.equal((await f.callStore('/support/get',{id},'9012')).status,404);
});

test('reset emails use the stored verified target and public callback; repeated requests are throttled',async()=>{
  const f=await ownerFixture();await unlockOwner(f);const subject=crypto.randomUUID(),account='s-'+subject;
  await f.callStore('/directory/register',{id:account,login:'emaildemo'});
  const storage=f.storages.get('1234');await storage.put('email-username:v1:'+subject,'emaildemo');
  await storage.put('email-login:v1:emaildemo',{subject,record:await sealRecord(f.env.JAN_PROXY_KEY,'1234','email-login',{email:'synthetic@example.test'},Date.now()+86400000)});
  Object.assign(f.env,{PCRC_PUBLIC_SITE_ORIGIN:'https://public-console.example.workers.dev',SUPABASE_URL:'https://'+'a'.repeat(20)+'.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'a'.repeat(25)});
  let sent=0;const fetcher=async(url,init)=>{sent++;assert.match(url,/\/auth\/v1\/recover\?redirect_to=/);const callback=new URL(new URL(url).searchParams.get('redirect_to'));assert.equal(callback.origin+callback.pathname,'https://public-console.example.workers.dev/devices/email/callback');assert.match(callback.searchParams.get('reset'),/^[A-Za-z0-9_-]{43}$/);const body=JSON.parse(init.body);assert.equal(body.email,'synthetic@example.test');assert.equal(body.code_challenge_method,'s256');assert.match(body.code_challenge,/^[A-Za-z0-9_-]{43}$/);return Response.json({});};
  const send=()=>portal(new Request(f.origin+'/admin/users/action',{method:'POST',headers:{Cookie:'__Host-JanPortal='+f.token,Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf,account,action:'reset',email:'attacker@example.test'})}),f.env,fetcher);
  assert.equal((await send()).status,303);assert.equal((await send()).status,429);assert.equal(sent,1);
});

test('expired authenticator setup never enables MFA and expiring Pro revokes only surplus connections',async()=>{
  const f=await ownerFixture(),pending=await (await f.callStore('/owner-auth/enroll',{session:f.binding,recent:true})).json();
  const storage=f.storages.get('1234'),key='owner:totp-pending:'+f.binding,record=await storage.get(key);record.expires=Date.now()-1;await storage.put(key,record);
  assert.equal((await f.callStore('/owner-auth/verify',{session:f.binding,recent:true,code:await totpCode(pending.secret,Math.floor(Date.now()/30000))})).status,403);
  assert.equal(await storage.get('owner:totp:v1'),undefined);
  await f.callStore('/device/list',{},'5678');const member=f.storages.get('5678'),first=crypto.randomUUID(),second=crypto.randomUUID();
  await member.put('devices',{[first]:{id:first,name:'Retained PC',created:1,revoked:false},[second]:{id:second,name:'Extra PC',created:2,revoked:false}});await member.put('active',second);await member.put('billing:complimentary:v1',{until:Date.now()-1});
  await f.callStore('/device/list',{},'5678');const devices=await member.get('devices');assert.equal(devices[second].revoked,false);assert.equal(devices[first].revoked,true);
});


test('admin portal uses Admin Dashboard branding after owner MFA',async()=>{
  const f=await ownerFixture();await unlockOwner(f);
  const response=await f.request('/admin');assert.equal(response.status,200);
  const html=await response.text();assert.match(html,/Admin Dashboard/);assert.doesNotMatch(html,/Owner console|PCRC owner workspace/);
});
