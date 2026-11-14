import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomBytes} from 'node:crypto';
import {pairingStore,pairingProof} from '../src/pairing.ts';
import {RelayHandshakeVerifier} from '../src/relay_handshake.ts';
import {deviceKey} from '../src/policy.ts';
import {signHandshake} from '../src/relay_handshake.ts';
import {dispatchSelected} from '../src/relay_dispatch.ts';
import {portal,digest} from '../src/device_portal.ts';
import {JanDeviceStore} from '../src/device_store.ts';
import {verificationPage} from '../src/portal_ui.ts';

const origin='https://pairing.example.workers.dev';
const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://old.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),ALLOWED_GITHUB_ID:'1234',GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',JAN_PAIRING_ENABLED:'1'};
class Storage {
  entries=new Map();queue=Promise.resolve();
  async get(k){return structuredClone(this.entries.get(k));}
  async put(k,v){this.entries.set(k,structuredClone(v));}
  async delete(k){return this.entries.delete(k);}
  transaction(fn){const next=this.queue.then(()=>fn(this));this.queue=next.catch(()=>{});return next;}
}
function fixture() {
  const storage=new Storage();let now=Date.now();
  const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const publicKey=keys.publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const call=(path,body)=>pairingStore('/pairing/'+path,body,storage,env,now);
  const start=(capabilities)=>call('start',{publicKey,name:'Test PC',os:'Windows',agentVersion:'0.7.0-rc.1',...(capabilities?{capabilities}:{})});
  const prove=(pair,action='status',key=keys.privateKey)=>{
    const nonce=randomBytes(32).toString('base64url');
    return {id:pair.id,action,nonce,timestamp:now,signature:sign('sha256',Buffer.from(pairingProof(origin,pair.id,action,pair.challenge,nonce,now)),{key,dsaEncoding:'ieee-p1363'}).toString('base64url')};
  };
  return {storage,keys,publicKey,call,start,prove,tick:(ms=1100)=>{now+=ms;}};
}

test('noncanonical base64url cannot create another binding for the same installation key',async()=>{
  const f=fixture(),multi={...env,JAN_MULTI_USER_ENABLED:'1'};
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const alias=f.publicKey.slice(0,-1)+alphabet[alphabet.indexOf(f.publicKey.at(-1))^1];
  assert.deepEqual(Buffer.from(alias,'base64url'),Buffer.from(f.publicKey,'base64url'));
  const start=key=>pairingStore('/pairing/start',{publicKey:key,name:'Same key',os:'Windows',agentVersion:'test',clientKey:'a'.repeat(43),browserChoice:true},f.storage,multi);
  assert.equal((await start(f.publicKey)).status,201);
  assert.equal((await start(alias)).status,400,'an alternate encoding must not bypass the account binding');
  for(const extra of [1,2,3])assert.equal((await start(Buffer.concat([Buffer.from(f.publicKey,'base64url'),Buffer.alloc(extra)]).toString('base64url'))).status,400,'trailing DER bytes must not create another identity');
});

test('a downgrade disables shared secondary access and stale Pro snapshots cannot undo it',async()=>{
  const f=fixture(),multi={...env,JAN_MULTI_USER_ENABLED:'1'};
  await f.storage.put('pairing:key-owner:v1:'+f.publicKey,['5678','9012']);
  const call=(path,body)=>pairingStore('/pairing/'+path,body,f.storage,multi);
  const state=(ownerId,pro,revision)=>call('plan',{ownerId,pro,revision});
  const access=ownerId=>call('access',{ownerId,publicKey:f.publicKey,pro:ownerId==='9012',revision:ownerId==='9012'?1:2});
  await state('5678',true,1);await state('9012',true,1);
  assert.equal((await (await access('9012')).json()).allowed,true);
  await state('5678',false,2);await state('5678',true,1);
  assert.equal((await (await access('9012')).json()).allowed,false);
  assert.equal((await (await access('5678')).json()).allowed,true,'the original account keeps its installation');
  const offer=await (await call('start',{publicKey:f.publicKey,name:'Shared PC',os:'Windows',agentVersion:'test',clientKey:'a'.repeat(43),browserChoice:true,reconnectOwnerId:'9012'})).json();
  assert.equal((await call('view',{id:offer.id,ownerId:'9012'})).status,402,'a secondary Free account cannot re-enroll to bypass its downgrade');
});

