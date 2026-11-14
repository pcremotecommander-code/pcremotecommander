import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

test('foreground HTTP owner pipe closes the local service and keeps tools parent-bound',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pcrc-foreground-test-'));const workspace=join(root,'files');await mkdir(workspace);
  const reserve=createServer().listen(0,'127.0.0.1');await once(reserve,'listening');const address=reserve.address();assert.ok(address&&typeof address!=='string');const port=address.port;
  await new Promise<void>(r=>reserve.close(()=>r()));
  const key=randomBytes(32).toString('base64url');
  const child=spawn(process.execPath,[process.env.PCRC_TEST_TASK_ENTRY||resolve(import.meta.dirname,'main.js'),'--foreground'],{
    env:{...process.env,JAN_MCP_WORKSPACE:workspace,JAN_MCP_STATE_DIR:join(root,'state'),JAN_MCP_PYTHON:process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe'),JAN_MCP_CONTROL:'1',JAN_MCP_CAPABILITIES:'files',JAN_MCP_TRANSPORT:'http',JAN_MCP_PORT:String(port),JAN_MCP_LOCAL_KEY:key},stdio:['pipe','ignore','pipe'],windowsHide:true,
  });
  try{
    let ready=false;
    for(let n=0;n<100;n++){
      try{ready=(await fetch(`http://127.0.0.1:${port}/healthz`,{headers:{authorization:`Bearer ${key}`},signal:AbortSignal.timeout(500)})).status===200;}catch{}
      if(ready)break;await delay(100);
    }
    assert.ok(ready,'Local foreground HTTP server did not start');
    const response=await fetch(`http://127.0.0.1:${port}/mcp`,{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json',accept:'application/json, text/event-stream','X-JAN-Control':'1'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_connection_status',arguments:{}}}),signal:AbortSignal.timeout(15000)});
    assert.equal(response.status,200);
    const body=await response.text();const event=body.split(/\r?\n/).find(line=>line.startsWith('data: '));const message=JSON.parse(event?event.slice(6):body) as {result:{structuredContent:{data:{connection_lifetime:string;control_enabled:boolean}}}};
    assert.equal(message.result.structuredContent.data.connection_lifetime,'until terminal closes');assert.equal(message.result.structuredContent.data.control_enabled,true);
    const exited=once(child,'exit',{signal:AbortSignal.timeout(15000)});child.stdin.end();
    const [code]=await exited;assert.equal(code,0);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`,{signal:AbortSignal.timeout(1000)}));
  }finally{
    if(child.exitCode===null)child.kill();
    assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});
  }
});
