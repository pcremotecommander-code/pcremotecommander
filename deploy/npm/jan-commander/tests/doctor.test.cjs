'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { doctor } = require('../bin/doctor.cjs');

test('doctor separates installation and gateway checks without sending credentials', async () => {
  const seen = [];
  const checks = await doctor(__dirname, 'https://example.test', async (url, options) => {
    seen.push(url);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers, undefined);
    if (url.endsWith('/healthz')) throw Error('offline');
    return new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer realm="OAuth"' } });
  });
  assert.deepEqual(seen, ['https://example.test/healthz', 'https://example.test/mcp']);
  assert.deepEqual(checks.map(([, ok]) => ok), [true, false, false, false, true, false, false, false, null]);
});

test('doctor reports redacted pairing and running agent while leaving account discovery unverified',async()=>{
  const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcrc-doctor-'));
  try{
    const python=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
    fs.mkdirSync(path.dirname(python),{recursive:true});fs.writeFileSync(python,'synthetic');
    fs.mkdirSync(path.join(root,'deploy/mcp-task-server/dist'),{recursive:true});fs.writeFileSync(path.join(root,'deploy/mcp-task-server/dist/main.js'),'synthetic');
    const checks=await doctor(root,'https://example.test',async url=>new Response(null,{status:url.endsWith('/healthz')?200:401,headers:{'WWW-Authenticate':'Bearer realm="OAuth"'}}),(command,args,options)=>{
      assert.equal(command,python);assert.deepEqual(args.slice(0,4),['-m','jan_mcp_commander.pairing_state','inspect','--port']);assert.equal(options.cwd,root);assert.ok(!args.includes('prepare'));assert.equal(options.timeout,15000);
      return {status:0,stdout:JSON.stringify({paired:true,gateway:'https://example.test',local_agent:true})};
    });
    assert.deepEqual(checks.map(([,ok])=>ok),[true,true,true,true,true,true,true,true,null]);
    assert.ok(!JSON.stringify(checks).includes('privateKey'));
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('doctor refuses credential-bearing or non-HTTPS gateways before probing',async()=>{
  for(const origin of ['http://example.test','https://user:password@example.test','https://example.test/path']){
    await assert.rejects(doctor(__dirname,origin,()=>assert.fail('network reached')),/exact HTTPS/);
  }
});
