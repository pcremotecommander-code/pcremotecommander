import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';

test('two real gateway workers share one durable registration budget',{timeout:30000},async()=>{
  const base='https://budget.example.workers.dev';
  const bindings={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public'};
  const script=readFileSync(new URL('../build/index.js',import.meta.url),'utf8');
  const workers=['budget-a','budget-b'].map(name=>({name,modules:true,script,compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],bindings,durableObjects:{DEVICES:{className:'JanDeviceStore',scriptName:'budget-a',useSQLite:true}}}));
  const mf=new Miniflare(convertV4MiniflareOptions({workers}));
  try {
    const gateways=await Promise.all(workers.map(w=>mf.getWorker(w.name)));
    const call=(i,ip='192.0.2.9')=>gateways[i%2].fetch(base+'/register',{method:'POST',headers:{'Content-Type':'application/json','CF-Connecting-IP':ip},body:JSON.stringify({client_name:'Synthetic budget test',redirect_uris:['https://client.example/callback'],token_endpoint_auth_method:'none',grant_types:['authorization_code'],response_types:['code']})});
    const results=await Promise.all(Array.from({length:20},(_,i)=>call(i)));
    assert.equal(results.filter(r=>r.status===201).length,10);
    const blocked=results.filter(r=>r.status===429);
    assert.equal(blocked.length,10);
    assert.ok(blocked.every(r=>Number(r.headers.get('Retry-After'))>0));
    assert.equal((await call(0,'192.0.2.10')).status,201,'other clients retain a separate budget');
    assert.equal((await gateways[0].fetch(base+'/abuse/check',{method:'POST',body:'{"bucket":"registration"}'})).status,404,'internal limiter is not a public endpoint');
  } finally {await mf.dispose();}
});
