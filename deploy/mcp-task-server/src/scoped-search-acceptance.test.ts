import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('actual MCP client finds a scoped phrase after two empty continuation batches',{timeout:60000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcrc-scoped-search-')),workspace=join(root,'files');
 await mkdir(join(workspace,'qa'),{recursive:true});
 for(let i=0;i<85;i++)await writeFile(join(workspace,'qa',`file-${String(i).padStart(2,'0')}.txt`),i===84?'PCRC_SYNTHETIC_SCOPED_NEEDLE':'ordinary synthetic text');
 await writeFile(join(workspace,'outside.txt'),'PCRC_SYNTHETIC_SCOPED_NEEDLE');
 const transport=new StdioClientTransport({command:process.execPath,args:[process.env.PCRC_TEST_TASK_ENTRY||resolve(import.meta.dirname,'main.js')],env:{...process.env,JAN_MCP_WORKSPACE:workspace,JAN_MCP_STATE_DIR:join(root,'private'),JAN_MCP_PYTHON:process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe')},stderr:'pipe'});
 const client=new Client({name:'pcrc-scoped-search-acceptance',version:'1'});
 const call=async(name:string,args:Record<string,unknown>)=>{
  const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined,JSON.stringify(result));
  return (result.structuredContent as {data:Record<string,any>}).data;
 };
 try{
  await client.connect(transport);
  const tool=(await client.listTools()).tools.find(t=>t.name==='search_workspace');
  assert.ok(tool?.inputSchema.properties?.path,'the MCP catalog must expose the scope');
  let page=await call('search_workspace',{query:'PCRC_SYNTHETIC_SCOPED_NEEDLE',path:'qa',mode:'text',paginate:true});
  const matches:unknown[]=[];let batches=0;
  for(;;){
   matches.push(...page.matches);batches++;
   if(page.next_offset===null)break;
   assert.ok(batches<5);page=await call('get_more_search_results',{search_id:page.search_id,offset:page.next_offset});
  }
  assert.deepEqual(matches,[{path:'qa/file-84.txt',line:1,text:'PCRC_SYNTHETIC_SCOPED_NEEDLE'}]);
  assert.equal(batches,3);assert.equal(page.partial,false);assert.equal(page.truncated,false);
  const names=await call('search_workspace',{query:'file-84',path:'qa'});assert.deepEqual(names.matches,['qa/file-84.txt']);
  const denied=await client.callTool({name:'search_workspace',arguments:{query:'needle',path:'../outside',mode:'text'}});assert.equal(denied.isError,true);
 }finally{await client.close();await rm(root,{recursive:true,force:true});}
});
