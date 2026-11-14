import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {checkoutBinding,verifiedSubscriptionEvent,paddleSubscription,refundableTransaction,cancelPaddleSubscription,refundPaddleTransaction,billingReady,paddleRequest} from '../src/billing.ts';
import {JanDeviceStore} from '../src/device_store.ts';
import {portalPage} from '../src/portal_ui.ts';

const origin='https://billing.example.workers.dev';
const priceId='pri_01m5z5ay4y4kv7dkrcmz7r3s7h';
class Storage {
  entries=new Map();
  async get(key){return structuredClone(this.entries.get(key));}
  async put(key,value){this.entries.set(key,structuredClone(value));}
  async delete(key){this.entries.delete(key);}
  async transaction(callback){return callback(this);}
}
function fixture(){
  const storage=new Storage();
  const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://legacy.example.net',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'test',GITHUB_CLIENT_SECRET:'test',ALLOWED_GITHUB_ID:'1234',JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'public',PADDLE_CLIENT_TOKEN:'test_'+'a'.repeat(27),PADDLE_WEBHOOK_SECRET:'sandbox-webhook-secret',PADDLE_PRICE_ID:priceId};
  const object=new JanDeviceStore({storage},env);
  const hub=new JanDeviceStore({storage:new Storage()},env);
  env.DEVICES={idFromName:id=>id,get:id=>({fetch:(url,init)=>(id===env.ALLOWED_GITHUB_ID?hub:object).fetch(new Request(url,init))})};
  return {storage,env,object};
}
const id='sub_'+'a'.repeat(26);

