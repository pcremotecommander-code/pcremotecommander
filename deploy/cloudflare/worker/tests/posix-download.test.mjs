import test from 'node:test';
import assert from 'node:assert/strict';
import {downloadPackage} from '../src/package_download.ts';
test('POSIX downloads only serve the fixed reviewed release from its own bucket prefix',async()=>{
 const origin='https://download-test.example.workers.dev',name='pcremotecommander-0.7.0-beta.29-posix.zip';let reads=0;
 const env={JAN_SITE_ROLE:'public',JAN_PUBLIC_ORIGIN:origin,PACKAGE_BUCKET:{get:async key=>{reads++;assert.equal(key,'posix/'+name);return {body:new Uint8Array([1,2]),size:2};}}};
 const route='/downloads/posix/'+name;
 assert.equal((await downloadPackage(new Request(origin+route),env)).status,200);assert.equal(reads,1);
 for(const path of ['/downloads/posix/private.zip',route+'?x=secret','/downloads/windows/'+name])assert.equal((await downloadPackage(new Request(origin+path),env)).status,404);
 assert.equal(reads,1);assert.equal((await downloadPackage(new Request(origin+route),{...env,JAN_SITE_ROLE:'owner'})).status,404);
});