test('a previously approved installation key stays bound after a fresh pairing request',async()=>{
  const f=fixture(),multi={...env,JAN_MULTI_USER_ENABLED:'1'};
  const call=(path,body)=>pairingStore('/pairing/'+path,body,f.storage,multi);
  const start=()=>call('start',{publicKey:f.publicKey,name:'Same PC',os:'Windows',agentVersion:'test',clientKey:'a'.repeat(43),browserChoice:true});
  const a=await (await start()).json();
  await call('proof',f.prove(a));
  assert.equal((await call('decide',{id:a.id,ownerId:'5678',login:'first-owner',decision:'approve',codesMatch:true,capabilities:[]})).status,200);
  const b=await (await start()).json();
  const wrong=await call('view',{id:b.id,ownerId:'9012'});
  assert.equal(wrong.status,403,'a fresh code must not move the existing installation to another account');
  assert.equal((await call('view',{id:b.id,ownerId:'5678'})).status,200);
  await call('proof',f.prove(b));
  assert.equal((await call('decide',{id:b.id,ownerId:'9012',login:'other',decision:'approve',codesMatch:true,capabilities:[]})).status,403);
});

test('browser-choice pairing displays a matching code and bounds the website-selected permissions',async()=>{
  const f=fixture(),multi={...env,JAN_MULTI_USER_ENABLED:'1'};
  const call=(path,body)=>pairingStore('/pairing/'+path,body,f.storage,multi);
  const start=await call('start',{publicKey:f.publicKey,name:'Browser choice PC',os:'Windows',agentVersion:'beta7',clientKey:'a'.repeat(43),capabilities:['files','commands'],browserChoice:true});
  assert.equal(start.status,201);
  const pair=await start.json();
  const view=await (await call('view',{id:pair.id,ownerId:'5678'})).json();
  assert.equal(view.code,pair.code);assert.equal(view.browserChoice,true);
  await call('proof',f.prove(pair));
  const decide=(caps,match=true)=>call('decide',{id:pair.id,ownerId:'5678',decision:'approve',login:'synthetic',capabilities:caps,codesMatch:match,selectForAi:true});
  assert.equal((await decide(['files'],false)).status,403);
  assert.equal((await decide(['desktop'])).status,403,'website cannot exceed the local offer');
  assert.equal((await decide(['files','files'])).status,400);
  assert.equal((await decide(['files'])).status,200);
  const stored=Object.values(await f.storage.get('pairing:v1'))[0];
  assert.deepEqual(stored.capabilities,['read','control','files']);
  assert.equal(stored.selectForAi,true);
  const html=await verificationPage(view,{login:'synthetic',csrf:'synthetic'},true).text();
  assert.match(html,new RegExp(pair.code));assert.doesNotMatch(html,/name="codes_match"/);
  assert.match(html,/name="access"/);assert.match(html,/name="access" value="control"/);assert.doesNotMatch(html,/type="radio"/);assert.doesNotMatch(html,/name="confirmation_code"/);
});
test('pairing requires possession, account ownership and explicit approval; collecting is idempotent',async()=>{
  const f=fixture(),p=await (await f.start()).json();
  assert.match(p.code,/^\d{3} \d{3}$/);assert.match(p.id,/^[A-Za-z0-9_-]{43}$/);
  const decide=ownerId=>f.call('decide',{id:p.id,ownerId,decision:'approve',login:'owner'});
  assert.equal((await decide('1234')).status,409);
  assert.equal((await f.call('proof',f.prove(p))).status,200);
  assert.equal((await f.call('view',{id:p.id,ownerId:'9999'})).status,403);
  assert.equal((await decide('9999')).status,403);
  assert.equal((await decide('1234')).status,200);
  assert.equal((await decide('1234')).status,409);
  f.tick();
  const first=await (await f.call('proof',f.prove(p,'collect'))).json();
  assert.equal(first.status,'consumed');assert.equal(first.session.owner_id,'1234');assert.equal(first.session.protocol,2);
  assert.deepEqual(first.session.capabilities,['read']);assert.equal(first.key,undefined);
  f.tick();assert.deepEqual(await (await f.call('proof',f.prove(p,'collect'))).json(),first);
  assert.equal(Object.keys(await f.storage.get('devices')).length,1);
  const records=await f.storage.get('devices');records[first.session.id].revoked=true;await f.storage.put('devices',records);f.tick();
  assert.equal((await f.call('proof',f.prove(p,'collect'))).status,403);
});
test('control capabilities are explicit, immutable through approval and never inferred from the code',async()=>{
  const f=fixture();
  for(const bad of [['all'],['files','files'],['read'],['commands','admin']])assert.equal((await f.start(bad)).status,400);
  const p=await (await f.start(['files','commands'])).json();
  assert.deepEqual(p.capabilities,['read','control','commands','files']);
  assert.equal((await f.call('proof',f.prove(p))).status,200);
  const viewed=await (await f.call('view',{id:p.id,ownerId:'1234'})).json();
  assert.deepEqual(viewed.capabilities,p.capabilities);
  assert.equal((await f.call('decide',{id:p.id,ownerId:'1234',decision:'approve',login:'owner',capabilities:['read']})).status,200);
  f.tick();const approved=await (await f.call('proof',f.prove(p,'collect'))).json();
  assert.deepEqual(approved.session.capabilities,p.capabilities);
  assert.deepEqual((await f.storage.get('devices'))[approved.session.id].capabilities,p.capabilities);
});
test('display code alone, wrong key, altered action, replay and excessive attempts never enroll',async()=>{
  const f=fixture(),p=await (await f.start()).json();
  assert.equal((await f.call('proof',{id:p.code})).status,404);
  const valid=f.prove(p);assert.equal((await f.call('proof',valid)).status,200);
  f.tick();assert.equal((await f.call('proof',valid)).status,403);
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey;
  assert.equal((await f.call('proof',f.prove(p,'collect',other))).status,403);
  assert.equal((await f.call('proof',{...f.prove(p),action:'collect'})).status,403);
  for(let i=0;i<3;i++) assert.equal((await f.call('proof',{...f.prove(p),signature:'x'.repeat(86)})).status,403);
  assert.equal((await f.call('proof',f.prove(p))).status,403);
  assert.equal(await f.storage.get('devices'),undefined);
});
test('rejection, cancellation, expiration and concurrent devices retain separate outcomes',async()=>{
  const f=fixture(),a=await (await f.start()).json(),b=await (await f.start()).json(),c=await (await f.start()).json();
  assert.notEqual(a.id,b.id);assert.notEqual(a.challenge,b.challenge);
  await f.call('proof',f.prove(a));await f.call('proof',f.prove(b));
  assert.equal((await f.call('decide',{id:a.id,ownerId:'1234',decision:'reject',login:'owner'})).status,200);
  f.tick();assert.equal((await (await f.call('proof',f.prove(a,'collect'))).json()).status,'rejected');
  assert.equal((await (await f.call('proof',f.prove(b,'cancel'))).json()).status,'cancelled');
  assert.equal((await f.call('decide',{id:b.id,ownerId:'1234',decision:'approve',login:'owner'})).status,409);
  f.tick(300001);assert.equal((await f.call('proof',f.prove(c))).status,410);
  assert.equal((await f.call('decide',{id:c.id,ownerId:'1234',decision:'approve',login:'owner'})).status,409);
});
test('durable start quota, polling pace and opt-in gate fail closed',async()=>{
  const f=fixture();
  for(let i=0;i<10;i++) assert.equal((await f.start()).status,201);
  assert.equal((await f.start()).status,429);
  const pair=Object.values(await f.storage.get('pairing:v1'))[0];
  assert.equal((await f.call('proof',f.prove(pair))).status,200);
  assert.equal((await f.call('proof',f.prove(pair))).status,429);
  assert.equal((await pairingStore('/pairing/start',{},f.storage,{...env,JAN_PAIRING_ENABLED:'0'})).status,404);
});
test('multi-user pairing enforces a durable client limit without storing network addresses',async()=>{
  const f=fixture(),multi={...env,JAN_MULTI_USER_ENABLED:'1'},now=Date.now();
  const start=clientKey=>pairingStore('/pairing/start',{publicKey:f.publicKey,name:'Test PC',os:'Windows',agentVersion:'test',clientKey},f.storage,multi,now);
  assert.equal((await start('invalid')).status,400);
  for(let i=0;i<5;i++)assert.equal((await start('a'.repeat(43))).status,201);
  assert.equal((await start('a'.repeat(43))).status,429);
  assert.equal((await start('b'.repeat(43))).status,201);
  const rates=await f.storage.get('pairing:client-rates:v1');
  assert.deepEqual(Object.keys(rates).sort(),['a'.repeat(43),'b'.repeat(43)]);
  assert.equal(JSON.stringify(rates).includes('127.0.0.1'),false);
  assert.equal((await start('a'.repeat(43))).status,429);
});
test('racing approvals and collections create exactly one device',async()=>{
  const f=fixture(),p=await (await f.start()).json();await f.call('proof',f.prove(p));
  const decide=()=>f.call('decide',{id:p.id,ownerId:'1234',decision:'approve',login:'owner'});
  assert.deepEqual((await Promise.all([decide(),decide()])).map(r=>r.status),[200,409]);f.tick();
  const responses=await Promise.all([f.call('proof',f.prove(p,'collect')),f.call('proof',f.prove(p,'collect'))]);
  assert.deepEqual(responses.map(r=>r.status),[200,429]);assert.equal(Object.keys(await f.storage.get('devices')).length,1);
});
test('new public-key relay handshake verifies signatures, rejects downgrade, wrong owner and replay',async()=>{
  const f=fixture(),id=crypto.randomUUID(),now=Math.floor(Date.now()/1000),nonce=randomBytes(24).toString('base64url');
  const p={device_id:id,owner_id:'1234',timestamp:now,nonce,protocol:2};
  p.signature=sign('sha256',Buffer.from(['JAN_RELAY_WS_V2','1234',id,String(now),nonce].join('\n')),{key:f.keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const verifier=new RelayHandshakeVerifier(),allowed=async()=>f.publicKey;
  assert.equal(await verifier.verify({...p,owner_id:'9999'},'1234',env.JAN_PROXY_KEY,allowed),false);
  assert.equal(await verifier.verify({...p,nonce:'y'.repeat(24)},'1234',env.JAN_PROXY_KEY,allowed),false);
  assert.equal(await verifier.verify(p,'1234',env.JAN_PROXY_KEY,allowed),true);
  assert.equal(await verifier.verify(p,'1234',env.JAN_PROXY_KEY,allowed),false);
  const legacy={device_id:id,owner_id:'1234',timestamp:now,nonce:'z'.repeat(24)};
  legacy.signature=await signHandshake(await deviceKey(env.JAN_PROXY_KEY,id),legacy);
  assert.equal(await verifier.verify(legacy,'1234',env.JAN_PROXY_KEY,allowed),false);
});
test('signed relay lease cannot be lengthened or exceed eight hours',async()=>{
  const f=fixture(),id=crypto.randomUUID(),now=Math.floor(Date.now()/1000),nonce=randomBytes(24).toString('base64url');
  const request={device_id:id,owner_id:'1234',timestamp:now,nonce,protocol:3,lease_seconds:600};
  const signature=sign('sha256',Buffer.from(['JAN_RELAY_WS_V3','1234',id,String(now),nonce,'600'].join('\n')),{key:f.keys.privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const verifier=new RelayHandshakeVerifier(),allowed=async()=>f.publicKey;
  assert.equal(await verifier.verify({...request,signature,lease_seconds:28800},'1234',env.JAN_PROXY_KEY,allowed),false);
  assert.equal(await verifier.verify({...request,signature,lease_seconds:28801},'1234',env.JAN_PROXY_KEY,allowed),false);
  assert.equal(await verifier.verify({...request,signature},'1234',env.JAN_PROXY_KEY,allowed),true);
});
test('device-approved read capability cannot execute control requests',async()=>{
  const id=crypto.randomUUID();
  const request={type:'request',request_id:crypto.randomUUID(),control:true,payload:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'jan_execute_command'}})};
  assert.equal((await dispatchSelected(request,id,{[id]:{capabilities:['read']}},()=>assert.fail('Control reached socket'))).status,403);
});
test('portal protects confirmation with session CSRF, account binding and safe headers',async()=>{
  const storage=new Storage(),object=new JanDeviceStore({storage},env);
  const bindings={...env,DEVICES:{idFromName:id=>id,get:()=>({fetch:(url,init)=>object.fetch(new Request(url,init))})}};
  const cookie='T'.repeat(43),csrf='C'.repeat(43);
  await storage.put('session:'+await digest(cookie),{login:'owner',userId:'1234',csrf,expires:Date.now()+60000});
  const f=fixture(),p=await (await f.start()).json();
  assert.equal((await f.call('proof',f.prove(p))).status,200);
  await storage.put('pairing:v1',await f.storage.get('pairing:v1'));
  const req=(url,init={})=>portal(new Request(origin+url,init),bindings);
  const headers={Cookie:'__Host-JanPortal='+cookie};
  const page=await req('/devices/approve?id='+p.id,{headers});
  assert.equal(page.status,200);assert.equal(page.headers.get('Referrer-Policy'),'no-referrer');
  assert.equal(page.headers.get('Strict-Transport-Security'),'max-age=31536000');
  const html=await page.text();assert.ok(html.includes(p.code));assert.ok(!html.includes(f.publicKey));assert.match(html,/Confirm &amp; connect/);
  for(const badOrigin of [undefined,'null','https://evil.example']) {
    const r=await req('/devices/approve',{method:'POST',headers:{...headers,'Content-Type':'application/x-www-form-urlencoded',...(badOrigin?{Origin:badOrigin}:{})},body:new URLSearchParams({csrf:'wrong',id:p.id,decision:'approve'})});
    assert.equal(r.status,403);
  }
  assert.equal((await req('/devices/approve',{method:'POST',headers:{...headers,Origin:'null','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,id:p.id,decision:'approve'})})).status,303);
  const bad=await req('/devices/pair/start',{method:'POST',headers:{Origin:'null','Content-Type':'application/json'},body:'{}'});assert.equal(bad.status,403);
  const login=await req('/devices/login?pair='+p.id);
  const state=new URL(login.headers.get('Location')).searchParams.get('state');
  assert.equal((await req('/callback?state='+state+'&code=test')).status,403);
});

test('multi-user approval link hides the terminal code and locks after five bad guesses',async()=>{
  const storage=new Storage();
  const multi={...env,JAN_MULTI_USER_ENABLED:'1'};
  const key=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const publicKey=key.publicKey.export({type:'spki',format:'der'}).toString('base64url');
  const clientKey=randomBytes(32).toString('base64url');
  const call=(path,body)=>pairingStore('/pairing/'+path,body,storage,multi);
  const started=await call('start',{name:'Test PC',os:'Windows',agentVersion:'test',publicKey,clientKey});
  assert.equal(started.status,201);
  const pair=await started.json();
  const view=await (await call('view',{id:pair.id,ownerId:'5678'})).json();
  assert.equal(view.code,undefined);
  assert.equal(view.remainingSeconds,300);
  const decide=confirmationCode=>call('decide',{id:pair.id,ownerId:'5678',decision:'approve',login:'other',confirmationCode});
  const wrong=pair.code==='000 000'?'999 999':'000 000';
  for(let n=0;n<5;n++)assert.equal((await decide(wrong)).status,403);
  assert.equal((await decide(pair.code)).status,403);
});

test('approval page uses server remaining time instead of a skewed absolute clock',()=>{
  const page=verificationPage({id:'A'.repeat(43),name:'Test PC',os:'Windows',agentVersion:'test',status:'pending',proved:true,expires:Date.now()+19800000,remainingSeconds:121,capabilities:['read']},{login:'owner',csrf:'test'},true);
  return page.text().then(html=>{
    assert.match(html,/About 3 minutes remaining/);
    assert.doesNotMatch(html,/\d{4}-\d\d-\d\dT\d\d:/);
    assert.match(html,/with or without the space/);
  });
});


test('verified email-account namespace can review and approve its own browser-choice computer',async()=>{
 const f=fixture(),multi={...env,JAN_MULTI_USER_ENABLED:'1'},ownerId='s-12345678-1234-4123-8123-123456789abc';
 const call=(path,body)=>pairingStore('/pairing/'+path,body,f.storage,multi);
 const pair=await (await call('start',{publicKey:f.publicKey,name:'Email PC',os:'Windows',agentVersion:'beta18',clientKey:'a'.repeat(43),capabilities:['files','commands'],browserChoice:true})).json();
 assert.equal((await call('view',{id:pair.id,ownerId})).status,200);
 await call('proof',f.prove(pair));
 assert.equal((await call('decide',{id:pair.id,ownerId,decision:'approve',login:'test_user',capabilities:['files'],codesMatch:true,selectForAi:true})).status,200);
 assert.equal(Object.values(await f.storage.get('pairing:v1'))[0].ownerId,ownerId);
 assert.equal((await call('view',{id:pair.id,ownerId:'s-22345678-1234-4123-8123-123456789abc'})).status,403);
});