test('downgrade preserves the selected computer and revokes extra device access',async()=>{
  const f=fixture();await webhook(f.env);
  const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';
  await f.storage.put('devices',{[a]:{id:a,revoked:false,created:1},[b]:{id:b,revoked:false,created:2}});await f.storage.put('active',b);
  assert.equal((await webhook(f.env,{status:'canceled',at:new Date(Date.now()+1000).toISOString(),eventId:'evt_'+'d'.repeat(26)})).status,200);
  const devices=await f.storage.get('devices');
  assert.equal(devices[a].revoked,true);assert.equal(devices[b].revoked,false);
  assert.equal(await f.storage.get('active'),b);
});
test('live billing requires explicit enablement and never falls back to sandbox credentials',async()=>{
  const {env}=fixture();
  assert.equal(billingReady(env),true);
  const live={...env,PADDLE_ENVIRONMENT:'production',PADDLE_CLIENT_TOKEN:'live_'+'a'.repeat(27)};
  assert.equal(billingReady(live),false);
  live.PADDLE_LIVE_ENABLED='1';assert.equal(billingReady(live),true);
  assert.equal(billingReady({...live,PADDLE_CLIENT_TOKEN:env.PADDLE_CLIENT_TOKEN}),false);
  assert.notEqual(await checkoutBinding(env,'5678'),await checkoutBinding(live,'5678'));
  const owner={...live,JAN_SITE_ROLE:'owner',PADDLE_SANDBOX_API_KEY:'sandbox-private'};
  await assert.rejects(()=>paddleRequest(owner,'/subscriptions/'+id),/live API key/i);
  let called=false;
  await paddleRequest({...owner,PADDLE_LIVE_API_KEY:'live-private'},'/subscriptions/'+id,'GET',undefined,async (url,options)=>{
    called=true;assert.equal(url,'https://api.paddle.com/subscriptions/'+id);assert.equal(options.headers.Authorization,'Bearer live-private');return Response.json({data:{id}});
  });
  assert.equal(called,true);
  const html=await portalPage('Checkout','Plan',{checkout:{environment:'production',token:live.PADDLE_CLIENT_TOKEN,priceId,accountId:'5678',binding:'synthetic'}}).text();
  assert.match(html,/Paddle.Initialize/);
  assert.doesNotMatch(html,/Paddle.Environment.set\("sandbox"\)|live-private|sandbox-private/);
});
async function webhook(env,{eventId='evt_'+'a'.repeat(26),status='active',at=new Date().toISOString(),price=priceId,accountId='5678',binding,scheduledChange=null,signature=true,timestamp=Math.floor(Date.now()/1000)}={}){
  const data={event_id:eventId,event_type:'subscription.updated',occurred_at:at,data:{id,status,items:[{price:{id:price}}],scheduled_change:scheduledChange,custom_data:{account_id:accountId,account_binding:binding??await checkoutBinding(env,accountId)}}};
  const raw=JSON.stringify(data),ts=timestamp;
  const h1=createHmac('sha256',env.PADDLE_WEBHOOK_SECRET).update(ts+':'+raw).digest('hex');
  try {
    const event=await verifiedSubscriptionEvent(new Request(origin+'/billing/paddle/webhook',{method:'POST',headers:{'Paddle-Signature':`ts=${ts};h1=${signature?h1:'0'.repeat(64)}`},body:raw}),env);
    if(event)return env.DEVICES.get(env.DEVICES.idFromName(event.accountId)).fetch('https://internal.invalid/billing/subscription',{method:'POST',headers:{'X-Jan-Account-Id':event.accountId},body:JSON.stringify(event)});
    return Response.json({received:true});
  } catch {return Response.json({error:'Webhook denied'},{status:400});}
}
test('only signed Paddle events grant the paying account Pro; stale events and removed prices revoke correctly',async()=>{
  const f=fixture();
  assert.equal((await webhook(f.env,{signature:false})).status,400);
  assert.equal((await webhook(f.env,{timestamp:Math.floor(Date.now()/1000)-60})).status,400);
  assert.equal((await webhook(f.env,{binding:'0'.repeat(64)})).status,400);
  assert.equal(await f.storage.get('billing:subscriptions:v1'),undefined);
  assert.equal((await webhook(f.env)).status,200);
  let subscriptions=await f.storage.get('billing:subscriptions:v1');
  assert.equal(subscriptions[id].status,'active');
  assert.equal((await webhook(f.env,{eventId:'evt_'+'e'.repeat(26),at:new Date(Date.now()+500).toISOString(),scheduledChange:{action:'cancel',effective_at:'2026-11-27T00:00:00Z'}})).status,200);
  assert.equal((await f.storage.get('billing:subscriptions:v1'))[id].cancelAt,'2026-11-27T00:00:00Z');
  assert.equal((await f.object.fetch(new Request('https://internal.invalid/device/list',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:'{}'}))).status,200);
  assert.equal((await (await f.object.fetch(new Request('https://internal.invalid/device/list',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:'{}'}))).json()).plan,'pro');
  const later=new Date(Date.now()+1000).toISOString();
  assert.equal((await webhook(f.env,{eventId:'evt_'+'b'.repeat(26),status:'canceled',at:later})).status,200);
  assert.equal((await webhook(f.env,{eventId:'evt_'+'c'.repeat(26),status:'active'})).status,200);
  subscriptions=await f.storage.get('billing:subscriptions:v1');
  assert.equal(subscriptions[id].status,'canceled');
  const list=await f.object.fetch(new Request('https://internal.invalid/device/list',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:'{}'}));
  assert.equal((await list.json()).plan,'free');
  const after=new Date(Date.now()+2000).toISOString();
  assert.equal((await webhook(f.env,{eventId:'evt_'+'d'.repeat(26),at:after,price:'pri_'+'z'.repeat(26)})).status,200);
  assert.equal((await (await f.object.fetch(new Request('https://internal.invalid/device/list',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:'{}'}))).json()).plan,'free');
});
test('Pro bypasses monthly cap while keeping the minute limit',async()=>{
  const f=fixture();
  const month=new Date().toISOString().slice(0,10);
  await f.storage.put('usage:daily:v1',{started:Date.now(),days:{[month]:15000}});
  const count=()=>f.object.fetch(new Request('https://internal.invalid/usage/increment',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:'{}'}));
  assert.equal((await count()).status,429);
  assert.equal((await webhook(f.env)).status,200);
  assert.equal((await count()).status,200);
  await f.storage.put('usage:minute:v1',{started:Date.now(),count:120});
  assert.equal((await count()).status,429);
});
test('Pro can pair a thirteenth active device while Free cannot',async()=>{
  const f=fixture();
  const devices={};
  for(let n=0;n<12;n++){const id=crypto.randomUUID();devices[id]={id,revoked:false};}
  await f.storage.put('devices',devices);
  const id=crypto.randomUUID(),body={id,ownerId:'5678',name:'Extra PC',login:'member',publicKey:'A'.repeat(124),capabilities:['read'],os:'win32',agentVersion:'0.7.0'};
  const add=()=>f.object.fetch(new Request('https://internal.invalid/device/import',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify(body)}));
  assert.equal((await add()).status,429);
  assert.equal((await webhook(f.env)).status,200);
  assert.equal((await add()).status,200);
  assert.equal(Object.keys(await f.storage.get('devices')).length,13);
});
test('owner Paddle actions require sandbox key, verify refund eligibility, and use exact IDs',async()=>{
  const f=fixture(),sub='sub_'+'q'.repeat(26),txn='txn_'+'r'.repeat(26),calls=[];
  const api=async (url,init)=>{
    calls.push({url,method:init.method,body:init.body,auth:init.headers.Authorization});
    if(url.endsWith('/subscriptions/'+sub))return Response.json({data:{id:sub,status:'active',custom_data:{account_id:'5678'}}});
    if(url.includes('/transactions?'))return Response.json({data:[{id:txn,status:'completed'}]});
    if(url.includes('/adjustments?'))return Response.json({data:[],meta:{pagination:{has_more:false}}});
    if(url.endsWith('/cancel'))return Response.json({data:{id:sub,status:'canceled',scheduled_change:null}});
    if(url.endsWith('/adjustments'))return Response.json({data:{id:'adj_'+'s'.repeat(26),status:'pending_approval'}});
    return Response.json({}, {status:404});
  };
  await assert.rejects(()=>paddleSubscription(f.env,sub,api),/owner Worker/);
  Object.assign(f.env,{JAN_SITE_ROLE:'owner',PADDLE_SANDBOX_API_KEY:'synthetic-sandbox-key'});
  assert.equal((await paddleSubscription(f.env,sub,api)).custom_data.account_id,'5678');
  assert.equal(await refundableTransaction(f.env,sub,api),txn);
  assert.equal((await cancelPaddleSubscription(f.env,sub,true,api)).status,'canceled');
  assert.equal((await refundPaddleTransaction(f.env,txn,'Test refund',api)).status,'pending_approval');
  assert.ok(calls.every(call=>call.url.startsWith('https://sandbox-api.paddle.com/')));
  assert.deepEqual(calls.filter(call=>call.method==='POST').map(call=>JSON.parse(call.body)),[{effective_from:'immediately'},{action:'refund',type:'full',transaction_id:txn,reason:'Test refund'}]);
  assert.ok(calls.every(call=>call.auth==='Bearer synthetic-sandbox-key'));
});
test('refund transaction is locked once per account before requesting Paddle adjustment',async()=>{
  const f=fixture(),subscription='sub_'+'a'.repeat(26),transaction='txn_'+'b'.repeat(26);
  await f.storage.put('billing:subscriptions:v1',{[subscription]:{id:subscription,status:'active',priceId}});
  const lock=()=>f.object.fetch(new Request('https://internal.invalid/billing/refund-lock',{method:'POST',headers:{'X-Jan-Account-Id':'5678'},body:JSON.stringify({id:subscription,transaction})}));
  assert.equal((await lock()).status,200);
  assert.equal((await lock()).status,409);
  assert.equal((await f.storage.get('billing:refund-lock:'+transaction)).subscriptionId,subscription);
});


test('oversized webhook streams stop at the body cap and valid signatures still work',async()=>{
 const {env}=fixture();let emitted=0,canceled=false;
 const body=new ReadableStream({pull(controller){if(emitted===128){controller.close();return;}emitted++;controller.enqueue(new Uint8Array(16384).fill(32));},cancel(){canceled=true;}},{highWaterMark:0});
 const ts=Math.floor(Date.now()/1000);
 const request=new Request(origin+'/billing/paddle/webhook',{method:'POST',duplex:'half',headers:{'Paddle-Signature':`ts=${ts};h1=${'0'.repeat(64)}`},body});
 await assert.rejects(()=>verifiedSubscriptionEvent(request,env),/Body too large|Webhook too large/);
 assert.equal(canceled,true);assert.equal(emitted,3);assert.equal((await webhook(env)).status,200);
});
