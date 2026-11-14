import test from 'node:test';
import assert from 'node:assert/strict';
import {connectedCapacity,expireConnectedCapacity,ConnectedAccountLease} from '../src/connected_capacity.ts';
class Storage{
 data=new Map();pending=Promise.resolve();alarm=null;
 async get(k){return structuredClone(this.data.get(k));}
 async put(k,v){this.data.set(k,structuredClone(v));}
 async delete(k){this.data.delete(k);}
 async setAlarm(at){this.alarm=at;}
 transaction(fn){const p=this.pending.then(()=>fn(this));this.pending=p.catch(()=>{});return p;}
}
const request=(action,account,token)=>new Request('https://internal.invalid/capacity/account',{method:'POST',body:JSON.stringify({action,account,token})});
const call=(s,action,account,token)=>connectedCapacity(request(action,account,token),s);

test('atomic global admission allows only 200 accounts; reconnects reuse slots and stale releases cannot steal them',async()=>{
 const s=new Storage();const tokens=Array.from({length:401},()=>crypto.randomUUID());
 const results=await Promise.all(tokens.map((token,i)=>call(s,'acquire',String(5000+i),token)));
 assert.equal(results.filter(r=>r.status===200).length,200);
 assert.equal(results.filter(r=>r.status===429).length,201);
 const replacement=crypto.randomUUID();
 assert.equal((await call(s,'acquire','5000',replacement)).status,200);
 await call(s,'release','5000',tokens[0]);
 assert.equal((await call(s,'acquire','9999',crypto.randomUUID())).status,429);
 assert.equal((await call(s,'renew','5000',tokens[0])).status,409);
 await call(s,'release','5000',replacement);
 assert.equal((await call(s,'acquire','9999',crypto.randomUUID())).status,200);
 assert.equal(Object.keys(await s.get('connected:accounts:v1')).length,200);
});

test('expired leases cannot renew and alarm removes idle account identifiers',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const s=new Storage(),token=crypto.randomUUID();
 await call(s,'acquire','1234',token);t.mock.timers.tick(60001);
 assert.equal((await call(s,'renew','1234',token)).status,409);
 assert.equal(await s.get('connected:accounts:v1'),undefined);
 await call(s,'acquire','1234',token);t.mock.timers.tick(60001);await expireConnectedCapacity(s);
 assert.equal(await s.get('connected:accounts:v1'),undefined);
});

test('capacity service validates canonical accounts, body, action and token',async()=>{
 const s=new Storage();
 for(const body of [{action:'acquire',account:'__proto__',token:crypto.randomUUID()},
   {action:'acquire',account:'1234',token:'x'}, {action:'bypass',account:'1234',token:crypto.randomUUID()},
   {action:'acquire',account:'1234',token:crypto.randomUUID(),limit:2000}]){
   assert.equal((await connectedCapacity(new Request('https://internal.invalid/capacity/account',{method:'POST',body:JSON.stringify(body)}),s)).status,400);
 }
 assert.equal(s.data.size,0);
});

test('local lease closes on renewal outage, never silently continues without a counted slot',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});let failed=0,closed=0;
 const s=new Storage();const ns={idFromName:n=>n,get:()=>({fetch:async(url,init)=>{
  const body=JSON.parse(init.body);if(body.action==='renew'){failed++;throw Error('synthetic outage');}
  return connectedCapacity(new Request(url,init),s);
 }})};
 const lease=new ConnectedAccountLease(ns,'1234',()=>{closed++;});
 assert.deepEqual(await Promise.all([lease.acquire(),lease.acquire()]),[200,200]);
 assert.equal(lease.valid,true);t.mock.timers.tick(20000);
 await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(failed,1);assert.equal(lease.valid,false);assert.equal(closed,1);lease.stop();
});

test('lease validity expires synchronously even before a delayed timer callback',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const s=new Storage();
 const ns={idFromName:n=>n,get:()=>({fetch:(u,i)=>connectedCapacity(new Request(u,i),s)})};
 const lease=new ConnectedAccountLease(ns,'1234',()=>{});
 try{assert.equal(await lease.acquire(),200);t.mock.timers.tick(59001);assert.equal(lease.valid,false);}
 finally{lease.stop();}
});


test('hung renewal expires; a late old response cannot revive or stop the replacement lease',async t=>{
 t.mock.timers.enable({apis:['Date','setTimeout'],now:100000});let resolveOld,closed=0;
 const s=new Storage(),ns={idFromName:n=>n,get:()=>({fetch:async(u,i)=>{
  if(JSON.parse(i.body).action==='renew')return new Promise(resolve=>{resolveOld=resolve;});
  return connectedCapacity(new Request(u,i),s);
 }})};
 const lease=new ConnectedAccountLease(ns,'1234',()=>{closed++;});
 try{
  assert.equal(await lease.acquire(),200);t.mock.timers.tick(20000);
  assert.equal(typeof resolveOld,'function');t.mock.timers.tick(39000);
  assert.equal(lease.valid,false);assert.equal(closed,1);
  assert.equal(await lease.acquire(),200);
  resolveOld(Response.json({expires:Date.now()+60000}));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(lease.valid,true);assert.equal(closed,1);
 }finally{lease.stop();}
});
