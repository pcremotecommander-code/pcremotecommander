const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {shaFile,verified,validateEntries,ensurePayload,runtimeArgs,showWelcome,download}=require('../bin/pcremotecommander.cjs');

test('current release installer and README references match the npm version',()=>{
 const version=require('../package.json').version,short='beta'+version.split('-beta.')[1];
 const readme=fs.readFileSync(path.join(__dirname,'../README.md'),'utf8');
 assert.ok(readme.includes('/install-posix-'+short+'.sh'));
 const script=fs.readFileSync(path.resolve(__dirname,'../../../cloudflare/worker/public/install.ps1'),'utf8');
 assert.ok(script.includes("'pcremotecommander-"+short+".cjs'"));
});

test('uploaded retro animation is exact and only runs in a capable interactive terminal',()=>{
  const source=path.join(__dirname,'../bin/PCRC-retro-wide.cmd');
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(source)).digest('hex'),'c1145849708e7af719b12a94c99718b8a47a15c5efee25423d1cfae8678f5222');
  const lines=[],calls=[];const output={isTTY:true,columns:100,rows:30,write:text=>lines.push(text)};
  const run=(exe,args,options)=>{calls.push({exe,args,options});return {status:0};};
  showWelcome(run,output,{SystemRoot:'C:\\Windows'});
  assert.equal(calls.length,1);assert.ok(calls[0].exe.endsWith('WindowsPowerShell'+path.sep+'v1.0'+path.sep+'powershell.exe'));
  assert.equal(calls[0].options.env.PCRC_ANIMATION,source);assert.equal(calls[0].options.shell,false);
  assert.match(calls[0].args.at(-1),/# START FILM/);assert.equal(lines.length,0);
  for(const [screen,env] of [[{...output,isTTY:false},{}],[output,{NO_COLOR:'1'}],[output,{TERM:'dumb'}],[{...output,columns:40},{}]])showWelcome(run,screen,env);
  assert.equal(calls.length,1);assert.deepEqual(lines,Array(4).fill('PC REMOTE COMMANDER\n'));
  showWelcome(()=>({status:1}),output,{});assert.equal(lines.at(-1),'PC REMOTE COMMANDER\n');
});

test('standard setup and reconnect use production; local CLI and explicit gateway stay unchanged',()=>{
  const gateway='https://pc-remote-commander.pcremotecommander.workers.dev';
  for(const action of ['setup','connect'])assert.deepEqual(runtimeArgs([action]),[action,'--gateway',gateway]);
  assert.deepEqual(runtimeArgs([]),['connect','--gateway',gateway]);
  assert.deepEqual(runtimeArgs(['setup','--duration-minutes','5']),['setup','--duration-minutes','5','--gateway',gateway]);
  for(const args of [['cli','skills','list'],['doctor'],['setup','--gateway','https://custom.example.workers.dev']])assert.deepEqual(runtimeArgs(args),args);
});

test('archive entries stay under package',()=>{
  assert.equal(validateEntries('package/\npackage/bin/npx-onboard.cjs\n'),2);
  for(const item of ['/etc/passwd','package/../escape','other/file','package\\escape'])assert.throws(()=>validateEntries(item));
});

test('integrity failure stops before unpacking or executing',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcrc-bad-bundle-'));
  try {
    await assert.rejects(ensurePayload({root,expected:'0'.repeat(64),fetchArchive:async file=>fs.writeFileSync(file,'synthetic bundle'),runTar:()=>{throw Error('tar should not run');}}),/SHA-256 verification failed/);
    assert.equal(fs.existsSync(path.join(root,'package')),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});

test('pinned full bundle unpacks and is reused without a second download',async t=>{
  const source=path.resolve(__dirname,'../../../../work/beta44-input-pack/pcremotecommander-0.7.0-beta.44.tgz');
  if(!fs.existsSync(source))return t.skip('local full-bundle artifact unavailable');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcrc-good-bundle-'));
  let downloads=0;
  try {
    assert.equal(shaFile(source),'0aff1a1f5bdc1a7e27fac3b42a9c1a47215ef144bb6f39d624e35f7d0d28ce19');
    const options={root,fetchArchive:async file=>{downloads++;fs.copyFileSync(source,file);}};
    const entry=await ensurePayload(options);
    assert.equal(fs.existsSync(entry),true);
    assert.equal(verified(path.join(root,'runtime.tgz')),true);
    assert.equal(await ensurePayload(options),entry);
    assert.equal(downloads,1);
    fs.unlinkSync(path.join(root,'package','runtime','python.exe'));
    assert.equal(await ensurePayload(options),entry);
    assert.ok(fs.existsSync(path.join(root,'package','runtime','python.exe')));
    assert.equal(downloads,1,'repair reuses the verified archive instead of downloading again');
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});


test('download reports byte progress and preserves the exact archive stream',async()=>{
  const {Readable}=require('node:stream');const {EventEmitter}=require('node:events');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'pcrc-progress-'));const file=path.join(root,'archive.tgz');
  const bytes=Buffer.from([0,1,128,255]);const messages=[];
  const request=(_url,callback)=>{const req=new EventEmitter();req.setTimeout=()=>req;req.destroy=error=>req.emit('error',error);queueMicrotask(()=>{const response=Readable.from([bytes]);response.statusCode=200;response.headers={'content-length':String(bytes.length)};callback(response);});return req;};
  try {await download(file,request,message=>messages.push(message));assert.deepEqual(fs.readFileSync(file),bytes);assert.ok(messages.some(message=>message.includes('100%')));assert.ok(messages.every(message=>!message.includes('https://')));}
  finally {fs.rmSync(root,{recursive:true,force:true});}
});
