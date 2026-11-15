import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadPackage} from '../src/package_download.ts';

const base='https://pc-remote-commander-staging.pcremotecommander.workers.dev';
const filename='pc-remote-commander-preview-0.7.0-rc.3.tgz';
const env={JAN_PUBLIC_ORIGIN:base,JAN_ORIGIN:'https://unused-staging.trycloudflare.com',JAN_PROXY_KEY:'K'.repeat(43),GITHUB_CLIENT_ID:'SyntheticClient1',GITHUB_CLIENT_SECRET:'synthetic-secret-for-tests',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public'};

test('beta32 document runtimes keep exact platform routes and reject query substitutions',async()=>{
  for(const [platform,name] of [['windows','pcremotecommander-0.7.0-beta.44.tgz'],['posix','pcremotecommander-0.7.0-beta.44-posix.zip'],['windows','pcremotecommander-0.7.0-beta.43.tgz'],['posix','pcremotecommander-0.7.0-beta.43-posix.zip'],['windows','pcremotecommander-0.7.0-beta.42.tgz'],['posix','pcremotecommander-0.7.0-beta.42-posix.zip'],['windows','pcremotecommander-0.7.0-beta.41.tgz'],['posix','pcremotecommander-0.7.0-beta.41-posix.zip'],['windows','pcremotecommander-0.7.0-beta.40.tgz'],['posix','pcremotecommander-0.7.0-beta.40-posix.zip'],['windows','pcremotecommander-0.7.0-beta.39.tgz'],['posix','pcremotecommander-0.7.0-beta.39-posix.zip'],['windows','pcremotecommander-0.7.0-beta.38.tgz'],['posix','pcremotecommander-0.7.0-beta.38-posix.zip'],['windows','pcremotecommander-0.7.0-beta.37.tgz'],['posix','pcremotecommander-0.7.0-beta.37-posix.zip'],['windows','pcremotecommander-0.7.0-beta.36.tgz'],['posix','pcremotecommander-0.7.0-beta.36-posix.zip'],['windows','pcremotecommander-0.7.0-beta.35-build.2.tgz'],['posix','pcremotecommander-0.7.0-beta.35-build.2-posix.zip'],['windows','pcremotecommander-0.7.0-beta.34.tgz'],['posix','pcremotecommander-0.7.0-beta.34-posix.zip'],['windows','pcremotecommander-0.7.0-beta.32.tgz'],['posix','pcremotecommander-0.7.0-beta.32-posix.zip'],['windows','pcremotecommander-0.7.0-beta.33-build.2.tgz'],['windows','pcremotecommander-0.7.0-beta.33.tgz'],['posix','pcremotecommander-0.7.0-beta.33-build.2-posix.zip'],['posix','pcremotecommander-0.7.0-beta.33-posix.zip']]){
    let reads=0;const bindings={...env,PACKAGE_BUCKET:{get:async key=>{reads++;assert.equal(key,platform+'/'+name);return {body:'synthetic',size:9};}}};
    const route=base+'/downloads/'+platform+'/'+name;
    assert.equal((await downloadPackage(new Request(route),bindings)).status,200);
    assert.equal((await downloadPackage(new Request(route+'?private=1'),bindings)).status,404);
    assert.equal((await downloadPackage(new Request(route),{...bindings,JAN_SITE_ROLE:'owner'})).status,404);
    assert.equal(reads,1);
  }
});

test('public staging serves only the fixed installer artifact as a stream',async()=>{
  const requested=[];
  const bindings={...env,PACKAGE_BUCKET:{async get(key){requested.push(key);return {body:new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('synthetic package'));controller.close();}}),size:17,httpEtag:'"synthetic-etag"'};}}};
  const response=await downloadPackage(new Request(base+'/downloads/windows/'+filename),bindings);
  assert.equal(response.status,200);
  assert.equal(await response.text(),'synthetic package');
  assert.deepEqual(requested,['windows/'+filename]);
  assert.equal(response.headers.get('Content-Type'),'application/octet-stream');
  assert.equal(response.headers.get('Content-Disposition'),'attachment; filename="'+filename+'"');
  assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');
  assert.equal(response.headers.get('Set-Cookie'),null);
  assert.equal((await downloadPackage(new Request(base+'/downloads/windows/other.tgz'),bindings)).status,404);
  assert.equal((await downloadPackage(new Request(base+'/downloads/windows/'+filename,{method:'POST'}),bindings)).status,405);
  assert.deepEqual(requested,['windows/'+filename]);
});

