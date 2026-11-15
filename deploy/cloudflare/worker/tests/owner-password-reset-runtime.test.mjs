import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';
import {digest} from '../src/device_portal.ts';

test('owner-created recovery state works through the public SQLite runtime without an initiating browser cookie',{timeout:30000},async()=>{
  const base='https://owner-reset-runtime.example.workers.dev',subject='12345678-1234-4123-8123-123456789abc',account='s-'+subject;
  const reset='Z'.repeat(43),verifier='V'.repeat(86);let exchanges=0;
  const bindings={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-owner-reset-secret',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',PCRC_EMAIL_AUTH_ENABLED:'1',SUPABASE_URL:'https://'+'a'.repeat(20)+'.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_'+'K'.repeat(30)};
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'reset-runtime',modules:true,script:readFileSync(new URL('../build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{DEVICES:{className:'JanDeviceStore',useSQLite:true}},bindings,outboundService:async req=>{
    assert.ok(req.url.startsWith(bindings.SUPABASE_URL+'/auth/v1/'));
    if(req.url.includes('/token?grant_type=pkce')){exchanges++;assert.equal((await req.json()).code_verifier,verifier);return Response.json({access_token:'synthetic-recovery-runtime-access-token'});}
    if(req.url.endsWith('/user'))return Response.json({id:subject,email:'synthetic@example.test',email_confirmed_at:new Date().toISOString(),user_metadata:{pcrc_username:'resettest'}});
    throw Error('Unexpected synthetic provider call');
  }}]}));
  try{
    const ns=await mf.getDurableObjectNamespace('DEVICES','reset-runtime'),stub=ns.get(ns.idFromName('1234'));
    const internal=(path,body)=>stub.fetch('https://internal.invalid'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Jan-Account-Id':'1234'},body:JSON.stringify(body)});
    assert.equal((await internal('/email-identity/resolve',{subject,email:'synthetic@example.test',username:'resettest'})).status,200);
    assert.equal((await internal('/directory/register',{id:account,login:'resettest'})).status,200);
    assert.equal((await internal('/owner-data/reset-start',{id:account,hash:await digest(reset),verifier})).status,200);
    assert.equal((await internal('/owner-data/reset-start',{id:account,hash:await digest('Y'.repeat(43)),verifier})).status,429);
    const path='/devices/email/callback?'+new URLSearchParams({reset,code:'synthetic-code'});
    const received=await mf.dispatchFetch(base+path,{redirect:'manual'});assert.equal(received.status,303);assert.equal(received.headers.get('Location'),base+'/devices/email/reset');
    const cookie=received.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');assert.match(cookie,/__Host-PcrcPasswordReset=/);assert.doesNotMatch(cookie,/__Host-JanPortal=/);
    const page=await mf.dispatchFetch(base+'/devices/email/reset',{headers:{Cookie:cookie},redirect:'manual'});assert.equal(page.status,200);assert.match(await page.text(),/Choose a new password/);
    assert.equal((await mf.dispatchFetch(base+path,{redirect:'manual'})).status,400);assert.equal(exchanges,1);
    assert.equal((await mf.dispatchFetch(base+'/owner-data/reset-start',{method:'POST',body:'{}',redirect:'manual'})).status,404);
  }finally{await mf.dispose();}
});
