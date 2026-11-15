import test from 'node:test';
import assert from 'node:assert/strict';
import {portal,digest,createPortalSession,session} from '../src/device_portal.ts';
import {openRecord,sealRecord} from '../src/secure_store.ts';
import {s256} from '../src/authorization.ts';
import {retainAccountData} from '../src/account_lifecycle.ts';
import {ownerFixture,unlockOwner} from './helpers/owner-console-fixture.mjs';

const subject='12345678-1234-4123-8123-123456789abc',other='22345678-1234-4123-8123-123456789abc';
const account='s-'+subject,address='synthetic@example.test';
const cookies=r=>r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
async function fixture(){
  const f=await ownerFixture();await unlockOwner(f);
  Object.assign(f.env,{PCRC_PUBLIC_SITE_ORIGIN:f.origin,SUPABASE_URL:'https://'+'a'.repeat(20)+'.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'a'.repeat(25),PCRC_EMAIL_AUTH_ENABLED:'1'});
  await f.callStore('/email-identity/resolve',{subject,email:address,username:'resettest'});
  await f.callStore('/directory/register',{id:account,login:'resettest'});
  const publicEnv={...f.env,JAN_SITE_ROLE:'public'},calls=[];
  const send=async(provider=async()=>Response.json({}))=>portal(new Request(f.origin+'/admin/users/action',{method:'POST',headers:{Cookie:'__Host-JanPortal='+f.token,Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:f.csrf,account,action:'reset',email:'attacker@example.test'})}),f.env,async(url,init)=>{calls.push({url,init});return provider(url,init);});
  return {...f,publicEnv,calls,send,storage:f.storages.get('1234')};
}
async function invitation(f){
  assert.equal((await f.send()).status,303);
  const request=f.calls.at(-1),callback=new URL(new URL(request.url).searchParams.get('redirect_to'));
  const hash=await digest(callback.searchParams.get('reset'));
  const record=await f.storage.get('owner:reset-flow:'+hash);
  const flow=await openRecord(f.env.JAN_PROXY_KEY,'1234','owner-password-reset',record);
  return {request,callback,hash,record,flow};
}

test('owner reset uses the stored address and encrypted account-bound PKCE state; cooldown never sends twice',async()=>{
  const f=await fixture(),i=await invitation(f),body=JSON.parse(i.request.init.body);
  assert.equal(body.email,address);assert.equal(body.code_challenge_method,'s256');assert.equal(body.code_challenge,await s256(i.flow.verifier));
  assert.equal(i.flow.accountId,account);assert.equal(i.flow.subject,subject);assert.equal(i.flow.email,address);
  assert.ok(i.record.expires>Date.now()&&i.record.expires<=Date.now()+900000);
  const persisted=JSON.stringify([...f.storage.entries]);assert.ok(!persisted.includes(i.flow.verifier)&&!persisted.includes(i.callback.searchParams.get('reset')));
  assert.equal((await f.callStore('/owner-data/reset-consume',{hash:i.hash},'5678')).status,403);
  const repeat=await f.send();assert.equal(repeat.status,429);assert.match(await repeat.text(),/wait at least five minutes/);assert.equal(f.calls.length,1);
});

test('a recipient without an owner or initiating-browser cookie can reset only the selected account once',async()=>{
  const f=await fixture(),i=await invitation(f);let exchanges=0,updates=0;
  const previous=await createPortalSession(f.publicEnv,{id:account,login:'resettest'}),oldCookie=cookies(previous);
  const provider=async(url,init)=>{
    if(url.includes('/token?grant_type=pkce')){exchanges++;assert.equal(JSON.parse(init.body).code_verifier,i.flow.verifier);return Response.json({access_token:'synthetic-recovery-access-token-only'});}
    if(url.endsWith('/user')&&init.method==='GET')return Response.json({id:subject,email:address,email_confirmed_at:new Date().toISOString(),user_metadata:{pcrc_username:'resettest'}});
    if(url.endsWith('/user')&&init.method==='PUT'){updates++;assert.equal(JSON.parse(init.body).password,'Synthetic-reset-password-42');return Response.json({});}
    throw Error('Unexpected provider request');
  };
  i.callback.searchParams.set('code','synthetic-code');
  const received=await portal(new Request(i.callback),f.publicEnv,provider);assert.equal(received.status,303);
  assert.match(received.headers.get('Location'),/\/devices\/email\/reset$/);assert.doesNotMatch(cookies(received),/__Host-JanPortal=/);
  const replay=await portal(new Request(i.callback),f.publicEnv,provider);assert.equal(replay.status,400);assert.equal(exchanges,1);
  const resetCookie=cookies(received),form=await portal(new Request(f.origin+'/devices/email/reset',{headers:{Cookie:resetCookie}}),f.publicEnv,provider);
  const csrf=/name="csrf" value="([A-Za-z0-9_-]+)"/.exec(await form.text())[1];
  const changed=await portal(new Request(f.origin+'/devices/email/reset',{method:'POST',headers:{Cookie:resetCookie,Origin:f.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,password:'Synthetic-reset-password-42',confirmation:'Synthetic-reset-password-42'})}),f.publicEnv,provider);
  assert.equal(changed.status,200);assert.match(await changed.text(),/Password updated/);assert.equal(updates,1);
  assert.equal(await session(new Request(f.origin+'/devices',{headers:{Cookie:oldCookie}}),f.publicEnv),null);
});

