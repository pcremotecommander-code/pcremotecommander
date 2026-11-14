import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,cp,copyFile,rm} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {PythonService} from './bridge.js';
import {createTaskServer} from './server.js';

test('audit media prerequisites: cached preparation, offline speech and reopened enlarged image',{
 skip:process.env.PCRC_MEDIA_ACCEPTANCE!=='1',timeout:120000,
},async()=>{
 const python=process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe');
 const original=join(homedir(),'PCRC-Workspace');
 const result=spawnSync(python,['-c',"import hashlib; from pathlib import Path; p=Path(__import__('sys').argv[1]).resolve(); print(Path.home()/'.local/state/jan-mcp-commander'/hashlib.sha256(str(p).encode()).hexdigest()[:16]/'media')",original],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
 const root=await mkdtemp(join(tmpdir(),'pcrc-audit-media-')),workspace=join(root,'files'),state=join(root,'private');await mkdir(workspace);await mkdir(state);
 const fixture=join(original,'PCRC-QA-beta34-20261109-mw8ayjis/fixtures/advanced');
 await cp(result.stdout.trim(),join(state,'media'),{recursive:true});
 for(const name of ['speech.wav','video.mp4'])await copyFile(join(fixture,name),join(workspace,name));
 const created=spawnSync(python,['-c',"from PIL import Image; import sys; Image.new('RGB',(64,48),'blue').save(sys.argv[1])",join(workspace,'source.png')],{encoding:'utf8',timeout:10000});assert.equal(created.status,0,created.stderr);
 const previous=process.env.JAN_MCP_STATE_DIR;process.env.JAN_MCP_STATE_DIR=state;
 const service=new PythonService({python,workspace,control:true,capabilities:'files,commands'});
 if(previous===undefined)delete process.env.JAN_MCP_STATE_DIR;else process.env.JAN_MCP_STATE_DIR=previous;
 const [a,b]=InMemoryTransport.createLinkedPair(),server=createTaskServer(service,{control:true,capabilities:new Set(['files','commands'])});
 const client=new Client({name:'pcrc-audit-media',version:'1'});
 const call=async(name:string,args:Record<string,unknown>={})=>{
  const result=await client.callTool({name,arguments:{...args,confirmed:true}});assert.equal(result.isError,undefined,JSON.stringify(result));return (result.structuredContent as {data:Record<string,any>}).data;
 };
 try{
  await Promise.all([server.connect(a),client.connect(b)]);
  const prepared=await call('prepare_media',{speech:true});let output:Record<string,any>={running:true};const until=Date.now()+60000;
  while(output.running&&Date.now()<until){output=await call('read_process_output',{session_id:prepared.session_id});if(output.running)await delay(2000);}
  assert.equal(output.running,false);assert.equal(output.exit_code,0);assert.match(output.output,/"speech_ready": true/);
  const transcript=await call('transcribe_audio',{path:'speech.wav',seconds:10});assert.equal(transcript.processing,'offline');assert.match(JSON.stringify(transcript.segments),/synthetic audio test/i);
  const video=await call('inspect_media',{path:'video.mp4',kind:'video',seconds:1});assert.equal(video.width,160);assert.equal(video.height,96);
  const input=await call('inspect_file',{path:'source.png'});
  const edited=await call('edit_media',{path:'source.png',destination:'enlarged.jpg',kind:'image',expected_sha256:input.sha256,width:128,height:96});assert.equal(edited.width,128);assert.equal(edited.height,96);
  const reopened=await call('inspect_media',{path:'enlarged.jpg',kind:'image'});assert.equal(reopened.width,128);assert.equal(reopened.height,96);
 }finally{
  await client.close();await server.close();await service.close();assert.ok(root.startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});
 }
});
