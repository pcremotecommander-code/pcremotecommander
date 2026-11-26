import test from 'node:test';
import assert from 'node:assert/strict';
import {JanDeviceStore} from '../src/device_store.ts';
import {publicRateLimit} from '../src/public_rate_limit.ts';

class Storage {
  data=new Map(); pending=Promise.resolve(); alarmAt=null;
  async get(key){return structuredClone(this.data.get(key));}
  async put(key,value){this.data.set(key,structuredClone(value));}
  async delete(key){this.data.delete(key);}
  async setAlarm(at){this.alarmAt=at;}
  transaction(fn){const result=this.pending.then(()=>fn(this));this.pending=result.catch(()=>{});return result;}
}
function fixture(){
  const objects=new Map();
  const env={JAN_PUBLIC_ORIGIN:'https://public.example.workers.dev',JAN_PROXY_KEY:'A'.repeat(43),ALLOWED_GITHUB_ID:'1234',JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'public'};
  env.DEVICES={idFromName:name=>name,get:name=>{
    if(!objects.has(name)){const storage=new Storage();objects.set(name,{storage,store:new JanDeviceStore({storage},env)});}
    return {fetch:(url,init)=>objects.get(name).store.fetch(new Request(url,init))};
  }};
  const request=(path,ip='192.0.2.1')=>new Request(env.JAN_PUBLIC_ORIGIN+path,{headers:{'CF-Connecting-IP':ip,'X-Forwarded-For':crypto.randomUUID()}});
  return {env,objects,request};
}

test('verification status polling retains protection without exhausting signup email budgets',async()=>{
 const f=fixture();
 for(let i=0;i<15;i++)assert.equal(await publicRateLimit(f.request('/devices/email/verification-status'),f.env),null);
 for(let i=0;i<10;i++)assert.equal(await publicRateLimit(f.request('/devices/email/signup'),f.env),null);
 assert.equal((await publicRateLimit(f.request('/devices/email/signup'),f.env)).status,429);
});

test('different gateway instances share registration budgets and cannot bypass them with query strings',async()=>{
  const f=fixture();
  const results=await Promise.all(Array.from({length:30},(_,i)=>publicRateLimit(f.request('/register?bypass='+i),{...f.env})));
  assert.equal(results.filter(r=>r===null).length,10);
  const blocked=results.filter(Boolean);
  assert.equal(blocked.length,20);
  assert.ok(blocked.every(r=>r.status===429&&Number(r.headers.get('Retry-After'))>0));
  assert.equal(await publicRateLimit(f.request('/register','192.0.2.2'),f.env),null);
  assert.equal(await publicRateLimit(f.request('/devices/pair/start'),f.env),null);
  assert.equal(f.objects.size,3);
  assert.doesNotMatch(JSON.stringify([...f.objects.keys()]),/192\.0\.2|bypass|Forwarded/);
});

test('limiter logs bounded failure diagnostics while failing closed without exposing secrets',async()=>{
  const f=fixture(),events=[],original=console.error;
  f.env.DEVICES.get=()=>({fetch:async()=>{throw Object.assign(Error('private-secret-and-ip'),{name:'SyntheticStorageError'});}});
  console.error=(...args)=>events.push(args);
  try {
    const denied=await publicRateLimit(f.request('/authorize'),f.env);
    assert.equal(denied.status,503);
    assert.equal(events.length,1);
    assert.equal(events[0][0],'PCRC_ABUSE_LIMITER_UNAVAILABLE');
    assert.deepEqual(events[0][1],{errorName:'SyntheticStorageError'});
    assert.doesNotMatch(JSON.stringify(events),/private-secret|192\\.0/);
    assert.doesNotMatch(await denied.text(),/private-secret|192\\.0/);
  } finally {console.error=original;}
});

test('limiter uses trusted edge IP and fails closed without exposing error details',async()=>{
  const f=fixture();
  f.env.DEVICES.get=()=>({fetch:async()=>{throw Error('private-secret-and-ip');}});
  const denied=await publicRateLimit(f.request('/authorize'),f.env);
  assert.equal(denied.status,503);
  assert.doesNotMatch(await denied.text(),/private-secret|192\.0/);
  assert.equal(await publicRateLimit(f.request('/billing/paddle/webhook'),f.env),null);
  assert.equal(await publicRateLimit(f.request('/prompts/'),f.env),null);
});

test('sliding minute budget expires, hourly budget persists, and idle pseudonyms are removed',async()=>{
  const f=fixture(),storage=new Storage(),store=new JanDeviceStore({storage},f.env);
  const now=Date.now();
  const call=()=>store.fetch(new Request('https://internal.invalid/abuse/check',{method:'POST',body:'{"bucket":"registration"}'}));
  await storage.put('abuse:v1',{recent:Array(10).fill(now),hourStart:now,hourCount:10});
  assert.equal((await call()).status,429);
  await storage.put('abuse:v1',{recent:Array(10).fill(now-60001),hourStart:now,hourCount:99});
  assert.equal((await call()).status,204);
  assert.equal((await call()).status,429,'hour budget survives minute reset');
  await storage.put('abuse:v1',{recent:[],hourStart:now-3600001,hourCount:100});
  assert.equal((await call()).status,204);
  assert.ok(storage.alarmAt>Date.now());
  await storage.put('abuse:v1',{recent:Array(10).fill(now),hourStart:now-3600001,hourCount:100,expiresAt:now+60000});
  assert.equal((await call()).status,429,'hour reset must not clear the sliding minute budget');
  await store.alarm();
  assert.ok(await storage.get('abuse:v1'),'early alarm must preserve active window');
  await storage.put('abuse:v1',{...(await storage.get('abuse:v1')),expiresAt:now-1});
  await store.alarm();
  assert.equal(await storage.get('abuse:v1'),undefined);
  assert.equal((await store.fetch(new Request('https://internal.invalid/abuse/check',{method:'POST',body:'{"bucket":"attacker"}'}))).status,400);
});
