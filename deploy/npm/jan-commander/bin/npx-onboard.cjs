#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const pairing=require('./pair-device.cjs');
const packageRoot=path.resolve(__dirname,'..');
const version=require(path.join(packageRoot,'package.json')).version;
const publicGateway='https://pc-remote-commander.pcremotecommander.workers.dev';
const fullControl=['browser','commands','desktop','files'];

function usesBrowserChoice(argv) {
  return ['connect','setup'].includes(argv[0])&&!argv.includes('--capabilities');
}
function connectionArgs(argv) {
  if(argv[0]!=='setup')return argv;
  const args=['connect',...argv.slice(1)];
  if(!args.includes('--gateway'))args.push('--gateway',publicGateway);
  return args;
}

function installRoot(env=process.env) {
  const local=env.LOCALAPPDATA;
  if(process.platform!=='win32'||!local||!path.isAbsolute(local))throw Error('This preview requires Windows and a normal user profile.');
  return path.join(local,'PCRemoteCommander','preview',version);
}
const embeddedPython=root=>path.join(root,'.venv','Scripts','python.exe');
function installed(root) {
  try{return JSON.parse(fs.readFileSync(path.join(root,'npx-install.json'),'utf8')).version===version&&fs.statSync(embeddedPython(root)).isFile()&&fs.statSync(path.join(root,'deploy','npm','jan-commander','node_modules','ws','index.js')).isFile()&&(!fs.existsSync(path.join(root,'deploy','mcp-task-server','dist','main.js'))||fs.statSync(path.join(root,'node_modules','@modelcontextprotocol','server','package.json')).isFile());}
  catch{return false;}
}
function prepare({root=installRoot(),bundle=path.join(packageRoot,'project'),runtime=path.join(packageRoot,'runtime'),websocket=path.dirname(require.resolve('ws',{paths:[packageRoot]})),modules=path.join(packageRoot,'node_modules'),runner=spawnSync}={}) {
  if(!fs.statSync(path.join(bundle,'pyproject.toml')).isFile())throw Error('The downloaded package is incomplete.');
  if(!fs.statSync(path.join(runtime,'python.exe')).isFile())throw Error('The bundled Python runtime is missing. Download the package again.');
  const wsPackage=JSON.parse(fs.readFileSync(path.join(websocket,'package.json'),'utf8'));
  if(wsPackage.name!=='ws'||wsPackage.version!=='8.22.0')throw Error('The downloaded WebSocket dependency is incomplete. Download the package again.');
  fs.mkdirSync(root,{recursive:true});
  if(fs.lstatSync(root).isSymbolicLink())throw Error('Install folder cannot be a symbolic link.');
  const configPath=path.join(root,'connection.json');
  const configSource=fs.existsSync(configPath)?configPath:path.join(bundle,'connection.json');
  let prior={};
  if(fs.existsSync(configSource)) {
    try {
      prior=JSON.parse(fs.readFileSync(configSource,'utf8').replace(/^\uFEFF/,''));
      if(!prior||typeof prior!=='object'||Array.isArray(prior)||prior.workspace!==undefined&&(typeof prior.workspace!=='string'||!path.isAbsolute(prior.workspace)||/[\x00-\x1f\x7f]/.test(prior.workspace)))throw new SyntaxError('Invalid workspace settings');
    }
    catch(error) {
      if(!(error instanceof SyntaxError)||configSource!==configPath)throw error;
      fs.copyFileSync(configPath,configPath+'.interrupted-'+Date.now(),fs.constants.COPYFILE_EXCL);
      prior={};
      console.log('Recovered interrupted setup settings. Using PCRC-Workspace; the original settings were kept for recovery.');
    }
  }
  if(configSource===configPath&&typeof prior.workspace==='string'&&fs.existsSync(prior.workspace)&&installed(root)) {
    const health=runner(embeddedPython(root),['-I','-c','import ssl,sqlite3,cryptography,jan_mcp_commander.control,jan_mcp_commander.development,importlib.util; assert importlib.util.find_spec(\"jan_mcp_commander._development_pip\") is not None'],{cwd:root,stdio:['ignore','pipe','pipe'],encoding:'utf8',timeout:10000,windowsHide:true,shell:false});
    if(!health.error&&health.status===0)return root;
    console.log('Repairing the existing PC Remote Commander runtime...');
  }
  fs.rmSync(path.join(root,'npx-install.json'),{force:true});
  fs.cpSync(bundle,root,{recursive:true,force:true,filter:source=>path.relative(bundle,source)!=='connection.json'&&!fs.lstatSync(source).isSymbolicLink()});
  fs.cpSync(websocket,path.join(root,'deploy','npm','jan-commander','node_modules','ws'),{recursive:true,force:true,filter:source=>!fs.lstatSync(source).isSymbolicLink()});
  if(fs.existsSync(path.join(bundle,'deploy','mcp-task-server','dist','main.js'))) {
    if(!fs.existsSync(path.join(modules,'@modelcontextprotocol','server','package.json')))throw Error('The downloaded task-server dependencies are incomplete. Download the package again.');
    fs.cpSync(modules,path.join(root,'node_modules'),{recursive:true,force:true,filter:source=>!fs.lstatSync(source).isSymbolicLink()});
  }
  const scripts=path.join(root,'.venv','Scripts');
  fs.mkdirSync(scripts,{recursive:true});
  fs.cpSync(runtime,scripts,{recursive:true,force:true,filter:source=>!fs.lstatSync(source).isSymbolicLink()});
  const workspace=process.env.JAN_MCP_WORKSPACE||prior.workspace||path.join(require('node:os').homedir(),'PCRC-Workspace');
  fs.mkdirSync(workspace,{recursive:true});
  const configTemporary=configPath+'.'+process.pid+'.tmp';
  fs.writeFileSync(configTemporary,JSON.stringify({...prior,workspace:fs.realpathSync(workspace)},null,2));
  fs.renameSync(configTemporary,configPath);
  console.log('Preparing PC Remote Commander in '+root+'...');
  const result=runner(embeddedPython(root),[path.join(root,'scripts','verify_install.py')],{cwd:root,stdio:['ignore','pipe','inherit'],encoding:'utf8',maxBuffer:1024*1024,windowsHide:true,shell:false});
  if(result.error||result.status!==0)throw Error('Bundled runtime verification failed. Check the message above, then run the command again.');
  console.log('Runtime checks passed.');
  fs.writeFileSync(path.join(root,'npx-install.json'),JSON.stringify({version})+'\n',{flag:'w',mode:0o600});
  return root;
}
async function main(argv=process.argv.slice(2)) {
  if(process.platform!=='win32')throw Error('This preview supports Windows only.');
  if(Number(process.versions.node.split('.')[0])<20)throw Error('Node.js 20 or newer is required.');
  const action=argv[0]??'connect';
  if(['help','--help','-h'].includes(action)) {
    console.log('PC Remote Commander preview\n\nUsage: pcremotecommander [setup|connect|cli|doctor] [options]\nSetup installs the bundled runtime on first run, opens the device approval page, and keeps the secure agent running.\nThe npm package is cached by npx; Python and private workspace state are stored outside that disposable cache.\nRequires Windows and Node.js 20+.');
    return;
  }
  if(!['setup','connect','cli','doctor'].includes(action))throw Error('Use setup, connect, cli, doctor or help.');
  const root=prepare();
  if(action==='doctor') {
    const checks=await require('./doctor.cjs').doctor(root,'https://pc-remote-commander.pcremotecommander.workers.dev');
    for(const [label,ok,help] of checks)console.log((ok===null?'NOT VERIFIED ':ok?'PASS ':'FAIL ')+label+(ok?'':' — '+help));
    if(checks.some(([,ok])=>ok===false))process.exitCode=1;
    return;
  }
  if(action==='cli') {
    const child=spawn(embeddedPython(root),['-m','jan_mcp_commander.cli',...argv.slice(1)],{cwd:root,stdio:'inherit',shell:false,windowsHide:true});
    child.on('error',()=>{console.error('Local CLI could not start.');process.exitCode=1;});
    child.on('exit',(code,signal)=>{process.exitCode=signal?130:code??1;});
    return;
  }
  const options=pairing.parseArgs(connectionArgs(argv).slice(1));
  if(usesBrowserChoice(argv)) {
    options.browserChoice=true;
    options.autoUpgrade=true;
    options.capabilities=fullControl;
  }
  return pairing.run(root,options);
}
if(require.main===module)Promise.resolve().then(()=>main()).catch(error=>{console.error('PC Remote Commander: '+error.message);process.exitCode=1;});
module.exports={installRoot,installed,prepare,usesBrowserChoice,connectionArgs,main};
