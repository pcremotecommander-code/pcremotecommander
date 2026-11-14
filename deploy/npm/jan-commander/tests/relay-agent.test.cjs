const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {handshake,verifyEnvelope,parseArgs,controlAllowed}=require('../bin/relay-agent.cjs');
const id='c3e35d88-9749-4af8-8c13-0d097e89f77b';

test('reviewed document tools retain local files capability',()=>{
 for(const name of ['inspect_document_pdf','preview_document_workflow','apply_document_workflow','get_document_workflow','jan_inspect_document_pdf','jan_preview_document_workflow','jan_apply_document_workflow','jan_get_document_workflow']){
  const message={control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name,arguments:{}}})};
  assert.equal(controlAllowed(message,['files']),true,name);
  assert.equal(controlAllowed(message,['commands']),false,name);
 }
});

test('task writes and taught workflow execution retain independent local capabilities',()=>{
 for(const [name,capability] of [['claim_task','files'],['reconcile_task','files'],['teach_browser_workflow','browser'],['publish_workflow','browser'],['run_workflow_step','browser']]){
  const message={control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name,arguments:{}}})};
  assert.equal(controlAllowed(message,[capability]),true);
  assert.equal(controlAllowed(message,capability==='files'?['browser']:['files']),false);
 }
});
test('accessibility inspection and action require independent desktop permission',()=>{
 for(const name of ['inspect_desktop_controls','interact_desktop_control','jan_inspect_desktop_controls','jan_interact_desktop_control']) {
  const message={control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name,arguments:{}}})};
  assert.equal(controlAllowed(message,['desktop']),true);
  assert.equal(controlAllowed(message,['files','commands','browser']),false);
 }
});

test('handshake follows Cloudflare HMAC specification',()=>{
 const h=handshake({id,owner_id:'12345'},'A'.repeat(43),1790000000);
 const signature=crypto.createHmac('sha256','A'.repeat(43)).update(['JAN_RELAY_WS_V1','12345',id,'1790000000',h.nonce].join('\n')).digest('hex');
 assert.equal(h.signature,signature);
});
test('public-key handshake signs the chosen relay lease',()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const h=handshake({id,owner_id:'12345',protocol:2},privateKey,1790000000,600);
 assert.equal(h.protocol,3);assert.equal(h.lease_seconds,600);
 assert.equal(crypto.verify('sha256',Buffer.from(['JAN_RELAY_WS_V3','12345',id,'1790000000',h.nonce,'600'].join('\n')),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(h.signature,'base64url')),true);
 assert.throws(()=>handshake({id,owner_id:'12345',protocol:2},privateKey,1790000000,28801));
});
test('agent validates relay requests',()=>{
 const message={type:'request',request_id:id,control:false,payload:'{"jsonrpc":"2.0","method":"ping","id":1}'};
 assert.equal(verifyEnvelope(message).type,'request');
 assert.throws(()=>verifyEnvelope({...message,extra:true}));
 assert.throws(()=>verifyEnvelope({...message,payload:'{}'}));
});
test('agent args require private file locations',()=>{
 assert.throws(()=>parseArgs([]));
 assert.equal(parseArgs(['--session','s','--device-key','k','--local-key','k']).port,8866);
});


test('application tools require and accept only the local commands capability',()=>{
 for(const name of ['list_applications','open_application','jan_list_applications','jan_open_application']){
  const message={control:true,payload:JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name,arguments:{}}})};
  assert.equal(controlAllowed(message,['commands']),true,name);
  for(const caps of [[],['files'],['browser'],['desktop']])assert.equal(controlAllowed(message,caps),false,name);
 }
});

test('named media operations require their specific local capability',()=>{
 for(const [name,capability] of Object.entries({read_pdf:'files',inspect_media:'files',transcribe_audio:'files',rewrite_pdf:'files',edit_media:'files',prepare_media:'commands'})){
  const envelope={control:true,payload:JSON.stringify({method:'tools/call',params:{name}})};
  assert.equal(controlAllowed(envelope,[capability]),true,name);
  assert.equal(controlAllowed(envelope,[]),false,name);
  assert.equal(controlAllowed(envelope,[capability==='files'?'commands':'files']),false,name);
 }
});

test('utility mutations and process listing require their own approved capability',()=>{
 for(const [name,capability] of Object.entries({create_directory:'files',stop_search:'files',set_config_value:'files',list_processes:'commands',force_terminate:'commands',shutdown:'commands'})){
  const envelope={control:true,payload:JSON.stringify({method:'tools/call',params:{name}})};
  assert.equal(controlAllowed(envelope,[capability]),true,name);
  assert.equal(controlAllowed(envelope,[capability==='files'?'commands':'files']),false,name);
 }
});