test('operator origin cannot distribute the installer',async()=>{
  const ownerOrigin='https://pc-remote-commander-ops-staging.pcremotecommander.workers.dev';
  const response=await downloadPackage(new Request(ownerOrigin+'/downloads/windows/'+filename),{...env,JAN_PUBLIC_ORIGIN:ownerOrigin,JAN_SITE_ROLE:'owner'});
  assert.equal(response.status,404);
});

test('public staging serves the pinned beta runtime artifact only at its exact path',async()=>{
  const beta='pcremotecommander-0.7.0-beta.15-build.2.tgz';
  const requested=[];
  const bindings={...env,PACKAGE_BUCKET:{async get(key){requested.push(key);return {body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));controller.close();}}),size:1};}}};
  const response=await downloadPackage(new Request(base+'/downloads/windows/'+beta),bindings);
  assert.equal(response.status,200);
  assert.deepEqual(requested,['windows/'+beta]);
  assert.equal((await downloadPackage(new Request(base+'/downloads/windows/'+beta+'?x=1'),bindings)).status,404);
});


test('beta17 app and branding archive is a fixed public download',async()=>{
 const key='pcremotecommander-0.7.0-beta.17.tgz';
 const response=await downloadPackage(new Request(base+'/downloads/windows/'+key),{...env,PACKAGE_BUCKET:{get:async requested=>{assert.equal(requested,'windows/'+key);return {body:'synthetic',size:9};}}});
 assert.equal(response.status,200);
});


test('fixed public download is cached without changing bytes or bypassing route checks',async()=>{
 const original=globalThis.caches;
 const saved=new Map();const pending=[];let reads=0,lookups=0;
 globalThis.caches={default:{async match(request){lookups++;return saved.get(request.url)?.clone();},async put(request,response){saved.set(request.url,new Response(await response.arrayBuffer(),response));}}};
 const context={waitUntil(promise){pending.push(promise);}};
 const bytes=new Uint8Array([0,1,128,255]);
 const bindings={...env,PACKAGE_BUCKET:{async get(){reads++;return {body:bytes.slice(),size:bytes.length};}}};
 const request=new Request(base+'/downloads/windows/'+filename,{headers:{Cookie:'private-session=synthetic',Authorization:'Bearer synthetic-private'}});
 try {
  const first=await downloadPackage(request,bindings,context);
  assert.equal(first.headers.get('X-PCRC-Download-Cache'),'MISS');
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()),bytes);
  await Promise.all(pending);
  const readsAfterFill=reads;
  const second=await downloadPackage(new Request(request.url),bindings,context);
  assert.equal(second.headers.get('X-PCRC-Download-Cache'),'HIT');
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()),bytes);
  assert.equal(reads,readsAfterFill,'cache hit must not read R2');
  assert.equal(second.headers.get('Set-Cookie'),null);
  const previous=lookups;
  for(const denied of [new Request(request.url+'?private=1'),new Request(request.url,{method:'POST'}),new Request(request.url.replace(filename,'private.tgz'))])assert.ok((await downloadPackage(denied,bindings,context)).status>=400);
  assert.equal(lookups,previous,'invalid routes must be denied before cache lookup');
 } finally {if(original===undefined)delete globalThis.caches;else globalThis.caches=original;}
});

test('cache failures do not interrupt the original streamed download',async()=>{
 const original=globalThis.caches;const pending=[];
 globalThis.caches={default:{async match(){throw Error('synthetic cache unavailable');},async put(){throw Error('synthetic cache full');}}};
 try {
  const response=await downloadPackage(new Request(base+'/downloads/windows/'+filename),{...env,PACKAGE_BUCKET:{async get(){return {body:'unchanged',size:9};}}},{waitUntil(p){pending.push(p);}});
  assert.equal(response.status,200);assert.equal(await response.text(),'unchanged');
  await Promise.all(pending);
 } finally {if(original===undefined)delete globalThis.caches;else globalThis.caches=original;}
});


test('media release serves only the runtime and MIT model, never a repacked codec archive',async()=>{
 const calls=[];
 const bindings={...env,PACKAGE_BUCKET:{async get(key){calls.push(key);return {body:'synthetic',size:9};}}};
 for(const name of ['pcremotecommander-0.7.0-beta.24.tgz','pcremotecommander-speech-tiny-v1.zip']){
  assert.equal((await downloadPackage(new Request(base+'/downloads/windows/'+name),bindings)).status,200);
 }
 assert.equal((await downloadPackage(new Request(base+'/downloads/windows/pcremotecommander-media-0.7.0-beta.22.zip'),bindings)).status,404);
 assert.equal(calls.length,2);
});
