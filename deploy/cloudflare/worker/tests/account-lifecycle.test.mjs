import test from 'node:test';
import assert from 'node:assert/strict';
import {JanDeviceStore} from '../src/device_store.ts';
import {portal,session,digest,maintainAccounts} from '../src/device_portal.ts';
import {retainAccountData} from '../src/account_lifecycle.ts';

class Storage {
  data=new Map();alarmAt=null;
  async get(key){return structuredClone(this.data.get(key));}
  async put(key,value){this.data.set(key,structuredClone(value));}
  async delete(key){if(Array.isArray(key))assert.ok(key.length<=128,'Cloudflare batch-delete limit');for(const k of Array.isArray(key)?key:[key])this.data.delete(k);}
  async list({prefix='',limit=1000,startAfter=''}={}){return new Map([...this.data].filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort(([a],[b])=>a.localeCompare(b)).slice(0,limit));}
  async transaction(fn){return fn(this);}
  async setAlarm(at){this.alarmAt=at;}
}
const base='https://lifecycle.example.workers.dev';
function fixture(){
  const objects=new Map();
  const env={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'public',PADDLE_PRICE_ID:'pri_'+'p'.repeat(26)};
  const state=id=>{if(!objects.has(id)){const storage=new Storage();objects.set(id,{storage,store:new JanDeviceStore({storage},env)});}return objects.get(id);};
  env.DEVICES={idFromName:id=>id,get:id=>({fetch:(url,init)=>state(id).store.fetch(new Request(url,init))})};
  const call=(path,body={},id='5678')=>env.DEVICES.get(id).fetch('https://internal.invalid'+path,{method:'POST',headers:{'X-Jan-Account-Id':id},body:JSON.stringify(body)});
  return {env,state,call};
}

test('account deletion blocks renewals, disconnects access, erases user data and denies stale credentials',async()=>{
  const f=fixture(),s=f.state('5678').storage;
  await f.call('/session/create',{hash:'a'.repeat(64),login:'synthetic',csrf:'test-csrf',userId:'5678'});
  await s.put('devices',{synthetic:{id:'synthetic',name:'Disposable',revoked:false}});
  await s.put('active','synthetic');await s.put('calls',10);await s.put('actions:v1',[{id:'private-action'}]);
  for(let i=0;i<300;i++)await s.put('synthetic:private:'+i,{private:true});
  await s.put('billing:subscriptions:v1',{s:{status:'active'}});
  assert.equal((await f.call('/account/delete-start',{confirmation:'DELETE'})).status,409);
  assert.equal(await s.get('account:closing:v1'),undefined);
  await s.put('billing:subscriptions:v1',{s:{status:'canceled'}});
  assert.equal((await f.call('/account/delete-start',{confirmation:'wrong'})).status,400);
  assert.equal((await f.call('/account/delete-start',{confirmation:'DELETE'})).status,200);
  assert.equal(await s.get('active'),undefined);
  assert.equal((await f.call('/usage/increment')).status,410);
  assert.equal((await f.call('/device/list')).status,410);
  assert.equal((await f.call('/session/get',{hash:'a'.repeat(64)})).status,200);
  assert.equal((await f.call('/account/delete-finish')).status,200);
  assert.deepEqual([...s.data.keys()].sort(),['account:deleted:v1','account:owner:v1']);
  assert.equal((await f.call('/session/create',{hash:'b'.repeat(64),login:'new',csrf:'csrf'})).status,410);
  assert.deepEqual(await (await f.call('/billing/subscription',{private:'late-event'})).json(),{ok:true,ignored:true});
  assert.equal((await f.call('/account/delete-start',{confirmation:'DELETE'},'1234')).status,403,'operator account cannot erase shared service records');
});

