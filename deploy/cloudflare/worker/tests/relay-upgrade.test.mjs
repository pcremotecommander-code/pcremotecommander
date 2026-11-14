import test from 'node:test';
import assert from 'node:assert/strict';
import {JanRelayUpgrade} from '../src/relay_upgrade.ts';
const relay=new JanRelayUpgrade({ALLOWED_GITHUB_ID:'12345678',JAN_PROXY_KEY:'a'.repeat(43)});
const endpoint='https://internal.invalid/relay/connect';
test('relay upgrade denies plain HTTP without a socket handshake',async()=>{
  const r=await relay.handle(new Request(endpoint),async()=>true);
  assert.equal(r.status,426);
});
test('relay upgrade rejects absent, malformed and unsigned device proof',async()=>{
  const headers={Upgrade:'websocket',Connection:'Upgrade'};
  const denied=await relay.handle(new Request(endpoint,{headers}),async()=>true);
  assert.equal(denied.status,403);
  const bad=await relay.handle(new Request(endpoint,{headers:{...headers,'x-jan-device-proof':'{}'}}),async()=>true);
  assert.equal(bad.status,403);
});
test('relay upgrade never accepts missing origin approval',async()=>{
  const headers={Upgrade:'websocket',Connection:'Upgrade','x-jan-device-proof':JSON.stringify({owner_id:'12345678',device_id:'c3e35d88-9749-4af8-8c13-0d097e89f77b',timestamp:Math.floor(Date.now()/1000),nonce:'x'.repeat(24),signature:'a'.repeat(64)})};
  const r=await relay.handle(new Request(endpoint,{headers}),async()=>false);
  assert.equal(r.status,403);
});


test('revocation during shared admission releases slot and never opens a socket',async()=>{
 const {createHmac,randomUUID,randomBytes}=await import('node:crypto');
 const account='12345678',device=randomUUID(),master='a'.repeat(43),timestamp=Math.floor(Date.now()/1000),nonce=randomBytes(24).toString('base64url');
 const key=createHmac('sha256',master).update('JAN_DEVICE_KEY_V1\n'+device).digest('base64url');
 const signature=createHmac('sha256',key).update(['JAN_RELAY_WS_V1',account,device,String(timestamp),nonce].join('\n')).digest('hex');
 const actions=[];const env={ALLOWED_GITHUB_ID:account,JAN_PROXY_KEY:master,DEVICES:{idFromName:n=>n,get:()=>({fetch:async(u,i)=>{
  const body=JSON.parse(i.body);actions.push(body.action);
  return body.action==='acquire'?Response.json({expires:Date.now()+60000}):new Response(null,{status:204});
 }})}};
 const upgrade=new JanRelayUpgrade(env);let checks=0;
 const response=await upgrade.handle(new Request(endpoint,{headers:{Upgrade:'websocket',Connection:'Upgrade',
  'X-JAN-Device-Proof':JSON.stringify({owner_id:account,device_id:device,timestamp,nonce,signature})}}),async()=>++checks<3,async()=>true);
 assert.equal(response.status,403);assert.deepEqual(actions,['acquire','release']);assert.equal(upgrade.getSession(device),null);
});
