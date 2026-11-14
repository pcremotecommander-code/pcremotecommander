import test from 'node:test';
import assert from 'node:assert/strict';
import {JanDeviceStore} from '../src/device_store.ts';
import {portal,digest} from '../src/device_portal.ts';
import {websitePromptStore} from '../src/website_prompts.ts';
import {siteRouteAllowed} from '../src/site_role.ts';

class Storage {
  entries=new Map();
  async get(k){return structuredClone(this.entries.get(k));}
  async put(k,v){this.entries.set(k,structuredClone(v));}
  async delete(k){return this.entries.delete(k);}
  async transaction(fn){return fn(this);}
}

test('owner creates categories and publishes, edits, hides, deletes and restores prompts with safe rendering',async()=>{
  const base='https://prompt-test.example.workers.dev',storage=new Storage();
  const env={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'owner',JAN_MULTI_USER_ENABLED:'1'};
  const object=new JanDeviceStore({storage},env);
  env.DEVICES={idFromName:id=>id,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})};
  const token='T'.repeat(43),csrf='C'.repeat(43);
  await storage.put('session:'+await digest(token),{login:'test-owner',userId:'1234',csrf,expires:Date.now()+60000});
  const call=(path,init={},role='owner')=>portal(new Request(base+path,{...init,headers:{Cookie:'__Host-JanPortal='+token,...init.headers}}),{...env,JAN_SITE_ROLE:role});
  const post=(fields,headers={})=>call('/admin/prompts',{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded',...headers},body:new URLSearchParams({csrf,...fields})});
  const category=crypto.randomUUID(),id=crypto.randomUUID();
  assert.equal(siteRouteAllowed('owner','/admin/prompts'),true);
  assert.equal(siteRouteAllowed('public','/admin/prompts'),false);
  assert.equal((await portal(new Request(base+'/admin/prompts'),env)).status,403);
  assert.equal((await call('/admin/prompts',{},'public')).status,403);
  assert.equal((await websitePromptStore(storage,'/website-prompts/list',{},'9876','1234')).status,403);
  assert.equal((await post({action:'category-add',id:category,name:'Research'})).status,303);
  const fields={action:'save',id,title:'Synthetic test prompt',description:'An owner-created task',category,prompt:'</textarea><script>alert(1)</script>',published:'yes'};
  assert.equal((await post({...fields,csrf:'wrong'})).status,403);
  assert.equal((await post(fields,{Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await post({...fields,prompt:'x'.repeat(3001)})).status,400);
  assert.equal((await post({...fields,category:'unknown'})).status,400);
  assert.equal((await post(fields)).status,303);
  const read=async()=> (await call('/library/prompts',{},'public')).json();
  assert.equal((await read()).prompts[0].title,fields.title);
  assert.equal((await read()).categories.at(-1).name,'Research');
  const html=await (await call('/admin/prompts?edit='+id)).text();
  assert.ok(html.includes('&#60;/textarea&#62;&#60;script&#62;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.equal((await post({...fields,title:'Updated title'})).status,303);
  assert.equal((await read()).prompts.length,1);
  assert.equal((await read()).prompts[0].title,'Updated title');
  assert.equal((await post({action:'visibility',id,published:'no'})).status,303);
  assert.equal((await read()).prompts.length,0);
  assert.equal((await post({action:'visibility',id,published:'yes'})).status,303);
  assert.equal((await post({action:'delete',id})).status,303);
  assert.equal((await read()).prompts.length,0);
  assert.equal((await post({action:'visibility',id,published:'yes'})).status,409);
  assert.equal((await post({action:'restore',id})).status,303);
  assert.equal((await read()).prompts.length,0);
  assert.equal((await post({action:'visibility',id,published:'yes'})).status,303);
  assert.equal((await read()).prompts.length,1);
  assert.equal((await call('/library/prompts',{},'owner')).status,404);
  assert.equal((await call('/library/prompts?anything=1',{},'public')).status,404);
});
