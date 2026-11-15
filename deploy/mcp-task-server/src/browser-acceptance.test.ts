import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('published browser tools navigate, inspect, fill, click, capture and reload a synthetic page',{timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcrc-browser-acceptance-')),workspace=join(root,'files');await mkdir(workspace);
 const web=createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>PCRC synthetic browser</title><label>Message<input id="message"></label><button id="save" onclick="document.getElementById(\'out\').textContent=\'Saved \'+document.getElementById(\'message\').value">Save</button><p id="out">Ready</p>');});
 await new Promise<void>(resolve=>web.listen(0,'127.0.0.1',resolve));const address=web.address();assert.ok(address&&typeof address==='object');
 const origin='http://127.0.0.1:'+address.port;
 const transport=new StdioClientTransport({command:process.execPath,args:[process.env.PCRC_TEST_TASK_ENTRY||resolve(import.meta.dirname,'main.js'),'--foreground'],env:{...process.env,JAN_MCP_WORKSPACE:workspace,JAN_MCP_STATE_DIR:join(root,'private'),JAN_MCP_PYTHON:process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe'),JAN_MCP_CONTROL:'1',JAN_MCP_CAPABILITIES:'files,browser',JAN_MCP_BROWSER_CHANNEL:process.env.JAN_MCP_BROWSER_CHANNEL||(process.platform==='win32'?'msedge':'chromium')},stderr:'pipe'});
 const client=new Client({name:'pcrc-browser-acceptance',version:'1'});let lease:Record<string,any>|undefined;
 const calls:Array<{tool:string;ms:number}>=[];const checks:Record<string,boolean>={};
 const call=async(name:string,args:Record<string,unknown>={},assigned=false)=>{
  const start=performance.now();const value=await client.callTool({name,arguments:{...args,...(assigned?{task_id:lease!.id,lease_token:lease!.lease_token}:{})}});
  assert.equal(value.isError,undefined,JSON.stringify(value));calls.push({tool:name,ms:Math.round(performance.now()-start)});
  return value;
 };
 const data=(value:Awaited<ReturnType<typeof call>>)=>(value.structuredContent as {data:Record<string,any>}).data;
 try{
  await client.connect(transport);
  const version=data(await call('get_connection_status')).version;if(process.env.PCRC_EXPECT_VERSION)assert.equal(version,process.env.PCRC_EXPECT_VERSION);
  const task=data(await call('create_task',{title:'Disposable browser acceptance',confirmed:true}));
  lease=data(await call('claim_task',{task_id:task.id,agent:'PCRC browser fixture QA',resources:['ui'],confirmed:true}));assert.equal(lease!.status,'active');
  await call('navigate_browser',{url:origin,confirmed:true},true);
  assert.ok(JSON.stringify(data(await call('inspect_browser_page',{},true))).includes('Ready'));checks.navigation_and_page_inspection=true;
  await call('list_browser_tabs',{},true);checks.tab_discovery=true;
  await call('interact_browser',{action:'fill',target:'#message',text:'PCRC_BROWSER_OK',confirmed:true},true);
  await call('interact_browser',{action:'click',target:'#save',confirmed:true},true);
  assert.ok(JSON.stringify(data(await call('inspect_browser_page',{},true))).includes('Saved PCRC_BROWSER_OK'));checks.element_fill_click_readback=true;
  const image=await call('capture_browser',{},true);assert.ok(image.content.some(c=>c.type==='image'));checks.browser_screenshot=true;
  await call('manage_browser_tab',{action:'reload',confirmed:true},true);
  assert.ok(JSON.stringify(data(await call('inspect_browser_page',{},true))).includes('Ready'));checks.tab_reload=true;
  await call('finish_task',{task_id:lease!.id,lease_token:lease!.lease_token,status:'completed',confirmed:true});lease=undefined;
  console.log(JSON.stringify({version,public_gateway_test:false,packaged_client:Boolean(process.env.PCRC_TEST_TASK_ENTRY),checks,calls}));
 }finally{
  if(lease)await call('finish_task',{task_id:lease.id,lease_token:lease.lease_token,status:'failed',confirmed:true}).catch(()=>undefined);
  await client.close();await new Promise<void>(resolve=>web.close(()=>resolve()));assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});
 }
});
