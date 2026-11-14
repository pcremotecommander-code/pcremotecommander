'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {prepare,installed,usesBrowserChoice,connectionArgs}=require('../bin/npx-onboard.cjs');
test('one installer command moves permission choices and repair to the website',()=>{
 assert.equal(usesBrowserChoice(['setup']),true);
 assert.equal(usesBrowserChoice(['connect','--enroll']),true);
 assert.equal(usesBrowserChoice(['setup','--capabilities','files']),false);
});

test('short setup command routes to production and keeps explicit overrides',()=>{
  assert.deepEqual(connectionArgs(['setup']),['connect','--gateway','https://pc-remote-commander.pcremotecommander.workers.dev']);
  assert.deepEqual(connectionArgs(['setup','--gateway','https://example.workers.dev']),['connect','--gateway','https://example.workers.dev']);
  assert.deepEqual(connectionArgs(['connect','--gateway','https://example.workers.dev']),['connect','--gateway','https://example.workers.dev']);
});

test('npx bootstrap copies only bundled project, installs once and keeps the runtime outside its cache',t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'pc-remote-npx-test-'));
  try {
    const bundle=path.join(base,'cache','project'),runtime=path.join(base,'cache','runtime'),websocket=path.join(base,'cache','ws'),root=path.join(base,'app-data','preview');
    fs.mkdirSync(bundle,{recursive:true});
    fs.writeFileSync(path.join(bundle,'pyproject.toml'),'[project]\nname="jan-mcp-commander"\n');
    fs.mkdirSync(path.join(bundle,'scripts'));
    fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime,'python.exe'),'test');
    fs.mkdirSync(websocket);
    fs.writeFileSync(path.join(websocket,'index.js'),'module.exports = {}');
    fs.writeFileSync(path.join(websocket,'package.json'),JSON.stringify({name:'ws',version:'8.22.0'}));
    let calls=0,healthChecks=0,healthy=true;
    const runner=(exe,args,options)=>{
      assert.equal(options.encoding,"utf8");assert.equal(exe,path.join(root,'.venv','Scripts','python.exe'));
      if(args.includes('-c')){healthChecks++;return {status:healthy?0:1};}
      calls++;assert.deepEqual(options.stdio,["ignore","pipe","inherit"]);assert.equal(args.at(-1),path.join(root,'scripts','verify_install.py'));return {status:0};
    };
    t.mock.method(os,'homedir',()=>base);
    const options={root,bundle,runtime,websocket,runner};
    assert.equal(prepare(options),root);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'connection.json'),'utf8')).workspace,fs.realpathSync(path.join(base,'PCRC-Workspace')));
    assert.equal(installed(root),true);
    assert.equal(prepare(options),root);
    assert.equal(calls,1);
    assert.equal(healthChecks,1);
    const custom=path.join(base,'my-project');fs.mkdirSync(custom);
    fs.writeFileSync(path.join(root,'connection.json'),JSON.stringify({workspace:custom}));
    healthy=false;
    assert.equal(prepare(options),root);
    assert.equal(calls,2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'connection.json'),'utf8')).workspace,fs.realpathSync(custom));
    fs.unlinkSync(path.join(root,'npx-install.json'));
    assert.equal(prepare(options),root);
    assert.equal(calls,3);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'connection.json'),'utf8')).workspace,fs.realpathSync(custom));
    fs.unlinkSync(path.join(root,'npx-install.json'));
    fs.writeFileSync(path.join(root,'connection.json'),'{"workspace":');
    assert.equal(prepare(options),root);
    assert.equal(calls,4);
    const preserved=fs.readdirSync(root).find(name=>name.startsWith('connection.json.interrupted-'));
    assert.equal(fs.readFileSync(path.join(root,preserved),'utf8'),'{"workspace":');
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'connection.json'),'utf8')).workspace,fs.realpathSync(path.join(base,'PCRC-Workspace')));
    assert.equal(fs.readFileSync(path.join(root,'pyproject.toml'),'utf8'),'[project]\nname="jan-mcp-commander"\n');
    healthy=true;
    fs.writeFileSync(path.join(root,'connection.json'),'null');
    assert.equal(prepare(options),root);assert.equal(calls,5);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'connection.json'),'utf8')).workspace,fs.realpathSync(path.join(base,'PCRC-Workspace')));
    fs.unlinkSync(path.join(root,'connection.json'));
    assert.equal(prepare(options),root);assert.equal(calls,6);
    assert.ok(fs.statSync(path.join(root,'.venv','Scripts','python.exe')).isFile());
    assert.ok(fs.statSync(path.join(root,'deploy','npm','jan-commander','node_modules','ws','index.js')).isFile());
  } finally {
    assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep));
    fs.rmSync(base,{recursive:true,force:true});
  }
});

test('npx bootstrap carries task-server runtime dependencies into the persistent install',()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'pc-remote-task-deps-'));
 try {
  const bundle=path.join(base,'cache','project'),runtime=path.join(base,'cache','runtime'),websocket=path.join(base,'cache','ws'),modules=path.join(base,'cache','node_modules'),root=path.join(base,'app-data','preview');
  fs.mkdirSync(path.join(bundle,'deploy','mcp-task-server','dist'),{recursive:true});
  fs.writeFileSync(path.join(bundle,'pyproject.toml'),'[project]');
  fs.writeFileSync(path.join(bundle,'deploy','mcp-task-server','dist','main.js'),'');
  fs.mkdirSync(path.join(bundle,'scripts'));
  fs.mkdirSync(runtime);fs.writeFileSync(path.join(runtime,'python.exe'),'test');
  fs.mkdirSync(websocket);fs.writeFileSync(path.join(websocket,'index.js'),'');fs.writeFileSync(path.join(websocket,'package.json'),JSON.stringify({name:'ws',version:'8.22.0'}));
  fs.mkdirSync(path.join(modules,'@modelcontextprotocol','server'),{recursive:true});
  fs.writeFileSync(path.join(modules,'@modelcontextprotocol','server','package.json'),'{}');
  const savedWorkspace=path.join(base,'existing-user-workspace');fs.mkdirSync(savedWorkspace);
  fs.writeFileSync(path.join(bundle,'connection.json'),JSON.stringify({workspace:savedWorkspace}));
  prepare({root,bundle,runtime,websocket,modules,runner:()=>({status:0})});
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'connection.json'),'utf8')).workspace,fs.realpathSync(savedWorkspace));
  assert.ok(fs.existsSync(path.join(root,'node_modules','@modelcontextprotocol','server','package.json')));
 } finally {fs.rmSync(base,{recursive:true,force:true});}
});
