import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';

test('real OAuth grant is revoked by self-service deletion without removing another account',{timeout:30000},async()=>{
  const base='https://delete.example.workers.dev';
  const bindings={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'public'};
  let account=5678;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'delete-runtime',modules:true,script:readFileSync(new URL('../build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],durableObjects:{DEVICES:{className:'JanDeviceStore',useSQLite:true}},bindings,outboundService:async request=>{
    if(new URL(request.url).hostname==='github.com')return Response.json({access_token:'synthetic-token'});
    if(new URL(request.url).hostname==='api.github.com')return Response.json({id:account,login:'synthetic-'+account});
    throw Error('Unexpected outbound request');
  }}]}));
  const call=(path,init={})=>mf.dispatchFetch(base+path,{redirect:'manual',...init});
  const cookie=r=>r.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
  async function login(id){
    account=id;
    const start=await call('/devices/login');
    const state=new URL(start.headers.get('Location')).searchParams.get('state');
    const finish=await call('/callback?'+new URLSearchParams({state,code:'synthetic'}),{headers:{Cookie:cookie(start)}});
    assert.equal(finish.status,302,await finish.clone().text());
    return cookie(finish);
  }
  const post=(path,fields,cookies)=>call(path,{method:'POST',headers:{Cookie:cookies,Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(fields)});
  try {
    const health=await call('/healthz');assert.equal(health.status,200);
    assert.deepEqual(await health.json(),{service:'pcrc',status:'ok'});
    const userCookie=await login(5678),otherCookie=await login(9876);
    const register=await call('/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client_name:'Deletion regression client',redirect_uris:['https://client.example/callback'],grant_types:['authorization_code'],response_types:['code'],token_endpoint_auth_method:'none'})});
    const client=await register.json(),verifier='V'.repeat(64);
    const challenge=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))).toString('base64url');
    const consent=await call('/authorize?'+new URLSearchParams({response_type:'code',client_id:client.client_id,redirect_uri:'https://client.example/callback',scope:'jan:read',state:'synthetic',code_challenge:challenge,code_challenge_method:'S256',resource:base+'/mcp'}));
    const consentUrl=new URL(consent.headers.get('Location'));
    const authorized=await post('/authorize',{handle:consentUrl.searchParams.get('handle'),decision:'approve'},userCookie+'; '+cookie(consent));
    assert.equal(authorized.status,303,await authorized.clone().text());
    const code=new URL(authorized.headers.get('Location')).searchParams.get('code');
    const token=await post('/token',{grant_type:'authorization_code',client_id:client.client_id,code,redirect_uri:'https://client.example/callback',code_verifier:verifier,resource:base+'/mcp'},'');
    assert.equal(token.status,200,await token.clone().text());
    const tokens=await token.json();
    const review=await call('/devices/account',{headers:{Cookie:userCookie}});
    const csrf=(await review.text()).match(/name="csrf" value="([^"]+)"/)[1];
    const deleted=await post('/devices/account/delete',{csrf,confirmation:'DELETE'},userCookie);
    assert.equal(deleted.status,200,await deleted.clone().text());
    assert.match(await deleted.text(),/Account deleted/);
    assert.equal((await call('/devices/state',{headers:{Cookie:userCookie}})).status,401);
    assert.equal((await call('/devices/state',{headers:{Cookie:otherCookie}})).status,200);
    assert.equal((await call('/mcp',{method:'POST',headers:{Authorization:'Bearer '+tokens.access_token,'Content-Type':'application/json'},body:'{"jsonrpc":"2.0","id":1,"method":"ping"}'})).status,401);
    assert.notEqual((await post('/token',{grant_type:'refresh_token',client_id:client.client_id,refresh_token:tokens.refresh_token,resource:base+'/mcp'},'')).status,200);
  } finally {await mf.dispose();}
});
