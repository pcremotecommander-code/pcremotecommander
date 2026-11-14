const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {resolveJanSession}=require('../bin/resolve-session.cjs');
test('session resolver uses workspace-scoped private state',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jan-resolver-'));
 try {
  const project=path.join(root,'project'),workspace=path.join(root,'workspace'),state=path.join(root,'state');
  fs.mkdirSync(project);fs.mkdirSync(workspace);fs.mkdirSync(state);
  fs.writeFileSync(path.join(project,'connection.json'),JSON.stringify({workspace}));
  fs.writeFileSync(path.join(state,'device-session.json'),'{}');
  fs.writeFileSync(path.join(state,'http-proxy.key'),'fake-test-credential');
  const result=resolveJanSession(project,{JAN_MCP_STATE_DIR:state});
  assert.equal(result.session,path.join(state,'device-session.json'));
  assert.equal(result.deviceKey,result.localKey);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('missing enrollment reports a clear error',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jan-resolver-'));
 try{
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(root,'connection.json'),JSON.stringify({workspace}));
  assert.throws(()=>resolveJanSession(root,{JAN_MCP_STATE_DIR:path.join(root,'empty')}),/not enrolled/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
