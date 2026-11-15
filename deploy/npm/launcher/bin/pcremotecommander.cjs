#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const https=require('node:https');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {spawn,spawnSync}=require('node:child_process');

const version='0.7.0-beta.44';
const sha256='0aff1a1f5bdc1a7e27fac3b42a9c1a47215ef144bb6f39d624e35f7d0d28ce19';
const url='https://pc-remote-commander.pcremotecommander.workers.dev/downloads/windows/pcremotecommander-0.7.0-beta.44.tgz';
const maximumBytes=100*1024*1024;
const posixInstallerUrl='https://pc-remote-commander.pcremotecommander.workers.dev/install-posix-beta44.sh';
const posixInstallerSha256='bef8e5f9cb0cdfc4cca0b76b3aca8fce2e6dbd1a8a704d0a6e89e9643d19c9f0';

function posixArgs(argv) {
  const action=argv[0]??'setup',rest=argv.slice(1);
  if(action==='cli')return ['--cli',...rest];
  if(rest.length)throw Error('This Linux/macOS beta accepts setup, connect, doctor, uninstall, or cli with its arguments.');
  if(['setup','connect'].includes(action))return ['setup'];
  if(action==='doctor')return ['--doctor'];
  if(action==='uninstall')return ['--uninstall'];
  throw Error('Use setup, connect, doctor, uninstall or cli.');
}
function fetchPosixScript(request=https.get) {
  return new Promise((resolve,reject)=>{
    const req=request(posixInstallerUrl,response=>{
      if(response.statusCode!==200){response.resume();reject(Error('Linux/macOS installer download failed. Retry later.'));return;}
      const chunks=[];let size=0;
      response.on('data',chunk=>{size+=chunk.length;if(size>65536)response.destroy(Error('Installer size exceeded'));else chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(45000,()=>req.destroy(Error('Installer download timed out')));req.on('error',reject);
  });
}
async function runPosix(argv,{home=os.homedir(),platform=process.platform,load=fetchPosixScript,run=spawnSync,expected=posixInstallerSha256}={}) {
  if(!['linux','darwin'].includes(platform))throw Error('Unsupported operating system');
  const args=posixArgs(argv);
  let root=home;
  for(const part of ['.pcrc','launcher',version]){
    root=path.join(root,part);
    if(fs.existsSync(root)&&(!fs.lstatSync(root).isDirectory()||fs.lstatSync(root).isSymbolicLink()))throw Error('Unsafe installer cache directory');
    fs.mkdirSync(root,{recursive:true,mode:0o700});
  }
  const script=path.join(root,'install.sh');
  if(fs.existsSync(script)&&(!fs.lstatSync(script).isFile()||fs.lstatSync(script).isSymbolicLink()))throw Error('Unsafe installer cache file');
  if(!verified(script,expected)){
    const bytes=await load();
    if(!Buffer.isBuffer(bytes)||bytes.length>65536||crypto.createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Linux/macOS installer integrity verification failed');
    const temporary=script+'.'+crypto.randomBytes(8).toString('hex');
    try {fs.writeFileSync(temporary,bytes,{flag:'wx',mode:0o600});fs.renameSync(temporary,script);}finally{fs.rmSync(temporary,{force:true});}
  }
  const child=run('bash',[script,...args],{stdio:'inherit',shell:false});
  if(child.error)throw Error('Could not start Bash. Use the Terminal setup guide.');
  process.exitCode=child.signal?130:child.status??1;
}

function cacheRoot(env=process.env) {
  if(process.platform!=='win32'||!env.LOCALAPPDATA||!path.isAbsolute(env.LOCALAPPDATA))throw Error('This beta requires Windows with a normal user profile.');
  return path.join(env.LOCALAPPDATA,'PCRemoteCommander','packages',version);
}
function shaFile(file) {
  const hash=crypto.createHash('sha256');
  const fd=fs.openSync(file,'r');
  try {const buffer=Buffer.allocUnsafe(1024*1024);for(;;){const length=fs.readSync(fd,buffer,0,buffer.length,null);if(!length)break;hash.update(buffer.subarray(0,length));}} finally {fs.closeSync(fd);}
  return hash.digest('hex');
}
function verified(file,expected=sha256) {return fs.existsSync(file)&&shaFile(file)===expected;}
function validateEntries(output) {
  const entries=output.split(/\r?\n/).filter(Boolean);
  if(!entries.length)throw Error('Downloaded runtime archive is empty.');
  for(const entry of entries) {
    const parts=entry.split('/');
    if(parts[0]!=='package'||entry.startsWith('/')||entry.includes('\\')||parts.some(part=>part==='..'))throw Error('Downloaded runtime archive has an unsafe path.');
  }
  return entries.length;
}
function download(file,request=https.get,report=console.log) {
  return new Promise((resolve,reject)=>{
    const output=fs.createWriteStream(file,{flags:'wx',mode:0o600});
    output.on('error',reject);
    const req=request(url,response=>{
      if(response.statusCode!==200){response.resume();output.destroy();reject(Error(`Runtime download failed (HTTP ${response.statusCode}). Try again later.`));return;}
      const length=Number(response.headers['content-length']);
      if(!Number.isFinite(length)||length<1||length>maximumBytes){response.resume();output.destroy();reject(Error('Runtime download has an invalid size.'));return;}
      let received=0;const started=Date.now();let reported=started;
      report('Runtime download: 0 / '+(length/1e6).toFixed(1)+' MB (0%)');
      response.on('data',chunk=>{
        received+=chunk.length;
        if(received>maximumBytes){response.destroy(Error('Runtime download exceeded its size limit.'));return;}
        const now=Date.now();
        if(received<=length&&(now-reported>=5000||received===length)) {
          report('Runtime download: '+(received/1e6).toFixed(1)+' / '+(length/1e6).toFixed(1)+' MB ('+Math.floor(received/length*100)+'%) · '+(received/1e6/Math.max((now-started)/1000,0.001)).toFixed(1)+' MB/s');reported=now;
        }
      });
      pipeline(response,output).then(()=>received===length?resolve():reject(Error('Runtime download was incomplete.')),reject);
    });
    req.setTimeout(120000,()=>req.destroy(Error('Runtime download timed out.')));
    req.on('error',error=>{output.destroy();reject(error);});
  });
}
async function ensurePayload({root=cacheRoot(),fetchArchive=download,runTar=spawnSync,expected=sha256}={}) {
  const payload=path.join(root,'package');
  const archive=path.join(root,'runtime.tgz');
  const entry=path.join(payload,'bin','npx-onboard.cjs');
  fs.mkdirSync(root,{recursive:true});
  if(fs.lstatSync(root).isSymbolicLink())throw Error('Runtime cache cannot be a symbolic link.');
  const required=['bin/npx-onboard.cjs','project/pyproject.toml','project/scripts/verify_install.py','runtime/python.exe'];
  if(required.every(name=>fs.existsSync(path.join(payload,name)))&&verified(archive,expected))return entry;
  if(!verified(archive,expected)) {
    const temporary=path.join(root,`runtime-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tgz`);
    try {
      console.log('Downloading the pinned PC Remote Commander runtime...');
      await fetchArchive(temporary);
      if(!verified(temporary,expected))throw Error('Runtime SHA-256 verification failed. No downloaded code was run.');
      if(fs.existsSync(archive))fs.rmSync(archive,{force:true});
      fs.renameSync(temporary,archive);
    } finally {fs.rmSync(temporary,{force:true});}
  }
  const staging=fs.mkdtempSync(path.join(root,'unpack-'));
  try {
    const listing=runTar('tar.exe',['-tzf',archive],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
    if(listing.error||listing.status!==0)throw Error('Could not inspect the runtime archive. Windows tar.exe is required.');
    validateEntries(listing.stdout);
    const extracted=runTar('tar.exe',['-xzf',archive,'-C',staging],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
    if(extracted.error||extracted.status!==0)throw Error('Could not unpack the verified runtime archive.');
    if(!fs.existsSync(path.join(staging,'package','bin','npx-onboard.cjs')))throw Error('Verified runtime archive is missing its launcher.');
    if(path.relative(root,payload)!=='package')throw Error('Unsafe runtime cache path.');
    if(fs.existsSync(payload))fs.rmSync(payload,{recursive:true,force:true});
    fs.renameSync(path.join(staging,'package'),payload);
  } finally {fs.rmSync(staging,{recursive:true,force:true});}
  return entry;
}
function runtimeArgs(argv) {
  const action=argv[0]??'connect';
  if(!['setup','connect'].includes(action)||argv.includes('--gateway'))return argv;
  return [action,...argv.slice(1),'--gateway','https://pc-remote-commander.pcremotecommander.workers.dev'];
}
function showWelcome(run=spawnSync,output=process.stdout,env=process.env) {
  if(!output.isTTY||env.NO_COLOR||env.TERM==='dumb'||(output.columns??80)<45||(output.rows??24)<8){output.write('PC REMOTE COMMANDER\n');return;}
  const executable=path.join(env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const command="$s=[IO.File]::ReadAllText($env:PCRC_ANIMATION); & ([ScriptBlock]::Create($s.Substring($s.LastIndexOf('# START FILM')+12)))";
  const result=run(executable,['-NoLogo','-NoProfile','-Command',command],{env:{...env,PCRC_ANIMATION:path.join(__dirname,'PCRC-retro-wide.cmd')},stdio:'inherit',windowsHide:true,shell:false});
  if(result.error||result.status!==0)output.write('PC REMOTE COMMANDER\n');
}
async function main(argv=process.argv.slice(2)) {
  if(Number(process.versions.node.split('.')[0])<20)throw Error('Node.js 20 or newer is required.');
  if(['help','--help','-h'].includes(argv[0])) {
    console.log('PC Remote Commander beta\n\nUsage: pcremotecommander [setup|connect|cli|doctor] [options]\nSetup downloads a pinned runtime, verifies its SHA-256, then starts pairing. Windows/Linux/macOS with Node.js 20+. Linux/macOS also need Python 3.11+ and venv.');
    return;
  }
  if(process.platform!=='win32')return runPosix(argv);
  if(['setup','connect'].includes(argv[0]??'connect'))showWelcome();
  const entry=await ensurePayload();
  const child=spawn(process.execPath,[entry,...runtimeArgs(argv)],{stdio:'inherit',windowsHide:false,shell:false});
  child.on('error',error=>{console.error('PC Remote Commander runtime could not start: '+error.message);process.exitCode=1;});
  child.on('exit',(code,signal)=>{process.exitCode=signal?130:code??1;});
}
if(require.main===module)main().catch(error=>{console.error('PC Remote Commander: '+error.message);process.exitCode=1;});
module.exports={cacheRoot,shaFile,verified,validateEntries,ensurePayload,runtimeArgs,showWelcome,download,main,posixArgs,runPosix,fetchPosixScript};
