import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('development public catalog and real reviewed managed Python environment', {timeout:120000},async(t)=>{
 const root=await mkdtemp(join(tmpdir(),'pcrc-development-')),workspace=join(root,'files');await mkdir(workspace);
 const transport=new StdioClientTransport({command:process.execPath,args:[process.env.PCRC_TEST_TASK_ENTRY||resolve(import.meta.dirname,'main.js'),'--foreground'],env:{...process.env,JAN_MCP_WORKSPACE:workspace,JAN_MCP_STATE_DIR:join(root,'private'),JAN_MCP_PYTHON:process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe'),JAN_MCP_CONTROL:'1',JAN_MCP_CAPABILITIES:'files,commands'},stderr:'pipe'});
 const client=new Client({name:'pcrc-development-acceptance',version:'1'});
 const call=async(name:string,args:Record<string,unknown>={})=>{const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));return (result.structuredContent as {data:Record<string,any>}).data;};
 const wait=async(value:Record<string,any>)=>{const deadline=Date.now()+60000;while(['preparing','applying','queued_for_apply'].includes(value.status)){assert.ok(Date.now()<deadline);await delay(750);value=await call('get_development_change',{plan_id:value.plan_id});}return value;};
 try{
  await client.connect(transport);
  const tools=(await client.listTools()).tools;
  for(const name of ['inspect_development','preview_development_change','apply_development_change','get_development_change'])assert.ok(tools.some(t=>t.name===name));
  assert.equal(tools.find(t=>t.name==='apply_development_change')?.annotations?.destructiveHint,true);
  assert.equal(tools.find(t=>t.name==='preview_development_change')?.annotations?.openWorldHint,true);
  if(process.env.PCRC_EXPECT_VERSION)assert.equal((await call('get_connection_status')).version,process.env.PCRC_EXPECT_VERSION);
  const found=await call('inspect_development',{action:'runtime.list'});
  const runtime=found.runtimes.find((r:any)=>r.valid&&!r.pcrc_internal&&r.prefix===r.base_prefix&&r.modules.venv&&r.modules.ensurepip);
  if(!runtime){assert.ok(Array.isArray(found.runtimes));return t.skip('No separate full Python runtime is available for environment creation');}
  const plan=await wait(await call('preview_development_change',{action:'environment.create',options:{runtime:runtime.executable,imports:['json']}}));
  assert.equal(plan.status,'previewed');assert.ok(plan.review_sha256);
  assert.equal((await client.callTool({name:'apply_development_change',arguments:{plan_id:plan.plan_id,review_sha256:plan.review_sha256}})).isError,true);
  const applied=await wait(await call('apply_development_change',{plan_id:plan.plan_id,review_sha256:plan.review_sha256,confirmed:true}));
  assert.equal(applied.status,'completed',JSON.stringify(applied));assert.deepEqual(applied.result.imports_verified,['json']);
  const check=await call('inspect_development',{action:'package.check'});assert.equal(check.exit_code,0);
  assert.equal((await client.callTool({name:'apply_development_change',arguments:{plan_id:plan.plan_id,review_sha256:plan.review_sha256,confirmed:true}})).isError,true);
  console.log(JSON.stringify({managed_environment_created:true,imports_verified:applied.result.imports_verified,package_check_exit:check.exit_code,replay_rejected:true}));
 }finally{await client.close();await rm(root,{recursive:true,force:true});}
});
