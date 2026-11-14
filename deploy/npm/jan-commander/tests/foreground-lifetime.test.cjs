'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {EventEmitter}=require('node:events');
const pairing=require('../bin/pair-device.cjs');
const origin='https://pairing.example.workers.dev';

function harness(outcome='wait') {
  const timers=[],messages=[],listeners=new Map(),children=[];
  let relayOptions,pairRequests=0,ready;
  const relayReady=new Promise(resolve=>{ready=resolve;});
  const fakeProcess={versions:{node:'24.0.0'},platform:process.platform,execPath:process.execPath,env:{},stdout:{isTTY:false},
    once:(name,listener)=>listeners.set(name,listener),removeListener:(name,listener)=>{if(listeners.get(name)===listener)listeners.delete(name);}};
  const state={workspace:path.resolve('synthetic-workspace'),localKey:'K'.repeat(43),credential:{privateKey:pairing.keys().privateKey,session:{id:'11111111-1111-4111-8111-111111111111',owner_id:'1234',worker:origin,name:'Sample computer',protocol:2,capabilities:['read','control','files']}}};
  const fakeRequire=name=>{
    if(name==='node:fs')return {existsSync:()=>true};
    if(name==='node:child_process')return {
      spawnSync:()=>({status:0,stdout:JSON.stringify(state)}),
      spawn:(_exe,_args,options)=>{
        const child=new EventEmitter();child.options=options;child.kills=0;child.stdin={ended:false,end(){this.ended=true;}};
        child.kill=()=>{child.kills++;child.emit('exit',0,'SIGTERM');};children.push(child);return child;
      },
    };
    if(name==='node:net')return {createServer:()=>({once(){},listen(_port,_host,callback){callback();},close(callback){callback?.();}})};
    if(name==='./relay-agent.cjs')return {performLocalCall:async message=>({status:200,payload:JSON.stringify({jsonrpc:'2.0',result:JSON.parse(message.payload).method==='tools/list'?{tools:[{name:'get_connection_status'}]}:{}})}),run:async options=>{
      await options.beforeConnect?.();
      relayOptions=options;ready();
      if(outcome==='revoked'){options.onOnline?.();throw Object.assign(Error('Device denied'),{code:'DEVICE_DENIED'});}
      await new Promise(resolve=>options.signal.addEventListener('abort',resolve,{once:true}));
    }};
    return require(name);
  };
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../bin/pair-device.cjs'),'utf8'),{
    require:fakeRequire,module,process:fakeProcess,AbortController,AbortSignal,Buffer,
    console:{log:message=>messages.push(message)},
    setTimeout:(callback,ms)=>{const timer={callback,ms};timers.push(timer);return timer;},
    clearTimeout:timer=>{const index=timers.indexOf(timer);if(index>=0)timers.splice(index,1);},
    fetch:async url=>{if(!url.startsWith('http://127.0.0.1:')){pairRequests++;throw Error('Unexpected automatic enrollment');}return {ok:true};},
  });
  return {run:module.exports.run,ready:relayReady,timers,messages,children,relay:()=>relayOptions,pairRequests:()=>pairRequests,stop:()=>listeners.get('SIGINT')?.()};
}

test('foreground is the default while explicit duration retains a finite cap',()=>{
  assert.equal(pairing.parseArgs([]).foreground,true);
  assert.equal(pairing.parseArgs(['--duration-minutes','10']).foreground,false);
});

test('foreground launch reaches task server and direct Python control without a forever relay lease',()=>{
  const direct=pairing.localServerArgs('synthetic',18866,['files'],60,'msedge',true);
  assert.ok(direct.includes('--foreground'));
  assert.equal(direct[direct.indexOf('--foreground-parent-pid')+1],String(process.pid));
  const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'pcrc-foreground-'));
  try {
    const entry=path.join(root,'deploy','mcp-task-server','dist','main.js');
    fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'');
    const launch=pairing.localServerLaunch(root,{workspace:'synthetic',localKey:'K'.repeat(43)},18866,['files'],60,'msedge',true);
    assert.deepEqual(launch.args,[entry,'--foreground']);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('foreground run has no expiry timer and closing launcher stops its pipe-owned server',async()=>{
  const h=harness(),options=pairing.parseArgs(['--gateway',origin,'--capabilities','files']);
  const run=h.run('synthetic-root',options);await h.ready;
  assert.equal(h.timers.length,0);
  assert.equal(h.children[0].options.stdio[0],'pipe');
  assert.equal(h.relay().leaseSeconds,3600);
  h.stop();await run;
  assert.equal(h.children[0].stdin.ended,true);
  assert.equal(h.children[0].kills,1);
  assert.equal(h.pairRequests(),0);
  assert.doesNotMatch(h.messages.join('\n'),/Saved device identity loaded|Access: control:/);
  assert.match(h.messages.join('\n'),/Computer: Sample computer/);
});

test('explicit duration still expires and stops the foreground-owned process',async()=>{
  const h=harness(),options=pairing.parseArgs(['--gateway',origin,'--capabilities','files','--duration-minutes','10']);
  const run=h.run('synthetic-root',options);await h.ready;
  assert.equal(h.timers.length,1);assert.equal(h.timers[0].ms,600000);
  assert.equal(h.relay().leaseSeconds,600);
  h.timers[0].callback();await run;
  assert.equal(h.children[0].kills,1);
  assert.ok(h.messages.some(text=>text.includes('Session expired')));
});

test('online revocation stops without starting automatic enrollment or switching accounts',async()=>{
  const h=harness('revoked'),options=pairing.parseArgs(['--gateway',origin,'--capabilities','files']);options.browserChoice=true;
  await assert.rejects(h.run('synthetic-root',options),/Device denied/);
  assert.equal(h.pairRequests(),0);
  assert.equal(h.children[0].kills,1);
});
