import test from 'node:test';
import assert from 'node:assert/strict';
import {JanDeviceStore} from '../src/device_store.ts';
import {authenticatedMcpRateLimit} from '../src/public_rate_limit.ts';
import {proxyMcp} from '../src/policy.ts';

class Storage {
  data=new Map();pending=Promise.resolve();
  async get(key){return structuredClone(this.data.get(key));}
  async put(key,value){this.data.set(key,structuredClone(value));}
  async delete(key){return this.data.delete(key);}
  async setAlarm(){}
  transaction(fn){const task=this.pending.then(()=>fn(this));this.pending=task.catch(()=>{});return task;}
}
function fixture(){
  const objects=new Map(),storages=new Map();
  const env={JAN_PUBLIC_ORIGIN:'https://scale.example.workers.dev',JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-private-secret',ALLOWED_GITHUB_ID:'1234',JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'public'};
  env.DEVICES={idFromName:id=>id,get:id=>{
    if(!objects.has(id)){const storage=new Storage();storages.set(id,storage);objects.set(id,new JanDeviceStore({storage},env));}
    return {fetch:(url,init)=>objects.get(id).fetch(new Request(url,init))};
  }};
  return {env,objects,storages};
}
test('2000 validated account budgets remain independent behind one model-host IP',async()=>{
  const {env,objects}=fixture();
  const results=await Promise.all(Array.from({length:2000},(_,i)=>authenticatedMcpRateLimit(String(5000+i),env)));
  assert.ok(results.every(r=>r===null));assert.equal(objects.size,2000);
  assert.ok([...objects.keys()].every(key=>/^abuse:v1:[a-f0-9]{64}$/.test(key)));
  for(let i=0;i<119;i++)assert.equal(await authenticatedMcpRateLimit('5000',env),null);
  assert.equal((await authenticatedMcpRateLimit('5000',env)).status,429);
  assert.equal(await authenticatedMcpRateLimit('5001',env),null);
  assert.equal((await authenticatedMcpRateLimit('unvalidated-account',env)).status,403);
});
test('cross-provider display-name collision cannot silently choose an account',async()=>{
  const {env}=fixture();const store=new JanDeviceStore({storage:new Storage()},env);
  const call=async(path,body)=>store.fetch(new Request('https://internal.invalid'+path,{method:'POST',headers:{'X-Jan-Account-Id':'1234'},body:JSON.stringify(body)}));
  const email='s-12345678-1234-4123-8123-123456789abc';
  await call('/directory/register',{id:'5678',login:'alice'});
  await call('/directory/register',{id:email,login:'alice'});
  const result=await (await call('/directory/find',{query:'alice'})).json();
  assert.equal(result.id,null);assert.equal(result.ambiguous,true);
  assert.equal((await (await call('/directory/find',{query:'5678'})).json()).id,'5678');
  assert.equal((await (await call('/directory/find',{query:email})).json()).id,email);
});
test('revoked auth epochs cannot consume the current account budget',async()=>{
  const {env,storages}=fixture();env.DEVICES.get('5000');
  await storages.get('5000').put('account:auth-version:v1',1);
  const auth={audience:env.JAN_PUBLIC_ORIGIN+'/mcp',userId:'5000',scope:['pcrc:read']};
  const req=()=>new Request(env.JAN_PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{}})});
  for(let i=0;i<120;i++)assert.equal((await proxyMcp(req(),env,auth,{accountId:'5000',authVersion:0})).status,401);
  assert.equal([...storages.keys()].filter(key=>key.startsWith('abuse:')).length,0);
  assert.notEqual((await proxyMcp(req(),env,auth,{accountId:'5000',authVersion:1})).status,429);
  const budget=[...storages].find(([key])=>key.startsWith('abuse:'))?.[1];
  assert.equal((await budget.get('abuse:v1')).hourCount,1);
});
