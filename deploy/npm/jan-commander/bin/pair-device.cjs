'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const {spawn,spawnSync}=require('node:child_process');
const os=require('node:os');
const path=require('node:path');
const DEFAULT_GATEWAY='https://pc-remote-commander.pcremotecommander.workers.dev';
const token=()=>crypto.randomBytes(32).toString('base64url');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function parseArgs(argv) {
  const options={gateway:DEFAULT_GATEWAY,port:8866,pairOnly:false,open:true,foreground:true,'duration-minutes':60,'browser-channel':process.platform==='win32'?'msedge':'chromium'};
  for(let i=0;i<argv.length;i++) {
    const flag=argv[i];
    if(flag==='--pair-only') options.pairOnly=true;
    else if(flag==='--enroll') options.enroll=true;
    else if(flag==='--no-browser') options.open=false;
    else if(['--gateway','--port','--name','--duration-minutes','--capabilities','--browser-channel'].includes(flag)&&argv[i+1]) {options[flag.slice(2)]=argv[++i];if(flag==='--duration-minutes')options.foreground=false;}
    else throw Error('Use connect [--enroll] [--pair-only] [--no-browser] [--gateway HTTPS_WORKER] [--port PORT] [--name COMPUTER] [--capabilities files,commands,browser,desktop]');
  }
  if(!/^https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$/.test(options.gateway)) throw Error('Use an exact HTTPS workers.dev gateway');
  options.port=Number(options.port);
  if(!Number.isInteger(options.port)||options.port<1024||options.port>65535) throw Error('Use an unprivileged port');
  if(options.name!==undefined&&!/^[\w .-]{1,64}$/.test(options.name)) throw Error('Use a computer name of 1-64 letters, numbers, spaces, dots or hyphens');
  options['duration-minutes']=Number(options['duration-minutes']);
  if(!Number.isInteger(options['duration-minutes'])||options['duration-minutes']<1||options['duration-minutes']>480) throw Error('Session duration must be 1-480 minutes');
  if(options.capabilities!==undefined) {
    const selected=options.capabilities.split(',');
    if(!selected.length||new Set(selected).size!==selected.length||selected.some(v=>!['files','commands','browser','desktop'].includes(v)))throw Error('Choose capabilities from files,commands,browser,desktop');
    options.capabilities=selected.sort();
  } else options.capabilities=[];
  if(!['chromium','chrome','msedge'].includes(options['browser-channel']))throw Error('Browser channel must be chromium, chrome or msedge');
  return options;
}
function keys() {
  const {privateKey,publicKey}=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  return {privateKey:privateKey.export({type:'pkcs8',format:'pem'}),publicKey:publicKey.export({type:'spki',format:'der'}).toString('base64url')};
}
function proof(pair,action,privateKey,origin,now=Date.now()) {
  const nonce=token();
  const payload=['JAN_PAIR_DEVICE_V1',origin,pair.id,action,pair.challenge,nonce,String(now)].join('\n');
  return {id:pair.id,action,nonce,timestamp:now,signature:crypto.sign('sha256',Buffer.from(payload),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url')};
}
async function post(origin,route,body,fetcher=fetch) {
  const response=await fetcher(origin+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});
  const raw=await response.text();
  if(raw.length>8192) throw Error('Invalid gateway response');
  let data;try {data=JSON.parse(raw);} catch {throw Error('Invalid gateway response');}
  if(!response.ok) {const error=Error(response.status===404?'Pairing preview is not enabled on this gateway':response.status===403?'Device denied or pairing locked':response.status===410?'Pairing expired':'Gateway request failed ('+response.status+')');error.status=response.status;throw error;}
  return data;
}
function helper(root,action,input) {
  const python=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const result=spawnSync(python,['-m','jan_mcp_commander.pairing_state',action],{cwd:root,input:input?JSON.stringify(input):undefined,encoding:'utf8',windowsHide:true,maxBuffer:16384});
  if(result.error||result.status!==0) throw Error('Private agent state unavailable. Run setup and launch as a normal user.');
  return JSON.parse(result.stdout);
}
function openPage(url) {
  // URL is generated from a validated gateway and transaction ID, never shell text.
  let child;
  if(process.platform==='win32') child=spawn('rundll32.exe',['url.dll,FileProtocolHandler',url],{windowsHide:true,stdio:'ignore',shell:false});
  else child=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore',shell:false});
  child.on('error',()=>{});child.unref();
}
async function enroll(options,{fetcher=fetch,display=console.log,open=openPage,wait=pause,signal}={}) {
  if(signal?.aborted) throw Error('Pairing cancelled');
  const previous=options.previousCredential?.session.worker===options.gateway?options.previousCredential:null;
  const key=previous?{privateKey:previous.privateKey,publicKey:crypto.createPublicKey(previous.privateKey).export({type:'spki',format:'der'}).toString('base64url')}:keys();
  const name=options.name||os.hostname().replace(/[^\w .-]/g,'-').slice(0,64)||'Computer';
  const capabilities=options.capabilities??[];
  display('PC REMOTE COMMANDER\n\nConnecting your computer securely...\nComputer: '+name+'\nAccess: '+(capabilities.length?'computer control ('+capabilities.join(', ')+') as your OS account. Commands can access files outside the workspace; desktop can see the whole screen.':'read the approved workspace and run fixed diagnostics.')+'\nStored metadata: hostname, operating system, agent version and device public key.');
  const system=(os.platform()+' '+os.release()).replace(/[^\w .()-]/g,'-').slice(0,80);
  const pair=await post(options.gateway,'/devices/pair/start',{name,os:system,agentVersion:require('../package.json').version,publicKey:key.publicKey,...(previous?{reconnect:{id:previous.session.id,ownerId:previous.session.owner_id}}:{}),...(options.accountChoice?{accountChoice:true}:{}),...(capabilities.length?{capabilities}:{} ),...(options.browserChoice?{browserChoice:true}:{})},fetcher);
  if(!/^[A-Za-z0-9_-]{43}$/.test(pair.id)||!/^[A-Za-z0-9_-]{43}$/.test(pair.challenge)||!/^\d{3} \d{3}$/.test(pair.code)||!Number.isSafeInteger(pair.server_time)||!Number.isSafeInteger(pair.expires)||pair.expires<=pair.server_time||pair.expires>pair.server_time+310000) throw Error('Invalid pairing offer');
  const expectedCapabilities=capabilities.length?['read','control',...capabilities]:['read'];
  if(JSON.stringify(pair.capabilities)!==JSON.stringify(expectedCapabilities))throw Error('Gateway pairing permissions do not match the local request');
  // Use time from the authenticated HTTPS gateway; Windows clocks can be misconfigured.
  const offset=pair.server_time-Date.now(),now=()=>Date.now()+offset;
  const url=options.gateway+'/devices/approve?id='+pair.id;
  display('\nStatus: Waiting for device approval\nVerification code:\n\n'+pair.code+'\n\n'+(options.browserChoice?'Compare this code with the website, choose access and click Approve at:':'Enter this code at:')+'\n'+url+'\nExpires in five minutes. Ctrl+C cancels.');
  // Prove possession before opening the page so Confirm is immediately available.
  await post(options.gateway,'/devices/pair/proof',proof(pair,'status',key.privateKey,options.gateway,now()),fetcher);
  if(options.open) open(url);
  try {
    while(now()<pair.expires) {
      if(signal?.aborted) throw Error('Pairing cancelled');
      await wait(2100);
      if(signal?.aborted) throw Error('Pairing cancelled');
      let state;
      try {state=await post(options.gateway,'/devices/pair/proof',proof(pair,'collect',key.privateKey,options.gateway,now()),fetcher);}
      catch(error) {if(error.status&&error.status!==429) throw error;display('Waiting for gateway connection...');continue;}
      if(state.status==='consumed') {
        const s=state.session;
        if(previous&&!options.accountChoice&&pair.accountReleased!==true&&s?.owner_id!==previous.session.owner_id)throw Error('Sign in with the original PCRC account. Saved pairing was not changed.');
        if(!s||s.worker!==options.gateway||s.protocol!==2||! /^[a-f0-9-]{36}$/.test(s.id)||! /^(?:[0-9]{1,20}|s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(s.owner_id)||!approvedCapabilities(s.capabilities,expectedCapabilities,options.browserChoice)) throw Error('Approved capabilities do not match the local request');
        return {session:s,privateKey:key.privateKey};
      }
      if(['rejected','cancelled','expired'].includes(state.status)) throw Error('Pairing '+state.status);
    }
    throw Error('Pairing expired');
  } catch(error) {
    await post(options.gateway,'/devices/pair/proof',proof(pair,'cancel',key.privateKey,options.gateway,now()),fetcher).catch(()=>{});
    throw error;
  }
}
function localServerArgs(workspace,port,capabilities=[],durationMinutes=60,browserChannel='chromium',foreground=false) {
  return capabilities.length?['-m','jan_mcp_commander.control','--workspace',workspace,'--transport','http','--port',String(port),'--capabilities',capabilities.join(','),'--duration-minutes',String(durationMinutes),'--browser-channel',browserChannel,...(foreground?['--foreground','--foreground-parent-pid',String(process.pid)]:[])]:['-m','jan_mcp_commander.http_server','--workspace',workspace,'--port',String(port)];
}
function localServerLaunch(root,state,port,capabilities=[],durationMinutes=60,browserChannel='chromium',foreground=false) {
  const python=path.join(root,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const taskEntry=path.join(root,'deploy','mcp-task-server','dist','main.js');
  if(fs.existsSync(taskEntry)) return {
    command:process.execPath,args:[taskEntry,...(foreground?['--foreground']:[])],
    env:{...process.env,JAN_MCP_TRANSPORT:'http',JAN_MCP_WORKSPACE:state.workspace,JAN_MCP_PYTHON:python,
      JAN_MCP_CONTROL:capabilities.length?'1':'0',JAN_MCP_CAPABILITIES:capabilities.join(','),
      JAN_MCP_LOCAL_KEY:state.localKey,JAN_MCP_PORT:String(port),JAN_MCP_DURATION_MINUTES:String(durationMinutes),JAN_MCP_BROWSER_CHANNEL:browserChannel},
  };
  return {command:python,args:localServerArgs(state.workspace,port,capabilities,durationMinutes,browserChannel,foreground),env:process.env};
}
async function checkLocalReady({localKey,port,signal}) {
  const {performLocalCall}=require('./relay-agent.cjs');
  const deadline=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
  try {
    let statusTool='get_connection_status';
    for(const method of ['ping','tools/list','tools/call']) {
      const reply=await performLocalCall({type:'request',request_id:crypto.randomUUID(),control:false,payload:JSON.stringify({jsonrpc:'2.0',id:crypto.randomUUID(),method,...(method==='tools/call'?{params:{name:statusTool,arguments:{}}}:{})})},{key:localKey,port,signal:deadline});
      const rpc=JSON.parse(reply.payload);
      if(reply.status!==200||rpc.error||!rpc.result||rpc.result.isError||rpc.result.structuredContent?.ok===false)return false;
      if(method==='tools/list'){
        if(!Array.isArray(rpc.result.tools))return false;
        const status=rpc.result.tools.find(tool=>['get_connection_status','jan_status'].includes(tool.name));
        if(!status)return false;statusTool=status.name;
      }
    }
    return true;
  }catch{return false;}
}
async function startLocal(root,state,port,signal,capabilities=[],durationMinutes=60,browserChannel='chromium',foreground=false) {
  const net=require('node:net');
  // Fail if another process owns the port; never silently reuse a more privileged local server.
  const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',()=>reject(Error('Local port is already in use; choose --port PORT')));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
  const launch=localServerLaunch(root,state,port,capabilities,durationMinutes,browserChannel,foreground);
  const child=spawn(launch.command,launch.args,{cwd:root,env:launch.env,stdio:['pipe','ignore','ignore'],windowsHide:true});
  let exited=false;child.once('error',()=>{exited=true;});child.once('exit',()=>{exited=true;});
  const stop=()=>{child.stdin?.end();if(!exited)child.kill();};signal.addEventListener('abort',stop,{once:true});
  const readyUntil=Date.now()+30000;
  for(let i=0;i<100&&!signal.aborted&&!exited&&Date.now()<readyUntil;i++) {
    try {
      const r=await fetch('http://127.0.0.1:'+port+'/healthz',{headers:{Authorization:'Bearer '+state.localKey},signal:AbortSignal.timeout(500),redirect:'error'});
      if(r.ok&&await checkLocalReady({localKey:state.localKey,port,signal})) return {child,stop};
    } catch {}
    await pause(200);
  }
  stop();throw Error('Local authenticated MCP server did not start');
}
async function run(root,options,repairAttempt=false) {
  if(Number(process.versions.node.split('.')[0])<20) throw Error('Node.js 20 or newer is required');
  const controller=new AbortController();
  const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
  let local,lease,retry=false,connected=false;
  try {
    const state=helper(root,'prepare');
    console.log('Approved workspace: '+state.workspace);
    let credential=state.credential;
    if(credential&&credential.session.worker!==options.gateway&&!options.browserChoice) throw Error('Saved device belongs to a different gateway. Use its original --gateway.');
    let requested=options.capabilities??[];
    if(needsEnrollment(credential,options)) {
      const previous=credential;
      if(previous)console.log('Starting fresh enrollment. The saved preview identity will be replaced only after browser approval.');
      credential=await enroll({...options,previousCredential:previous,accountChoice:options.enroll===true&&!repairAttempt},{signal:controller.signal});
      if(previous)helper(root,'replace',{credential,expectedId:previous.session.id});
      else helper(root,'save',credential);
    }
    const approved=credential.session.capabilities??['read'];
    if(options.browserChoice)requested=approved.filter(c=>requested.includes(c));
    if(requested.length&&!requested.every(c=>approved.includes(c)))throw Error('Saved device is read-only or lacks requested control. Run connect --enroll --capabilities '+requested.join(',')+' and approve the new request in your browser.');
    if(approved.includes('control')&&!requested.length)console.log('Control remains disabled for this connection. Pass --capabilities explicitly to enable approved control.');
    if(controller.signal.aborted) return;
    console.log('Computer: '+credential.session.name+'\nDashboard: '+options.gateway+'/devices');
    if(options.pairOnly) return;
    if(!options.foreground)lease=setTimeout(()=>{console.log('Session expired. Run connect again to reconnect.');controller.abort();},options['duration-minutes']*60000);
    local=await startLocal(root,state,options.port,controller.signal,requested,options['duration-minutes'],options['browser-channel'],options.foreground===true);
    local.child.once('exit',()=>controller.abort());
    const {run:runRelay}=require('./relay-agent.cjs');
    await runRelay({credential,localKey:state.localKey,port:options.port,signal:controller.signal,enabledCapabilities:requested,livePreview:options.browserChoice===true&&process.stdout.isTTY===true,leaseSeconds:options.foreground?3600:options['duration-minutes']*60,beforeConnect:async()=>{if(!await checkLocalReady({localKey:state.localKey,port:options.port,signal:controller.signal}))throw Object.assign(Error('Local MCP server not ready'),{code:'LOCAL_NOT_READY'});},onOnline:()=>{connected=true;}});
  } catch(error) {
    if(!shouldRepair(error,options,repairAttempt,connected)||controller.signal.aborted)throw error;
    console.log('Saved pairing is no longer valid. Opening a fresh approval page.');
    retry=true;
  } finally {clearTimeout(lease);local?.stop();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
  if(retry)return run(root,{...options,enroll:true},true);
}
function needsEnrollment(credential,options) {
  if(!credential||options.enroll)return true;
  if(options.browserChoice&&credential.session.worker!==options.gateway)return true;
  const requested=options.capabilities??[];
  return options.autoUpgrade===true&&requested.some(capability=>!credential.session.capabilities?.includes(capability));
}
function shouldRepair(error,options,attempted=false,connected=false) {return options.browserChoice===true&&!attempted&&!connected&&error.code==='DEVICE_DENIED';}
function approvedCapabilities(actual,offered,browserChoice=false) {
  if(!browserChoice)return JSON.stringify(actual)===JSON.stringify(offered);
  if(!Array.isArray(actual)||actual[0]!=='read'||new Set(actual).size!==actual.length||actual.some(c=>!offered.includes(c)))return false;
  const controls=actual.filter(c=>!['read','control'].includes(c));
  return JSON.stringify(actual)===JSON.stringify(controls.length?['read','control',...controls.slice().sort()]:['read']);
}
module.exports={checkLocalReady,shouldRepair,approvedCapabilities,parseArgs,keys,proof,enroll,post,localServerArgs,localServerLaunch,needsEnrollment,run};
