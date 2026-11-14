'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {parseArgs,keys,proof,enroll,localServerArgs,needsEnrollment,localServerLaunch}=require('../bin/pair-device.cjs');
const {handshake,controlAllowed}=require('../bin/relay-agent.cjs');
const origin='https://pairing.example.workers.dev';

test('same-gateway repair reuses its key and refuses a different approved account',async()=>{
  const saved={session:{id:'11111111-1111-4111-8111-111111111111',owner_id:'1234',worker:origin},...keys()};
  const fake=gateway('consumed',false,[],'5678');
  const fetcher=async(url,init)=>{
    if(url.endsWith('/start')){
      const data=JSON.parse(init.body);
      assert.equal(data.publicKey,saved.publicKey);
      assert.deepEqual(data.reconnect,{id:saved.session.id,ownerId:'1234'});
      delete data.reconnect;
      init={...init,body:JSON.stringify(data)};
    }
    return fake.fetcher(url,init);
  };
  await assert.rejects(enroll({gateway:origin,open:false,previousCredential:saved},{fetcher,display:()=>{},wait:async()=>{}}),/original PCRC account/);
});

test('pairing CLI rejects unexpected arguments, invalid origins and privileged ports',()=>{
  assert.equal(parseArgs([]).gateway,'https://pc-remote-commander.pcremotecommander.workers.dev');
  assert.deepEqual(parseArgs(['--capabilities','files,commands']).capabilities,['commands','files']);
  assert.equal(parseArgs(['--browser-channel','msedge'])['browser-channel'],'msedge');
  for(const args of [['--gateway','http://evil.example'],['--port','0'],['--capabilities','admin'],['--capabilities','files,files'],['--browser-channel','unknown'],['--gateway',origin+'/'],['--duration-minutes','0'],['--duration-minutes','481'],['--name','bad\nname']]) assert.throws(()=>parseArgs(args));
});
test('device proofs and WSS v3 use the generated private key and domain-separated signatures',()=>{
  const k=keys(),p={id:'i'.repeat(43),challenge:'c'.repeat(43)};
  const signed=proof(p,'status',k.privateKey,origin,12345);
  const payload=['JAN_PAIR_DEVICE_V1',origin,p.id,'status',p.challenge,signed.nonce,'12345'].join('\n');
  const publicKey=crypto.createPublicKey({key:Buffer.from(k.publicKey,'base64url'),format:'der',type:'spki'});
  assert.equal(crypto.verify('sha256',Buffer.from(payload),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signed.signature,'base64url')),true);
  const ws=handshake({protocol:2,owner_id:'1234',id:crypto.randomUUID()},k.privateKey,123);
  const wsPayload=['JAN_RELAY_WS_V3',ws.owner_id,ws.device_id,'123',ws.nonce,'3600'].join('\n');
  assert.equal(crypto.verify('sha256',Buffer.from(wsPayload),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(ws.signature,'base64url')),true);
});
test('local launch uses the explicit control origin only for selected capabilities',()=>{
  const read=localServerArgs('C:\\isolated',18866);
  assert.ok(read.includes('jan_mcp_commander.http_server'));
  assert.ok(!read.includes('jan_mcp_commander.control'));
  const control=localServerArgs('C:\\isolated',18867,['commands','files'],10,'msedge');
  assert.ok(control.includes('jan_mcp_commander.control'));
  assert.deepEqual(control.slice(control.indexOf('--capabilities')),['--capabilities','commands,files','--duration-minutes','10','--browser-channel','msedge']);
});
test('packaged task server becomes the local MCP origin without changing CLI commands',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcrc-task-launch-'));
 try {
  const entry=path.join(root,'deploy','mcp-task-server','dist','main.js');
  fs.mkdirSync(path.dirname(entry),{recursive:true});fs.writeFileSync(entry,'');
  const selected=localServerLaunch(root,{workspace:'C:\\isolated',localKey:'K'.repeat(43)},18866,['files'],10);
  assert.equal(selected.command,process.execPath);
  assert.deepEqual(selected.args,[entry]);
  assert.equal(selected.env.JAN_MCP_WORKSPACE,'C:\\isolated');
  assert.equal(selected.env.JAN_MCP_CONTROL,'1');
  assert.equal(selected.env.JAN_MCP_CAPABILITIES,'files');
  assert.equal(selected.env.JAN_MCP_LOCAL_KEY,'K'.repeat(43));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
test('relay admits only locally enabled task control operations',()=>{
 const envelope=(method,params)=>({control:true,payload:JSON.stringify({jsonrpc:'2.0',id:1,method,params})});
 assert.equal(controlAllowed(envelope('tools/call',{name:'apply_file_edit'}),['files']),true);
 assert.equal(controlAllowed(envelope('tools/call',{name:'run_command'}),['files']),false);
 assert.equal(controlAllowed(envelope('tools/call',{name:'run_command'}),['commands']),true);
 assert.equal(controlAllowed(envelope('tools/call',{name:'start_program'}),['commands']),true);
 assert.equal(controlAllowed(envelope('tools/call',{name:'manage_browser_tab'}),['browser']),true);
 assert.equal(controlAllowed(envelope('tools/call',{name:'capture_browser'}),['browser']),true);
 assert.equal(controlAllowed(envelope('tools/list',{}),['browser']),true);
 assert.equal(controlAllowed(envelope('tools/list',{}),[]),false);
 assert.equal(controlAllowed(envelope('resources/read',{uri:'app://pcrc/processes/session-1'}),['commands']),true);
 assert.equal(controlAllowed(envelope('resources/read',{uri:'app://pcrc/processes/session-1'}),['files']),false);
 assert.equal(controlAllowed(envelope('tools/call',{name:'unknown_future_tool'}),['files','commands']),false);
});
test('interactive full-control choice starts a new approval only when saved permissions are insufficient',()=>{
  const existing={session:{capabilities:['read']}};
  const approved={session:{capabilities:['read','control','browser','commands','desktop','files']}};
  const chosen=['browser','commands','desktop','files'];
  assert.equal(needsEnrollment(existing,{autoUpgrade:true,capabilities:chosen}),true);
  assert.equal(needsEnrollment(approved,{autoUpgrade:true,capabilities:chosen}),false);
  assert.equal(needsEnrollment(existing,{capabilities:chosen}),false);
  assert.equal(needsEnrollment(existing,{enroll:true,capabilities:[]}),true);
});
function gateway(outcome='consumed',failOnce=false,capabilities=[],ownerId='1234') {
  let key,challenge='c'.repeat(43),requests=[],failed=false;
  const serverTime=Date.now()+19800000;
  const fetcher=async(url,init)=>{
    const data=JSON.parse(init.body);requests.push(data);
    if(url.endsWith('/start')) {
      key=crypto.createPublicKey({key:Buffer.from(data.publicKey,'base64url'),format:'der',type:'spki'});
      assert.deepEqual(Object.keys(data).sort(),data.capabilities?['agentVersion','capabilities','name','os','publicKey']:['agentVersion','name','os','publicKey']);
      if(data.capabilities)assert.deepEqual(data.capabilities,capabilities);
      return Response.json({id:'i'.repeat(43),challenge,code:'123 456',server_time:serverTime,expires:serverTime+300000,capabilities:capabilities.length?['read','control',...capabilities]:['read']},{status:201});
    }
    assert.ok(Math.abs(data.timestamp-serverTime)<10000,'Agent did not use HTTPS gateway time');
    const message=['JAN_PAIR_DEVICE_V1',origin,data.id,data.action,challenge,data.nonce,String(data.timestamp)].join('\n');
    assert.equal(crypto.verify('sha256',Buffer.from(message),{key,dsaEncoding:'ieee-p1363'},Buffer.from(data.signature,'base64url')),true);
    if(data.action==='status')return Response.json({status:'pending'});
    if(data.action==='cancel')return Response.json({status:'cancelled'});
    if(failOnce&&!failed){failed=true;throw Error('Synthetic network loss');}
    return Response.json(outcome==='consumed'?{status:outcome,session:{id:crypto.randomUUID(),worker:origin,owner_id:ownerId,protocol:2,capabilities:capabilities.length?['read','control',...capabilities]:['read']}}:{status:outcome});
  };
  return {fetcher,requests};
}
test('agent displays the matching code, retries a lost response and returns only approved credentials',async()=>{
  const fake=gateway('consumed',true),messages=[],pages=[];
  const result=await enroll({gateway:origin,open:true},{fetcher:fake.fetcher,display:s=>messages.push(s),open:s=>pages.push(s),wait:async()=>{}});
  assert.equal(result.session.protocol,2);assert.match(result.privateKey,/BEGIN PRIVATE KEY/);
  assert.ok(messages.join('\n').includes('123 456'));assert.ok(!messages.join('\n').includes(result.privateKey));
  assert.deepEqual(pages,[origin+'/devices/approve?id='+'i'.repeat(43)]);
  assert.equal(fake.requests.filter(r=>r.action==='collect').length,2);
});
test('control enrollment requires an exact approved capability set and local relay choice',async()=>{
  const selected=['commands','files'],fake=gateway('consumed',false,selected);
  const credential=await enroll({gateway:origin,open:false,capabilities:selected},{fetcher:fake.fetcher,display:()=>{},wait:async()=>{}});
  assert.deepEqual(credential.session.capabilities,['read','control','commands','files']);
  const message=name=>({control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name}})});
  assert.equal(controlAllowed(message('jan_write_text'),selected),true);
  assert.equal(controlAllowed(message('jan_run_command'),selected),true);
  assert.equal(controlAllowed(message('jan_desktop'),selected),false);
  assert.equal(controlAllowed(message('jan_run_command'),[]),false);
  assert.equal(controlAllowed(message('unknown_control'),selected),false);
  await assert.rejects(enroll({gateway:origin,open:false,capabilities:[]},{fetcher:gateway('consumed',false,selected).fetcher,display:()=>{},wait:async()=>{}}),/permissions/);
});
test('agent handles rejection and cancellation without saving or returning a credential',async()=>{
  const fake=gateway('rejected');
  await assert.rejects(enroll({gateway:origin,open:false},{fetcher:fake.fetcher,display:()=>{},wait:async()=>{}}),/rejected/);
  assert.equal(fake.requests.at(-1).action,'cancel');
  const aborted=new AbortController();aborted.abort();
  await assert.rejects(enroll({gateway:origin},{signal:aborted.signal,fetcher:()=>assert.fail('Cancelled request reached gateway')}),/cancelled/);
});
test('source launcher help and invalid connect options run from a different current directory',()=>{
  const cli=path.resolve(__dirname,'../bin/jan-commander.cjs'),root=path.resolve(__dirname,'../../../..');
  const result=spawnSync(process.execPath,[cli,'help'],{cwd:require('node:os').tmpdir(),encoding:'utf8'});
  assert.equal(result.status,0);assert.match(result.stdout,/PC REMOTE COMMANDER/);assert.match(result.stdout,/connect/);
  const invalid=spawnSync(process.execPath,[cli,'connect','--project',root,'--port','0'],{cwd:require('node:os').tmpdir(),encoding:'utf8'});
  assert.equal(invalid.status,1);assert.match(invalid.stderr,/unprivileged port/);
});

 test('website approval accepts only canonical subsets of locally offered permissions',()=>{
  const {approvedCapabilities}=require('../bin/pair-device.cjs');
  const offer=['read','control','commands','files'];
  assert.equal(approvedCapabilities(['read'],offer,true),true);
  assert.equal(approvedCapabilities(['read','control','files'],offer,true),true);
  for(const invalid of [null,[],['read','desktop'],['read','files'],['read','control'],['read','read'],['read','control','files','commands']])assert.equal(approvedCapabilities(invalid,offer,true),false);
  assert.equal(approvedCapabilities(['read'],offer,false),false);
  assert.equal(needsEnrollment({session:{capabilities:['read']}},{browserChoice:true,autoUpgrade:true,capabilities:['files']}),true);
});

