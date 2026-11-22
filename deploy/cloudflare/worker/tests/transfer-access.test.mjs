import assert from 'node:assert/strict';
import {generateKeyPairSync, randomUUID, sign} from 'node:crypto';
import test from 'node:test';
import {JanDeviceStore as PCRCDeviceStore} from '../src/device_store.ts';
import {checkTransferRequest} from '../src/transfer_access.ts';

test('transfer requires both current, same-account enrollments and signatures',async()=>{
  const account='1234', other='5678',source=randomUUID(),destination=randomUUID();
  const session='e'.repeat(64),timestamp=Math.floor(Date.now()/1000);
  const devices={},online=new Set([source,destination]);
  const proof={owner_id:account,source,destination,session,timestamp};
  for(const [id,role] of [[source,'sender'],[destination,'receiver']]){
    const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
    devices[id]={ownerId:account,publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64url'),capabilities:['read','control','files']};
    const message=['PCRC_LAN_TRANSFER_V1',account,source,destination,session,String(timestamp)].join('\n');
    proof[role]=sign('sha256',Buffer.from(message),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  }
  const data=new Map([['devices',devices]]);
  const storage={get:async key=>structuredClone(data.get(key)),put:async (key,value)=>data.set(key,value),transaction:async fn=>fn(storage)};
  const store=new PCRCDeviceStore({storage},{ALLOWED_GITHUB_ID:account,JAN_MULTI_USER_ENABLED:'1'});
  store.relay.getSession=id=>online.has(id)?{online:true}:null;
  const origin='https://transfer.example.workers.dev';
  const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://fixture.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),
    GITHUB_CLIENT_ID:'test_client',GITHUB_CLIENT_SECRET:'fixture-secret-not-real',ALLOWED_GITHUB_ID:account,
    JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'public',
    DEVICES:{idFromName:id=>id,get:id=>({fetch:(url,options)=>{
      if(new URL(url).pathname==='/abuse/check')return new Response(null,{status:204});
      assert.equal(options.headers['X-Jan-Account-Id'],id);
      return store.fetch(new Request(url,options));
    }})},
  };
  const verify=(value=proof)=>checkTransferRequest(new Request(origin+'/device-transfer/verify',{
    method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify(value),
  }),env);
  assert.equal((await verify()).status,204);
  assert.equal((await verify({...proof,owner_id:other})).status,403);
  assert.equal((await verify({...proof,padding:'x'.repeat(1100)})).status,413);
  assert.equal((await verify(null)).status,403);
  assert.equal((await verify({...proof,session:'d'.repeat(64)})).status,403);
  assert.equal((await verify({...proof,timestamp:timestamp-61})).status,403);
  assert.equal((await verify({...proof,sender:proof.receiver})).status,403);
  online.delete(destination);
  assert.equal((await verify()).status,403);
  online.add(destination);
  devices[destination].ownerId=other;
  assert.equal((await verify()).status,403);
  devices[destination].ownerId=account;
  devices[destination].revoked=true;
  assert.equal((await verify()).status,403);
  devices[destination].revoked=false;
  devices[destination].capabilities=['read'];
  assert.equal((await verify()).status,403);
});
