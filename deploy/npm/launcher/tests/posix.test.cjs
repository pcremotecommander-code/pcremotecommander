const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {runPosix,posixArgs}=require('../bin/pcremotecommander.cjs');
test('POSIX launcher verifies installer before execution and caches daily reconnect',async()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'pcrc-posix-launcher-')),bytes=Buffer.from('#!/bin/bash\necho synthetic\n'),expected=crypto.createHash('sha256').update(bytes).digest('hex');let downloads=0,calls=0;
 const options={home,platform:'linux',expected,load:async()=>{downloads++;return bytes;},run:(exe,args,opts)=>{calls++;assert.equal(exe,'bash');assert.equal(opts.shell,false);assert.deepEqual(args.slice(1),['setup']);assert.deepEqual(fs.readFileSync(args[0]),bytes);return {status:0};}};
 try{await runPosix(['setup'],options);await runPosix(['connect'],options);assert.equal(downloads,1);assert.equal(calls,2);await assert.rejects(runPosix(['setup'],{...options,expected:'0'.repeat(64)}),/integrity/);assert.equal(calls,2);assert.deepEqual(posixArgs(['cli','read','notes $(unsafe).txt']),['--cli','read','notes $(unsafe).txt']);assert.deepEqual(posixArgs(['doctor']),['--doctor']);assert.deepEqual(posixArgs(['uninstall']),['--uninstall']);assert.throws(()=>posixArgs(['setup','--gateway','https://evil.test']));}
 finally{fs.rmSync(home,{recursive:true,force:true});}
});