test('automatic repair is bounded and never reopens a closed account or retries network failures',()=>{
 const {shouldRepair}=require('../bin/pair-device.cjs');
 assert.equal(shouldRepair({code:'DEVICE_DENIED'},{browserChoice:true}),true);
 assert.equal(shouldRepair({code:'DEVICE_DENIED'},{browserChoice:true},true),false);
 assert.equal(shouldRepair({code:'DEVICE_DENIED'},{}),false);
 for(const code of ['ACCOUNT_CLOSED','ECONNRESET',undefined])assert.equal(shouldRepair({code},{browserChoice:true}),false);
});

test('browser-choice enrollment sends the offer and enables only the returned subset',async()=>{
 const fake=gateway('consumed',false,['commands','files']);
 const fetcher=async(url,init)=>{
  const body=JSON.parse(init.body);
  if(url.endsWith('/start')) {assert.equal(body.browserChoice,true);delete body.browserChoice;init={...init,body:JSON.stringify(body)};}
  const response=await fake.fetcher(url,init);
  if(body.action==='collect'){const data=await response.json();data.session.capabilities=['read'];return Response.json(data);}
  return response;
 };
 const credential=await enroll({gateway:origin,browserChoice:true,capabilities:['commands','files'],open:false},{fetcher,display:()=>{},wait:async()=>{}});
 assert.deepEqual(credential.session.capabilities,['read']);
});

test('one-command setup re-pairs an old gateway without reusing its credential',()=>{
 const saved={session:{worker:'https://jan-commander-relay-staging.channelflow.workers.dev',capabilities:['read','control','browser','commands','desktop','files']}};
 const options={gateway:origin,browserChoice:true,autoUpgrade:true,capabilities:['browser','commands','desktop','files']};
 assert.equal(needsEnrollment(saved,options),true);
 assert.equal(needsEnrollment({...saved,session:{...saved.session,worker:origin}},options),false);
 assert.equal(needsEnrollment(saved,{...options,browserChoice:false}),false);
});


test('email-account enrollment preserves its distinct account identity',async()=>{
 const ownerId='s-12345678-1234-4123-8123-123456789abc',fake=gateway('consumed',false,[],ownerId);
 const result=await enroll({gateway:origin,open:false},{fetcher:fake.fetcher,display:()=>{},wait:async()=>{}});
 assert.equal(result.session.owner_id,ownerId);
});
