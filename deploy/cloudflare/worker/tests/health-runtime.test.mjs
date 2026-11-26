import test from 'node:test';
import assert from 'node:assert/strict';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {readFileSync} from 'node:fs';

test('live health endpoint reports Worker liveness without requiring the Durable Object store', {timeout:30000}, async()=>{
  const base='https://liveness.example.workers.dev';
  const bindings={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticClient',GITHUB_CLIENT_SECRET:'synthetic-client-secret',ALLOWED_GITHUB_ID:'1234',JAN_MULTI_USER_ENABLED:'1',JAN_SITE_ROLE:'public'};
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'liveness-runtime',modules:true,script:readFileSync(new URL('../build/index.js',import.meta.url),'utf8'),compatibilityDate:'2026-10-15',compatibilityFlags:['global_fetch_strictly_public'],kvNamespaces:['OAUTH_KV'],bindings}]}));
  try {
    const response=await mf.dispatchFetch(base+'/livez');
    assert.equal(response.status,200,await response.clone().text());
    assert.deepEqual(await response.json(),{service:'pcrc',status:'alive'});
    assert.equal((await mf.dispatchFetch(base+'/livez',{method:'POST'})).status,400);
    assert.equal((await mf.dispatchFetch(base+'/livez?probe=1')).status,400);
    assert.equal((await mf.dispatchFetch(base+'/healthz')).status,503,'readiness must still fail when the Durable Object store is unavailable');
  } finally {await mf.dispose();}
});
