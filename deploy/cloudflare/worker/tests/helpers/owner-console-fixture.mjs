import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {JanDeviceStore} from '../../src/device_store.ts';
import {portal,digest} from '../../src/device_portal.ts';
import {totpCode} from '../../src/owner_security.ts';

export class OwnerTestStorage {
  entries=new Map();queue=Promise.resolve();async setAlarm(){}
  async get(k){return structuredClone(this.entries.get(k));}async put(k,v){this.entries.set(k,structuredClone(v));}async delete(k){return this.entries.delete(k);}
  async list({prefix='',startAfter='',limit=1000}={}){return new Map([...this.entries].filter(([k])=>k.startsWith(prefix)&&k>startAfter).sort(([a],[b])=>a<b?-1:1).slice(0,limit));}
  transaction(fn){const result=this.queue.then(()=>fn(this));this.queue=result.catch(()=>{});return result;}
}
export async function ownerFixture(overrides={}){
  const origin='https://owner-console.example.workers.dev',objects=new Map(),storages=new Map();
  const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticOwnerClientId',GITHUB_CLIENT_SECRET:'synthetic-owner-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'owner',JAN_PAIRING_ENABLED:'1',PADDLE_PRICE_ID:'pri_'+'a'.repeat(26)};
  Object.assign(env,overrides);
  env.DEVICES={idFromName:id=>id,get:id=>{if(!objects.has(id)){const storage=new OwnerTestStorage();storages.set(id,storage);objects.set(id,new JanDeviceStore({storage},{...env,JAN_SITE_ROLE:'public',DEVICES:env.DEVICES}));}return {fetch:(url,init)=>objects.get(id).fetch(new Request(url,init))};}};
  const callStore=async(path,body={},account='1234',extra={})=>{const response=await env.DEVICES.get(account).fetch('https://internal.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':account,...extra},body:JSON.stringify(body)});return response;};
  await callStore('/directory/register',{id:'1234',login:'pcrc-owner'});
  const token='T'.repeat(43),csrf='C'.repeat(43);
  await callStore('/session/create',{hash:await digest(token),login:'pcrc-owner',csrf,userId:'1234',ownerOrigin:origin,ownerLoginAt:Date.now()});
  const request=(path,init={},fetcher)=>portal(new Request(origin+path,{...init,headers:{Cookie:'__Host-JanPortal='+token,...init.headers}}),env,fetcher);
  const post=(path,values={})=>request(path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...values})});
  const binding=createHash('sha256').update('PCRC_OWNER_SESSION_V1\n'+csrf).digest('hex');
  return {env,origin,storages,objects,token,csrf,binding,request,post,callStore};
}
export async function unlockOwner(f){
  const setup=await (await f.callStore('/owner-auth/enroll',{session:f.binding,recent:true})).json();
  const code=await totpCode(setup.secret,Math.floor(Date.now()/30000));
  const response=await f.post('/admin/security/verify',{code});assert.equal(response.status,200);return {secret:setup.secret,response};
}


export async function prepareOwnerSession(storage,env,token,csrf){
  const {openRecord,sealRecord}=await import('../../src/secure_store.ts');
  const {ownerSecurityStore}=await import('../../src/owner_security.ts');
  const key='session:'+await digest(token),record=await storage.get(key);
  assert.ok(record,'Synthetic owner session must already exist');
  const details=record.v===1?await openRecord(env.JAN_PROXY_KEY,env.ALLOWED_GITHUB_ID,'portal-session',record):record;
  assert.equal(details.userId??env.ALLOWED_GITHUB_ID,env.ALLOWED_GITHUB_ID);
  await storage.put(key,await sealRecord(env.JAN_PROXY_KEY,env.ALLOWED_GITHUB_ID,'portal-session',{...details,ownerOrigin:env.JAN_PUBLIC_ORIGIN,ownerLoginAt:Date.now()},record.expires));
  const binding=createHash('sha256').update('PCRC_OWNER_SESSION_V1\n'+csrf).digest('hex');
  const setup=await (await ownerSecurityStore('/owner-auth/enroll',{session:binding,recent:true},storage,env,env.ALLOWED_GITHUB_ID)).json();
  const response=await ownerSecurityStore('/owner-auth/verify',{session:binding,recent:true,code:await totpCode(setup.secret,Math.floor(Date.now()/30000))},storage,env,env.ALLOWED_GITHUB_ID);
  assert.equal(response.status,200);
}