test('mismatched provider subjects, altered handles and extra callback parameters never create recovery grants',async()=>{
  for(const mismatch of [{id:other,email:'other@example.test'},{id:subject,email:'changed@example.test'}]){
  const f=await fixture(),i=await invitation(f);i.callback.searchParams.set('code','synthetic');
  let exchanged=0;
  const provider=async(url)=>{if(url.includes('/token?')){exchanged++;return Response.json({access_token:'synthetic-wrong-subject-token'});}return Response.json({...mismatch,email_confirmed_at:new Date().toISOString()});};
  const response=await portal(new Request(i.callback),f.publicEnv,provider);assert.equal(response.status,403);assert.doesNotMatch(cookies(response),/__Host-PcrcPasswordReset=/);
  const retry=await portal(new Request(i.callback),f.publicEnv,provider);assert.equal(retry.status,400);assert.equal(exchanged,1);
  i.callback.searchParams.set('reset','Z'.repeat(43));assert.equal((await portal(new Request(i.callback),f.publicEnv,provider)).status,400);
  i.callback.searchParams.set('extra','denied');assert.equal((await portal(new Request(i.callback),f.publicEnv,provider)).status,400);
  }
});

test('provider failures show safe reset-specific guidance and do not replay an uncertain email',async()=>{
  for(const [status,code,expected,pattern]of [[429,'over_email_send_rate_limit',429,/email provider has limited/],[400,'email_address_not_authorized',503,/Configure production SMTP/],[401,'invalid_api_key',503,/key configuration/],[500,'unexpected_failure',503,/HTTP 500/]]){
    const f=await fixture();const response=await f.send(async()=>Response.json({code,message:'private-provider-detail '+address},{status}));
    assert.equal(response.status,expected);const html=await response.text();assert.match(html,pattern);assert.doesNotMatch(html,/private-provider-detail|synthetic@example.test|replay a refund|Action needs review/);
    assert.equal((await f.send()).status,429);assert.equal(f.calls.length,1);
  }
  const f=await fixture(),response=await f.send(async()=>{throw Error('synthetic network interruption');});
  assert.equal(response.status,502);assert.match(await response.text(),/no automatic retry/);assert.equal(f.calls.length,1);
  assert.equal((await f.storage.list({prefix:'owner:reset-flow:'})).size,1,'uncertain delivery retains the single-use recovery state');
});

test('expired, superseded and deleted-account reset invitations are rejected and retained state is pruned',async()=>{
  const f=await fixture(),i=await invitation(f);
  await f.storage.put('owner:reset-flow:'+i.hash,await sealRecord(f.env.JAN_PROXY_KEY,'1234','owner-password-reset',i.flow,Date.now()-1));
  assert.equal((await f.callStore('/owner-data/reset-consume',{hash:i.hash})).status,403);
  await f.storage.put('owner:reset:'+account,Date.now()-300001);
  const next=await invitation(f);await f.storage.put('owner:reset:'+account,Date.now()-300001);const latest=await invitation(f);
  assert.equal((await f.callStore('/owner-data/reset-consume',{hash:next.hash})).status,403);
  await f.callStore('/directory/remove',{id:account});assert.equal((await f.callStore('/owner-data/reset-consume',{hash:latest.hash})).status,403);
  const expired={expires:Date.now()-1};await f.storage.put('owner:reset-flow:expired',expired);await f.storage.put('owner:reset-flow-account:expired',expired);
  await retainAccountData(f.storage);assert.equal(await f.storage.get('owner:reset-flow:expired'),undefined);assert.equal(await f.storage.get('owner:reset-flow-account:expired'),undefined);
});
