import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {JanDeviceStore} from '../src/device_store.ts';
import {portal,digest} from '../src/device_portal.ts';
import {proxyMcp,registerDeviceOrigin,deviceKey} from '../src/policy.ts';

const origin='https://jan-gateway.example.workers.dev';
class Storage {
  async setAlarm(){}
  entries=new Map();
  async get(key){return this.entries.get(key);}
  async put(key,value){this.entries.set(key,value);}
  async delete(key){this.entries.delete(key);}
  async transaction(callback){return callback(this);}
}
function fixture() {
  const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://legacy.trycloudflare.com',
    JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClientId',
    GITHUB_CLIENT_SECRET:'synthetic-secret-for-tests',ALLOWED_GITHUB_ID:'1234',JAN_AUTO_ORIGIN:'1'};
  const object=new JanDeviceStore({storage:new Storage()},env);
  return {...env,DEVICES:{idFromName:id=>id,get:()=>({fetch:(input,init)=>object.fetch(input instanceof Request?input:new Request(input,init))})}};
}
const request=(path,method='GET',headers={},body)=>new Request(origin+path,{method,headers,body});
const form=(path,cookie,csrf,id)=>request(path,'POST',{'Origin':origin,'Cookie':cookie,'Content-Type':'application/x-www-form-urlencoded'},new URLSearchParams({csrf,...(id?{id}:{}),...(path==='/devices/revoke'?{confirmation:'revoke'}:{})}));
test('owner sign-in issues a bound device code; claim is single-use and credentials stay off HTML',async()=>{
  const env=fixture();
  const start=await portal(request('/devices/login'),env);
  assert.equal(start.status,302);
  const destination=new URL(start.headers.get('Location'));
  assert.equal(destination.hostname,'github.com');
  assert.equal(destination.searchParams.get('redirect_uri'),origin+'/callback');
  const state=destination.searchParams.get('state');
  const provider=async url=>url.includes('access_token')?Response.json({access_token:'test-only-github-token'}):Response.json({id:1234,login:'test-owner'});
  const loginCookie=start.headers.get('Set-Cookie').split(';')[0];
  const callback=await portal(request('/callback?state='+state+'&code=test-code','GET',{'Cookie':loginCookie}),env,provider);
  assert.equal(callback.status,302);
  const cookie=callback.headers.get('Set-Cookie').split(';')[0];
  assert.ok(!cookie.includes('test-only-github-token'));
  assert.equal((await portal(request('/callback?state='+state+'&code=test-code','GET',{'Cookie':loginCookie}),env,provider)).status,403);
  const page=await (await portal(request('/devices','GET',{'Cookie':cookie}),env)).text();
  assert.match(page,/data-call-count>0</);
  const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(page)?.[1];
  assert.ok(csrf);
  assert.equal((await portal(form('/devices/new',cookie,'wrong'),env)).status,403);
  assert.equal((await portal(request('/devices/new','POST',{'Cookie':cookie,'Content-Type':'application/x-www-form-urlencoded'},new URLSearchParams({csrf:'wrong'})),env)).status,403);
  const offer=await (await portal(form('/devices/new',cookie,csrf),env)).text();
  assert.match(offer,/cd \/d/);
  assert.match(offer,/npx --offline --yes \.\/deploy\/npm\/jan-commander remote --enroll/);
  const code=/<code>([A-Za-z0-9_-]{43})<\/code>/.exec(offer)?.[1];
  assert.ok(code);
  const claim=async value=>portal(request('/devices/claim','POST',{'Content-Type':'application/json'},JSON.stringify({code:value,name:'Laptop Two'})),env);
  assert.notEqual((await claim('B'.repeat(43))).status,200);
  const paired=await (await claim(code)).json();
  assert.equal(paired.name,'Laptop Two');
  assert.equal(paired.login,'test-owner');
  assert.equal(paired.owner_id,'1234');
  assert.equal(paired.key,await deviceKey(env.JAN_PROXY_KEY,paired.id));
  assert.notEqual((await claim(code)).status,200);
  assert.ok(!(await (await portal(request('/devices','GET',{'Cookie':cookie}),env)).text()).includes(paired.key));
  assert.equal((await portal(form('/devices/revoke',cookie,csrf,paired.id),env)).status,303);
  assert.equal((await portal(form('/devices/select',cookie,csrf,paired.id),env)).status,404);
  assert.equal((await claim(code)).status,403);
});
test('non-owner GitHub identity cannot create an owner session',async()=>{
  const env=fixture();
  const start=await portal(request('/devices/login'),env);
  const state=new URL(start.headers.get('Location')).searchParams.get('state');
  const provider=async url=>url.includes('access_token')?Response.json({access_token:'test-only-token'}):Response.json({id:9876,login:'other-user'});
  const callback=await portal(request('/callback?state='+state+'&code=other','GET',{'Cookie':start.headers.get('Set-Cookie').split(';')[0]}),env,provider);
  assert.equal(callback.status,403);
  assert.match(await callback.text(),/This account does not have access yet/);
  assert.ok(!callback.headers.get('Set-Cookie').includes('__Host-JanPortal='));
});
test('device signatures route only the selected device and count authenticated tool calls',async()=>{
  const env=fixture(),id='12345678-1234-1234-1234-123456789abc',id2='12345678-1234-1234-1234-123456789abd';
  for(const name of [id,id2]) {
    const code='C'.repeat(42)+(name===id?'A':'B');
    const stub=env.DEVICES.get();
    await stub.fetch(request('/pair/create','POST',{'Content-Type':'application/json'},JSON.stringify({hash:await digest(code),login:'owner'})));
    const response=await stub.fetch(request('/pair/claim','POST',{'Content-Type':'application/json'},JSON.stringify({hash:await digest(code),name:'Device',id:name})));
    assert.equal(response.status,200);
  }
  const before=(await (await env.DEVICES.get().fetch(request('/device/active','POST',{'Content-Type':'application/json'},'{}'))).json());
  assert.equal(before.enrolled,false); // First registration switches from the running legacy origin.
  const now=Math.floor(Date.now()/1000),tunnel='https://laptop-two.trycloudflare.com';
  const key=await deviceKey(env.JAN_PROXY_KEY,id);
  const signature=createHmac('sha256',key).update(`JAN_ORIGIN_V3\n1234\n${id}\n${now}\n${tunnel}`).digest('hex');
  const payload={device_id:id,owner_id:'1234',origin:tunnel,timestamp:now,signature};
  const registration=value=>registerDeviceOrigin(request('/jan-device-origin','POST',{'Content-Type':'application/json'},JSON.stringify(value)),env,now);
  assert.equal((await registration({...payload,signature:'0'.repeat(64)})).status,403);
  assert.equal((await registration({...payload,owner_id:'9876'})).status,403);
  assert.equal((await registration(payload)).status,200);
  const after=(await (await env.DEVICES.get().fetch(request('/device/active','POST',{'Content-Type':'application/json'},'{}'))).json());
  assert.equal(after.enrolled,true);
  assert.equal(after.device.id,id);
  assert.equal((await registration(payload)).status,403);
  let calls=0;
  const auth={audience:origin+'/mcp',scope:['jan:read','jan:control'],userId:'1234'};
  const mcp=request('/mcp','POST',{'Content-Type':'application/json'},JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'jan_status',arguments:{}}}));
  const result=await proxyMcp(mcp,env,auth,{githubId:'1234'},async(url,options)=>{
    calls++;assert.equal(url,tunnel+'/mcp');assert.equal(options.headers.get('Authorization'),'Bearer '+key);
    return Response.json({jsonrpc:'2.0',id:1,result:{ok:true}});
  });
  assert.equal(result.status,200);assert.equal(calls,1);
  const state=await (await env.DEVICES.get().fetch(request('/device/list','POST',{'Content-Type':'application/json'},'{}'))).json();
  assert.equal(state.calls,1);
  const invalid=request('/mcp','POST',{'Content-Type':'application/json','MCP-Protocol-Version':'invalid'},JSON.stringify({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'jan_status'}}));
  assert.equal((await proxyMcp(invalid,env,auth,{githubId:'1234'},()=>assert.fail('Bad header reached origin'))).status,400);
  assert.equal((await (await env.DEVICES.get().fetch(request('/device/list','POST',{'Content-Type':'application/json'},'{}'))).json()).calls,1);
  // Selecting an offline device must fail closed, never fall back to the legacy origin.
  await env.DEVICES.get().fetch(request('/device/select','POST',{'Content-Type':'application/json'},JSON.stringify({id:id2})));
  assert.equal((await proxyMcp(request('/mcp','POST',{'Content-Type':'application/json'},JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'jan_status',arguments:{}}})),env,auth,{githubId:'1234'},()=>assert.fail('Offline device reached'))).status,200);
  assert.equal(calls,1);
  await env.DEVICES.get().fetch(request('/device/revoke','POST',{'Content-Type':'application/json'},JSON.stringify({id})));
  assert.equal((await registration({...payload,timestamp:now+1,signature:createHmac('sha256',key).update(`JAN_ORIGIN_V3\n1234\n${id}\n${now+1}\n${tunnel}`).digest('hex')})).status,403);
});
