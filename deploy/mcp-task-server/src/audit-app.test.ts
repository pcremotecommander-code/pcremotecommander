import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {PythonService} from './bridge.js';
import {createTaskServer} from './server.js';

test('approved Notepad launch is followed by visible-window metadata verification',{
 skip:process.platform!=='win32'||process.env.PCRC_NOTEPAD_ACCEPTANCE!=='1',timeout:45000,
},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcrc-audit-app-')),workspace=join(root,'files');await mkdir(workspace);
 const previous=process.env.JAN_MCP_STATE_DIR;process.env.JAN_MCP_STATE_DIR=join(root,'private');
 const service=new PythonService({python:process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe'),workspace,control:true,capabilities:'commands'});
 if(previous===undefined)delete process.env.JAN_MCP_STATE_DIR;else process.env.JAN_MCP_STATE_DIR=previous;
 const [a,b]=InMemoryTransport.createLinkedPair(),server=createTaskServer(service,{control:true,capabilities:new Set(['commands'])});
 const client=new Client({name:'pcrc-audit-app',version:'1'});
 const call=async(name:string,args:Record<string,unknown>)=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return (result.structuredContent as {data:Record<string,any>}).data;};
 try{
  await Promise.all([server.connect(a),client.connect(b)]);
  const list=await call('list_applications',{query:'Notepad'});
  const application=list.applications.find((app:any)=>app.name.toLowerCase()==='notepad');assert.ok(application,'Registered Notepad unavailable');
  assert.equal((await call('open_application',{application:application.app_id,confirmed:true})).launch_requested,true);
  let visible=false;const until=Date.now()+15000;
  while(!visible&&Date.now()<until){
   const result=spawnSync(join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',"if(@(Get-Process Notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0){'VISIBLE'}"],{encoding:'utf8',windowsHide:true,timeout:5000});
   visible=result.status===0&&result.stdout.trim()==='VISIBLE';if(!visible)await delay(100);
  }
  assert.equal(visible,true,'No visible Notepad window observed after approved launch');
 }finally{
  await client.close();await server.close();await service.close();assert.ok(root.startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});
 }
});
