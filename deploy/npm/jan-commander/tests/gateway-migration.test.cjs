'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

test('old-gateway startup obtains fresh approval and replaces state only after success',()=>{
  const script=String.raw`
    const assert=require('node:assert/strict'),cp=require('node:child_process');
    const outcome=process.argv[1],origin='https://current.example.workers.dev';
    const caps=['read','control','browser','commands','desktop','files'];
    const old={session:{id:'11111111-1111-4111-8111-111111111111',worker:'https://legacy.example.workers.dev',capabilities:caps},privateKey:'synthetic-old-key'};
    let replacements=0,starts=0;
    cp.spawnSync=(_exe,args,options)=>{
      if(args.at(-1)==='prepare')return {status:0,stdout:JSON.stringify({workspace:'C:/synthetic',localKey:'x'.repeat(43),credential:old})};
      assert.equal(args.at(-1),'replace');
      const value=JSON.parse(options.input);
      assert.equal(value.expectedId,old.session.id);
      assert.equal(value.credential.session.worker,origin);
      assert.notEqual(value.credential.privateKey,old.privateKey);
      replacements++;
      return {status:0,stdout:'{"saved":true}'};
    };
    global.fetch=async(url,options)=>{
      assert.ok(url.startsWith(origin+'/'),'old credentials must not be sent to either gateway');
      const body=JSON.parse(options.body);
      assert.ok(!options.body.includes(old.privateKey));
      if(url.endsWith('/start')){starts++;assert.equal(body.browserChoice,true);return Response.json({id:'i'.repeat(43),challenge:'c'.repeat(43),code:'123 456',server_time:Date.now(),expires:Date.now()+300000,capabilities:caps},{status:201});}
      if(body.action==='collect')return Response.json(outcome==='approve'?{status:'consumed',session:{id:'22222222-2222-4222-8222-222222222222',worker:origin,owner_id:'1234',protocol:2,capabilities:caps}}:{status:'rejected'});
      return Response.json({status:body.action==='cancel'?'cancelled':'pending'});
    };
    const {run}=require(process.argv[2]);
    run('C:/synthetic',{gateway:origin,browserChoice:true,autoUpgrade:true,capabilities:caps.slice(2),open:false,pairOnly:true}).then(()=>{
      assert.equal(outcome,'approve');assert.equal(starts,1);assert.equal(replacements,1);
    }).catch(error=>{
      if(outcome!=='reject')throw error;
      assert.match(error.message,/rejected/);assert.equal(starts,1);assert.equal(replacements,0);
    });
  `;
  for(const outcome of ['approve','reject']) {
    const result=spawnSync(process.execPath,['-e',script,outcome,path.resolve(__dirname,'../bin/pair-device.cjs')],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,0,result.stderr||String(result.error));
  }
});
