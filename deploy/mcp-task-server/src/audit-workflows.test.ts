import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {PythonService} from './bridge.js';
import {createTaskServer} from './server.js';

test('audit blockers: real teaching, reviewed replay, failed-run reconciliation and isolated shutdown', {timeout:120000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcrc-audit-workflow-')),workspace=join(root,'files');await mkdir(workspace);
 const http=createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end(req.url==='/done'?'<p>Done synthetic workflow</p>':'<a href="/done">Continue</a>');});
 await new Promise<void>(resolve=>http.listen(0,'127.0.0.1',resolve));
 const address=http.address();assert.ok(address&&typeof address==='object');
 const origin='http://127.0.0.1:'+address.port;
 const previous=process.env.JAN_MCP_STATE_DIR;process.env.JAN_MCP_STATE_DIR=join(root,'private');
 const service=new PythonService({python:process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe'),workspace,control:true,capabilities:'files,browser,commands',browserChannel:process.env.JAN_MCP_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':'chromium')});
 if(previous===undefined)delete process.env.JAN_MCP_STATE_DIR;else process.env.JAN_MCP_STATE_DIR=previous;
 const [a,b]=InMemoryTransport.createLinkedPair();const server=createTaskServer(service,{control:true,capabilities:new Set(['files','browser','commands'])});
 const client=new Client({name:'pcrc-audit-workflow',version:'1'});let lease:Record<string,any>={};
 const call=async(name:string,args:Record<string,unknown>={},assigned=false)=>{
  const result=await client.callTool({name,arguments:{...args,...(assigned?{task_id:lease.id,lease_token:lease.lease_token}:{}),confirmed:true}});
  assert.equal(result.isError,undefined,JSON.stringify(result));return (result.structuredContent as {data:Record<string,any>}).data;
 };
 try{
  await Promise.all([server.connect(a),client.connect(b)]);
  const task=await call('create_task',{title:'Disposable workflow acceptance'});
  lease=await call('claim_task',{task_id:task.id,agent:'synthetic QA',resources:['ui']});
  await call('navigate_browser',{url:origin+'/'},true);
  await call('teach_browser_workflow',{action:'start',title:'Unique clean link'},true);
  await call('interact_browser',{action:'click',target:'a[href="/done"]'},true);
  const draft=await call('teach_browser_workflow',{action:'finish'},true);assert.equal(draft.status,'draft');assert.equal(draft.steps.length,2);
  const details=await call('inspect_workflow',{kind:'workflow',identifier:draft.id});assert.equal(details.id,draft.id);
  await call('publish_workflow',{workflow_id:draft.id,expected_text:'Done synthetic workflow',reviewed:true},true);
  const run=await call('start_workflow_run',{workflow_id:draft.id},true);
  await call('run_workflow_step',{run_id:run.id,expected_step:0},true);
  assert.equal((await call('run_workflow_step',{run_id:run.id,expected_step:1},true)).status,'passed');
  assert.equal((await call('inspect_workflow',{kind:'run',identifier:run.id})).status,'passed');
  await call('publish_workflow',{workflow_id:draft.id,expected_text:'Synthetic missing completion marker',reviewed:true},true);
  const failed=await call('start_workflow_run',{workflow_id:draft.id},true);
  await call('run_workflow_step',{run_id:failed.id,expected_step:0},true);
  assert.equal((await call('run_workflow_step',{run_id:failed.id,expected_step:1},true)).status,'failed');
  assert.ok(JSON.stringify(await call('inspect_browser_page',{},true)).includes('Done synthetic workflow'));
  assert.equal((await call('reconcile_task',{task_id:lease.id,reviewed:true})).status,'queued');
  lease=await call('claim_task',{task_id:task.id,agent:'synthetic QA cleanup',resources:['ui']});
  assert.equal((await call('delete_workflow',{workflow_id:draft.id},true)).deleted,draft.id);
  await call('finish_task',{task_id:lease.id,lease_token:lease.lease_token,status:'completed'});
  await call('shutdown');assert.equal((await call('get_capabilities')).control_enabled,false);
 }finally{
  await client.close();await server.close();await service.close();await new Promise<void>(resolve=>http.close(()=>resolve()));await rm(root,{recursive:true,force:true});
 }
});
