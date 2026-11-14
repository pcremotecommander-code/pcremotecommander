'use strict';
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
function resolveJanSession(project,environment=process.env){
  const root=path.resolve(project);
  const connection=path.join(root,'connection.json');
  if(!fs.existsSync(connection))throw Error('PCRC workspace has not been configured');
  const data=JSON.parse(fs.readFileSync(connection,'utf8').replace(/^\uFEFF/,''));
  const workspace=environment.JAN_MCP_WORKSPACE||data.workspace;
  if(typeof workspace!=='string'||!path.isAbsolute(workspace)||!fs.statSync(workspace).isDirectory())throw Error('PCRC workspace unavailable');
  const absolute=fs.realpathSync(workspace);
  const hash=crypto.createHash('sha256').update(absolute).digest('hex').slice(0,16);
  const stateRoot=environment.JAN_MCP_STATE_DIR||path.join(os.homedir(),'.local','state','jan-mcp-commander',hash);
  const session=path.join(stateRoot,'device-session.json');
  const key=path.join(stateRoot,'http-proxy.key');
  if(!fs.existsSync(session)||!fs.existsSync(key))throw Error('PCRC device not enrolled: visit the PC Remote Commander device portal');
  if(!fs.statSync(session).isFile()||!fs.statSync(key).isFile())throw Error('Invalid PCRC private-state files');
  return {session,deviceKey:key,localKey:key,workspace:absolute};
}
module.exports={resolveJanSession};