test('public deletion uses current account only, origin, CSRF, typed confirmation and retryable OAuth cleanup',async()=>{
  const f=fixture();let fails=true;const revoked=[];
  f.env.OAUTH_PROVIDER={listUserGrants:async()=>({items:revoked.length?[ ]:[{id:'synthetic-grant',userId:'5678'}]}),revokeGrant:async id=>{if(fails)throw Error('private-provider-error');revoked.push(id);}};
  const start=await portal(new Request(base+'/devices/login'),f.env);
  const state=new URL(start.headers.get('Location')).searchParams.get('state');
  const callback=await portal(new Request(base+'/callback?'+new URLSearchParams({state,code:'synthetic'}),{headers:{Cookie:start.headers.get('Set-Cookie').split(';')[0]}}),f.env,async url=>url.includes('access_token')?Response.json({access_token:'synthetic'}):Response.json({id:5678,login:'synthetic'}));
  const cookie=callback.headers.get('Set-Cookie').split(';')[0];
  const get=()=>portal(new Request(base+'/devices/account',{headers:{Cookie:cookie}}),f.env);
  const post=(fields,origin=base)=>portal(new Request(base+'/devices/account/delete',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)}),f.env);
  const page=await get();assert.equal(page.status,200);
  const html=await page.text(),csrf=html.match(/name="csrf" value="([^"]+)"/)[1];
  assert.match(html,/DELETE/);
  assert.equal((await post({csrf,confirmation:'DELETE'},'https://attacker.example')).status,403);
  assert.equal((await post({csrf:'wrong',confirmation:'DELETE'})).status,403);
  assert.equal((await post({csrf,confirmation:'DELETE',account:'1234'})).status,400);
  assert.equal((await post({csrf,confirmation:'wrong'})).status,400);
  const pending=await post({csrf,confirmation:'DELETE'});assert.equal(pending.status,503);
  assert.doesNotMatch(await pending.text(),/private-provider-error/);
  assert.equal(await session(new Request(base+'/devices',{headers:{Cookie:cookie}}),f.env),null,'closing session cannot authorize MCP');
  assert.equal((await get()).status,200,'same session can resume deletion');
  fails=false;
  const done=await post({csrf,confirmation:'DELETE'});assert.equal(done.status,200);
  assert.match(await done.text(),/Account deleted/);
  assert.match(done.headers.get('Set-Cookie'),/Max-Age=0/);
  assert.deepEqual(revoked,['synthetic-grant']);
  assert.equal((await f.call('/directory/find',{query:'5678'},'1234')).status,200);
  assert.equal((await (await f.call('/directory/find',{query:'5678'},'1234')).json()).id,null);
  assert.equal((await f.call('/directory/register',{id:'5678',login:'synthetic'},'1234')).status,410);
  const retry=await portal(new Request(base+'/devices/login'),f.env);
  const retryState=new URL(retry.headers.get('Location')).searchParams.get('state');
  const rejected=await portal(new Request(base+'/callback?'+new URLSearchParams({state:retryState,code:'synthetic'}),{headers:{Cookie:retry.headers.get('Set-Cookie').split(';')[0]}}),f.env,async url=>url.includes('access_token')?Response.json({access_token:'synthetic'}):Response.json({id:5678,login:'synthetic'}));
  assert.equal(rejected.status,410);assert.match(await rejected.text(),/This PCRC account is closed/);
});

test('retention removes expired metadata and keeps only the stated activity and usage windows',async()=>{
  const storage=new Storage(),now=Date.now(),day=86400000;
  await storage.put('session:old',{expires:now-1});await storage.put('session:current',{expires:now+day});
  await storage.put('oauth:janportal.old',{expires:now-1});
  await storage.put('pairing:v1',{old:{expires:now-700000},live:{expires:now+1000}});
  await storage.put('actions:v1',[{expires:now-1},{expires:now+1}]);
  await storage.put('actions:result:expired',{expires:now-1});
  await storage.put('actions:result:live',{expires:now+600000});
  await storage.put('actions:result-part:expired:0',{expires:now-1});
  await storage.put('actions:result-part:live:0',{expires:now+600000});
  await storage.put('activity:recent:v1',[{at:now-31*day},{at:now-100}]);
  const old=new Date(now-187*day).toISOString().slice(0,10),today=new Date(now).toISOString().slice(0,10);
  await storage.put('usage:daily:v1',{started:now-200*day,days:{[old]:10,[today]:3}});
  await storage.put('devices',{expired:{revoked:true,revokedAt:now-31*day},recent:{revoked:true,revokedAt:now-1},legacy:{revoked:true},current:{revoked:false}});
  await retainAccountData(storage,now);
  assert.equal(await storage.get('session:old'),undefined);assert.ok(await storage.get('session:current'));
  assert.equal(await storage.get('oauth:janportal.old'),undefined);
  assert.deepEqual(Object.keys(await storage.get('pairing:v1')),['live']);
  assert.equal((await storage.get('actions:v1')).length,1);
  assert.equal(await storage.get('actions:result:expired'),undefined);
  assert.ok(await storage.get('actions:result:live'));
  assert.equal(await storage.get('actions:result-part:expired:0'),undefined);
  assert.ok(await storage.get('actions:result-part:live:0'));
  assert.equal((await storage.get('activity:recent:v1')).length,1);
  assert.deepEqual((await storage.get('usage:daily:v1')).days,{[today]:3});
  assert.deepEqual(Object.keys(await storage.get('devices')),['recent','legacy','current']);
});

test('background maintenance completes an interrupted deletion and records only aggregate health',async()=>{
  const f=fixture();
  await f.call('/directory/register',{id:'5678',login:'synthetic'},'1234');
  await f.call('/account/delete-start',{confirmation:'DELETE'});
  f.env.OAUTH_PROVIDER={listUserGrants:async()=>({items:[]}),revokeGrant:async()=>{}};
  assert.deepEqual(await maintainAccounts(f.env),{checked:1,deleted:1});
  assert.equal((await (await f.call('/account/deletion-state')).json()).deleted,true);
  await f.call('/directory/maintenance-report',{success:true,checked:1,deleted:1},'1234');
  const report=await (await f.call('/directory/maintenance-report',{read:true},'1234')).json();
  assert.deepEqual(Object.keys(report).sort(),['checked','deleted','failures','lastRun','lastSuccess']);
  assert.equal(report.checked,1);assert.equal(report.deleted,1);assert.equal(report.failures,0);
  assert.equal((await f.call('/directory/maintenance-report',{read:true},'9876')).status,403);
});

test('deleting an old username mapping preserves a username now owned by another account',async()=>{
  const f=fixture();
  await f.call('/directory/register',{id:'5678',login:'reused-name'},'1234');
  await f.call('/directory/register',{id:'9876',login:'reused-name'},'1234');
  await f.call('/directory/remove',{id:'5678'},'1234');
  assert.equal((await (await f.call('/directory/find',{query:'reused-name'},'1234')).json()).id,'9876');
});
