import test from 'node:test';
import assert from 'node:assert/strict';
import {JanDeviceStore} from '../src/device_store.ts';

class Storage {
  data=new Map(); pending=Promise.resolve();
  async get(key){return structuredClone(this.data.get(key));}
  async put(key,value){this.data.set(key,structuredClone(value));}
  async delete(key){this.data.delete(key);}
  async list(){return new Map();}
  transaction(fn){const result=this.pending.then(()=>fn(this));this.pending=result.catch(()=>{});return result;}
}
function fixture(seed={}) {
  const storage=new Storage();
  for(const [key,value] of Object.entries(seed))storage.data.set(key,structuredClone(value));
  const env={ALLOWED_GITHUB_ID:'123456',JAN_PROXY_KEY:'A'.repeat(43),JAN_MULTI_USER_ENABLED:'1'};
  const store=new JanDeviceStore({storage},env);
  const request=()=>new Request('https://internal.invalid/usage/increment',{method:'POST',
    headers:{'Content-Type':'application/json','X-Jan-Account-Id':'123456'},body:'{}'});
  return {storage,store,request};
}

test('tool usage enforces the existing 6000-per-hour account cap atomically',async()=>{
  const now=Date.now();
  const f=fixture({
    'account:owner:v1':'123456',
    'usage:hour:v1':{started:now,count:6000},
    'usage:minute:v1':{started:now,count:0},
    'usage:daily:v1':{started:now,days:{}},
  });
  const response=await f.store.fetch(f.request());
  assert.equal(response.status,429);
  const body=await response.json();
  assert.equal(body.error,'Hourly tool-call rate limit reached');
  assert.ok(Number.isInteger(body.retryAfter)&&body.retryAfter>0);
  assert.equal((await f.storage.get('usage:hour:v1')).count,6000);
  assert.equal(await f.storage.get('calls'),undefined);
});
