'use strict';
// JAN outbound agent prototype. Run only with an enrolled session and a running local MCP server.
// No device secrets are included in logs or command arguments.
const fs=require('node:fs');
const crypto=require('node:crypto');
const WebSocket=require('ws');
const path=require('node:path');
const {sensitiveText,inspectPublicOutput}=require('./privacy-guard.cjs');
let previewPrivacyRules;
function previewSensitive(value) {
  try {
    previewPrivacyRules??=JSON.parse(fs.readFileSync([path.resolve(__dirname,'../../../../src/jan_mcp_commander/privacy-rules.json'),path.resolve(__dirname,'../project/src/jan_mcp_commander/privacy-rules.json')].find(file=>fs.existsSync(file)),'utf8'));
    return sensitiveText(String(value),previewPrivacyRules);
  }catch{return true;}
}
function previewSensitiveField(key,value) {
  try {previewSensitive('');inspectPublicOutput([{[key]:value}],previewPrivacyRules);return false;}catch{return true;}
}

const MAX_REQUEST=262144,MAX_RESPONSE=1048576;
class LocalCallUnavailable extends Error {
  constructor(code){super('Local MCP request unavailable; outcome unknown');this.code=code;}
}
function localFailureReply(message,error) {
  // A rejected or invalid local reply must not discard unrelated in-flight work.
  if(!(error instanceof LocalCallUnavailable))error=new LocalCallUnavailable('LOCAL_RESPONSE_INVALID');
  const rpc=JSON.parse(message.payload);
  if(typeof rpc.id!=='string'&&typeof rpc.id!=='number')return null;
  return {type:'response',request_id:message.request_id,status:200,payload:JSON.stringify({jsonrpc:'2.0',id:rpc.id,error:{code:-32000,
    message:'The local MCP request did not return a verified result. Its outcome is unknown. Inspect the computer before retrying; do not repeat a mutation automatically.',
    data:{error_code:error.code,outcome_unknown:true,automatic_retry:false}}})};
}
const CONTROL_TO_CAPABILITY={jan_list_applications:'commands',jan_open_application:'commands',list_applications:'commands',open_application:'commands',jan_run_command:'commands',jan_start_process:'commands',jan_start_program:'commands',jan_process_input:'commands',jan_process_output:'commands',jan_session_output:'commands',jan_stop_session:'commands',jan_list_sessions:'commands',jan_start_session:'commands',jan_write_text:'files',jan_edit_text:'files',jan_move_text:'files',jan_delete_text:'files',jan_restore_backup:'files',jan_skill_feedback:'files',jan_browser:'browser',jan_desktop:'desktop',preview_file_edit:'files',apply_file_edit:'files',create_text_file:'files',move_files_bulk:'files',delete_files_bulk:'files',restore_file_backup:'files',run_command:'commands',start_process:'commands',start_program:'commands',read_process_output:'commands',send_process_input:'commands',stop_process:'commands',list_browser_tabs:'browser',inspect_browser_page:'browser',capture_browser:'browser',navigate_browser:'browser',interact_browser:'browser',manage_browser_tab:'browser',capture_desktop:'desktop',interact_desktop:'desktop'};
Object.assign(CONTROL_TO_CAPABILITY,{inspect_desktop_controls:'desktop',interact_desktop_control:'desktop',jan_inspect_desktop_controls:'desktop',jan_interact_desktop_control:'desktop',create_pdf:'files',create_directory:'files',stop_search:'files',set_config_value:'files',list_processes:'commands',force_terminate:'commands',shutdown:'commands',read_pdf:'files',inspect_media:'files',transcribe_audio:'files',rewrite_pdf:'files',edit_media:'files',prepare_media:'commands',create_task:'files',claim_task:'files',renew_task:'files',finish_task:'files',reconcile_task:'files',teach_browser_workflow:'browser',publish_workflow:'browser',delete_workflow:'browser',start_workflow_run:'browser',run_workflow_step:'browser'});
Object.assign(CONTROL_TO_CAPABILITY,{inspect_document_pdf:'files',jan_inspect_document_pdf:'files',preview_document_workflow:'files',apply_document_workflow:'files',get_document_workflow:'files',jan_preview_document_workflow:'files',jan_apply_document_workflow:'files',jan_get_document_workflow:'files',inspect_office_document:'files',preview_spreadsheet_edit:'files',apply_spreadsheet_edit:'files',jan_inspect_office:'files',jan_preview_spreadsheet:'files',jan_edit_spreadsheet:'files'});
const DEVELOPMENT_TOOLS=new Set(['inspect_development', 'preview_development_change', 'apply_development_change', 'get_development_change', 'jan_inspect_development', 'jan_preview_development_change', 'jan_apply_development_change', 'jan_get_development_change']);
for(const name of DEVELOPMENT_TOOLS)CONTROL_TO_CAPABILITY[name]='commands';
function controlAllowed(message,enabled) {
  if(!message.control)return true;
  try {
    const m=JSON.parse(message.payload);
    if(['tools/list','resources/list','resources/templates/list'].includes(m.method))return enabled.length>0;
    if(m.method==='resources/read')return typeof m.params?.uri==='string'&&/^app:\/\/pcrc\/processes\/[A-Za-z0-9_-]+$/.test(m.params.uri)&&enabled.includes('commands');
    if(m.method!=='tools/call'||!m.params||typeof m.params.name!=='string')return false;
    if(m.params.name==='jan_disable_control')return enabled.length>0;
    return enabled.includes(CONTROL_TO_CAPABILITY[m.params.name])&&(!DEVELOPMENT_TOOLS.has(m.params.name)||enabled.includes('files'));
  } catch {return false;}
}
function verifyEnvelope(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||
     Object.keys(value).sort().join(',')!=='control,payload,request_id,type'||
     value.type!=='request'||typeof value.control!=='boolean'||
     typeof value.request_id!=='string'||!/^[0-9a-f-]{36}$/i.test(value.request_id)||
     typeof value.payload!=='string'||Buffer.byteLength(value.payload)>MAX_REQUEST)throw Error('Invalid relay envelope');
  const m=JSON.parse(value.payload);
  if(!m||m.jsonrpc!=='2.0'||typeof m.method!=='string')throw Error('Invalid MCP message');
  return value;
}
function handshake(session,key,now=Math.floor(Date.now()/1000),leaseSeconds=3600) {
  const nonce=crypto.randomBytes(24).toString('base64url');
  const info={owner_id:String(session.owner_id),device_id:session.id,timestamp:now,nonce};
  if(session.protocol===2) {
    if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<60||leaseSeconds>28800)throw Error('Invalid relay lease');
    const signature=crypto.sign('sha256',Buffer.from(['JAN_RELAY_WS_V3',info.owner_id,info.device_id,String(now),nonce,String(leaseSeconds)].join('\n')),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
    return {...info,protocol:3,lease_seconds:leaseSeconds,signature};
  }
  const signature=crypto.createHmac('sha256',key).update(['JAN_RELAY_WS_V1',info.owner_id,info.device_id,String(now),nonce].join('\n')).digest('hex');
  return {...info,signature};
}
async function performLocalCall(message,options={}) {
  const request=verifyEnvelope(message);
  const url='http://127.0.0.1:'+options.port+'/mcp';
  const rpc=JSON.parse(request.payload);
  const meta=rpc.params?._meta;
  const protocolVersion=meta?.['io.modelcontextprotocol/protocolVersion'];
  const headers={'Authorization':'Bearer '+options.key,'Content-Type':'application/json',
    'Accept':'application/json, text/event-stream','X-JAN-Control':request.control?'1':'0'};
  if(protocolVersion==='2026-07-28') {
    headers['MCP-Protocol-Version']=protocolVersion;
    headers['Mcp-Method']=rpc.method;
    const name=rpc.method==='resources/read'?rpc.params?.uri:rpc.method==='tools/call'||rpc.method==='prompts/get'?rpc.params?.name:undefined;
    if(typeof name==='string')headers['Mcp-Name']=/^[\x21-\x7e]+$/.test(name)&&!name.startsWith('=?base64?')?name:'=?base64?'+Buffer.from(name).toString('base64')+'?=';
  }
  let response;
  try {response=await fetch(url,{method:'POST',headers:{
    ...headers
  },body:request.payload,redirect:'manual',signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(19000)]):AbortSignal.timeout(19000)});}
  catch {throw new LocalCallUnavailable('LOCAL_TRANSPORT_UNAVAILABLE');}
  if(response.status>=500&&response.status<=599){await response.body?.cancel().catch(()=>{});throw new LocalCallUnavailable('LOCAL_SERVER_UNAVAILABLE');}
  if(![200,202,204].includes(response.status)){await response.body?.cancel().catch(()=>{});throw new LocalCallUnavailable('LOCAL_REQUEST_REJECTED');}
  let payload='';
  if(response.status===200&&response.body) {
    const chunks=[];let size=0;
    try {for await(const chunk of response.body) {size+=chunk.length;if(size>MAX_RESPONSE)throw Error('Oversized MCP response');chunks.push(Buffer.from(chunk));}}
    catch(error){if(['TypeError','AbortError','TimeoutError'].includes(error.name))throw new LocalCallUnavailable('LOCAL_RESPONSE_INTERRUPTED');throw error;}
    payload=Buffer.concat(chunks).toString('utf8');
  }
  if(response.status===200) {
    const contentType=response.headers.get('content-type')?.split(';')[0].trim();
    if(contentType==='text/event-stream') {
      const events=payload.split(/\r?\n\r?\n/);
      const responses=events.flatMap(event=>event.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim())).map(data=>JSON.parse(data)).filter(item=>item.jsonrpc==='2.0'&&item.id===rpc.id);
      if(responses.length!==1)throw Error('Invalid streamed MCP response');
      payload=JSON.stringify(responses[0]);
    } else if(contentType!=='application/json')throw Error('Unexpected MCP response format');
    const decoded=JSON.parse(payload);if(decoded.jsonrpc!=='2.0'||((typeof rpc.id==='string'||typeof rpc.id==='number')&&decoded.id!==rpc.id))throw Error('Invalid MCP response');
  }
  return {type:'response',request_id:request.request_id,status:response.status,payload};
}
function parseArgs(argv) {
  const out={port:8866};
  for(let i=0;i<argv.length;i++){
    const flag=argv[i];
    if(!['--session','--device-key','--local-key','--port'].includes(flag)||!argv[i+1])throw Error('Use --session PATH --device-key PATH --local-key PATH [--port PORT]');
    out[flag.slice(2).replaceAll('-','_')]=argv[++i];
  }
  out.port=Number(out.port);
  if(!Number.isInteger(out.port)||out.port<1024||out.port>65535||!out.session||!out.device_key||!out.local_key)throw Error('Missing or invalid agent configuration');
  return out;
}
function terminalPreview(value) {
  const clean=(item,depth=0)=>{
    if(depth>6)return '[nested value omitted]';
    if(typeof item==='string') {
      if(item.includes('PRIVATE KEY-----'))return '[private key omitted]';
      try {return clean(JSON.parse(item),depth+1);} catch {}
      if(previewSensitive(item))return '[sensitive content omitted]';
      if(item.length>256&&/^[A-Za-z0-9+/=_-]+$/.test(item))return '[encoded value omitted]';
      return item.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'')
        .replace(/Bearer\s+[^\s"']+/gi,'Bearer [redacted]')
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[redacted]@')
        .replace(/((?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*)[^\s,;"']+/gi,'$1[redacted]')
        .replace(/([?&](?:code|state|token|access_token|key|secret)=)[^&#\s]+/gi,'$1[redacted]')
        .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,'[redacted]').slice(0,1000);
    }
    if(Array.isArray(item))return item.slice(0,20).map(v=>clean(v,depth+1));
    if(item&&typeof item==='object') {
      if(item.type==='image')return {type:'image',data:'[image omitted]'};
      return Object.fromEntries(Object.entries(item).slice(0,30).map(([key,v])=>[previewSensitive(key)?'[sensitive field]':key,/(?:pass(?:word|phrase)?|secret|token|authorization|cookie|private.?key|api.?key|local.?key|signature|code_verifier)/i.test(key)||previewSensitiveField(key,v)?'[redacted]':clean(v,depth+1)]));
    }
    return item;
  };
  try {return JSON.stringify(clean(value)).slice(0,2000);} catch {return '[preview unavailable]';}
}
function onlineStatus(session,headers={},color=false) {
  const name=String(session.name??'Computer').replace(/[\x00-\x1f\x7f]/g,'').slice(0,64);
  const login=headers['x-pcrc-account-id']===String(session.owner_id)&&typeof headers['x-pcrc-account-name']==='string'&&/^[A-Za-z0-9_-]{1,39}$/.test(headers['x-pcrc-account-name'])?headers['x-pcrc-account-name']:'paired account';
  return 'Connected successfully\n[ONLINE] '+name+'\nAccount: '+login+'\nAccount ID: '+session.owner_id+'\n'+(color?'\x1b[92m':'')+'Ready to work'+(color?'\x1b[0m':'')+'\nPress Ctrl+C to disconnect.';
}
function offlineStatus(delay) {return '[OFFLINE] Connection lost or unavailable. Reconnecting in '+Math.ceil(delay/1000)+' seconds...';}
async function run(options){
  if(typeof WebSocket!=='function')throw Error('The ws WebSocket dependency is required');
  const session=options.credential?.session??JSON.parse(fs.readFileSync(options.session,'utf8'));
  if(!session||typeof session.worker!=='string'||!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(session.worker)||! /^[a-f0-9-]{36}$/.test(session.id)||! /^(?:[0-9]{1,20}|s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(String(session.owner_id)))throw Error('Invalid saved JAN session');
  const deviceKey=options.credential?.privateKey??fs.readFileSync(options.device_key,'utf8').trim();
  const localKey=options.localKey??fs.readFileSync(options.local_key,'utf8').trim();
  if((session.protocol===2?crypto.createPrivateKey(deviceKey).asymmetricKeyType!=='ec':!/^[A-Za-z0-9_-]{43,128}$/.test(deviceKey))||!/^[A-Za-z0-9_-]{43,128}$/.test(localKey))throw Error('Invalid saved PC Remote Commander credentials');
  const controller=new AbortController(),signal=options.signal??controller.signal;
  const stop=()=>controller.abort();
  if(!options.signal)process.once('SIGINT',stop);
  let delay=1000,requestNumber=0;
  try {while(!signal.aborted){
    let ws,heartbeat,denied=0,alive=true,identityHeaders={};
    const disconnect=()=>ws?.close();
    try {
      await options.beforeConnect?.();
      const clock=await fetch(session.worker+'/.well-known/oauth-protected-resource/mcp',{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
      const serverTime=Date.parse(clock.headers.get('Date')??'');await clock.body?.cancel();
      if(!clock.ok||!Number.isFinite(serverTime))throw Error('Gateway clock unavailable');
      const proof=handshake(session,deviceKey,Math.floor(serverTime/1000),options.leaseSeconds??3600);
      ws=new WebSocket(session.worker.replace(/^https:/,'wss:')+'/jan-relay/connect',{
        headers:{'X-JAN-Device-Proof':JSON.stringify(proof),'X-PCRC-Terminal-Status':'1'},maxPayload:MAX_REQUEST+2048,handshakeTimeout:15000
      });
      ws.once('upgrade',response=>{identityHeaders=response.headers;});
      signal.addEventListener('abort',disconnect,{once:true});
      ws.on('error',()=>{});
      ws.on('pong',()=>{alive=true;});
      await new Promise((resolve,reject)=>{
        ws.once('unexpected-response',(_req,response)=>{denied=[401,403,410].includes(response.statusCode)?response.statusCode:0;response.resume();ws.terminate();reject(Error('Relay denied'));});
        ws.addEventListener('open',resolve,{once:true});
        ws.addEventListener('error',()=>reject(Error('Relay connection rejected')),{once:true});
      });
      console.log(onlineStatus(session,identityHeaders,!!process.stdout.isTTY&&!process.env.NO_COLOR&&process.env.TERM!=='dumb'));
      options.onOnline?.();
      heartbeat=setInterval(()=>{if(!alive){ws.terminate();return;}alive=false;ws.ping();},20000);
      delay=1000;
      await new Promise(resolve=>{
        let active=0;
        ws.addEventListener('message',event=>{
          let msg;try{msg=JSON.parse(event.data);}catch{ws.close();return;}
          try {verifyEnvelope(msg);}catch{ws.close();return;}
          const number=++requestNumber;
          if(options.livePreview)console.log('[REQUEST '+number+'] '+terminalPreview(msg.payload));
          if(session.protocol===2&&msg.control&&(!Array.isArray(session.capabilities)||!session.capabilities.includes('control')||!controlAllowed(msg,options.enabledCapabilities??[]))) {
            const id=JSON.parse(msg.payload).id;
            if(typeof id!=='string'&&typeof id!=='number'){ws.close();return;}
            const payload=JSON.stringify({jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:'Control is not enabled for this local connection. Reconnect with the approved --capabilities to grant it locally.'}]}});
            if(options.livePreview)console.log('[RESULT '+number+'] Control denied by local permissions.');
            ws.send(JSON.stringify({type:'response',request_id:msg.request_id,status:200,payload}));return;
          }
          if(active>=4){
            const rpc=JSON.parse(msg.payload);
            const payload=JSON.stringify({jsonrpc:'2.0',id:typeof rpc.id==='string'||typeof rpc.id==='number'?rpc.id:null,error:{code:-32001,
              message:'This computer is busy with four requests. This request was not started. Wait for the active requests to finish; do not retry a mutation automatically.',
              data:{error_code:'LOCAL_BUSY',executed:false,automatic_retry:false}}});
            if(options.livePreview)console.log('[RESULT '+number+'] Local request not started: computer busy; no automatic retry.');
            if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'response',request_id:msg.request_id,status:200,payload}));
            return;
          }
          active++;
          performLocalCall(msg,{key:localKey,port:options.port,signal}).then(reply=>{
            if(options.livePreview)console.log('[RESULT '+number+'] '+terminalPreview(reply.payload));
            if(ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(reply));
          }).catch(error=>{
            if(options.livePreview)console.log('[RESULT '+number+'] Local request failed; outcome unknown; no automatic command retry.');
            if(ws.readyState!==WebSocket.OPEN)return;
            const failure=localFailureReply(msg,error);
            try {if(failure)ws.send(JSON.stringify(failure));else ws.close();}catch{ws.close();}
          }).finally(()=>{active--;});
        });
        ws.addEventListener('close',resolve,{once:true});
        ws.addEventListener('error',resolve,{once:true});
      });
    } catch(error) {if(!signal.aborted)console.error(error?.code==='LOCAL_NOT_READY'?'PC Remote Commander is waiting for its local tool server. Reconnecting automatically; no new pairing is needed.':'PC Remote Commander relay unavailable or device not approved.');}
    finally {clearInterval(heartbeat);signal.removeEventListener('abort',disconnect);if(ws&&ws.readyState<=1)ws.close();}
    if(denied) {const error=Error(denied===410?'Account access is closed.':'Saved device access was denied. Fresh browser approval is required.');error.code=denied===410?'ACCOUNT_CLOSED':'DEVICE_DENIED';throw error;}
    if(!signal.aborted){console.log(offlineStatus(delay));await require('node:timers/promises').setTimeout(delay,undefined,{signal}).catch(()=>{});delay=Math.min(delay*2,30000);}
  }} finally {if(!options.signal)process.removeListener('SIGINT',stop);}
}
module.exports={terminalPreview,onlineStatus,offlineStatus,handshake,verifyEnvelope,controlAllowed,performLocalCall,parseArgs,run};
if(require.main===module){
  try {run(parseArgs(process.argv.slice(2))).catch(e=>{console.error('JAN agent:',e.message);process.exitCode=1;});}
  catch {console.error('JAN relay requires --session FILE --device-key FILE --local-key FILE [--port 8866].');process.exitCode=1;}
}
