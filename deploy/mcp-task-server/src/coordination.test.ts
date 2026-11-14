import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { PythonService } from './bridge.js';
import { createTaskServer } from './server.js';

test('four MCP clients share real assignments and queue overlapping claims without bypassing legacy guards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pcrc-team-'));
  const workspace = join(root, 'workspace'); await mkdir(workspace);
  const previous = process.env.JAN_MCP_STATE_DIR; process.env.JAN_MCP_STATE_DIR = join(root, 'private');
  const service = new PythonService({ python: resolve(import.meta.dirname, '../../../.venv/Scripts/python.exe'), workspace, control: true, capabilities: 'files' });
  if (previous === undefined) delete process.env.JAN_MCP_STATE_DIR; else process.env.JAN_MCP_STATE_DIR = previous;
  const connect = async (name: string) => {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const server = createTaskServer(service, { control: true, capabilities: new Set(['files']) });
    const client = new Client({ name, version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { server, client };
  };
  const a = await connect('synthetic-chatgpt'), b = await connect('synthetic-claude'), c = await connect('synthetic-cursor'), d=await connect('synthetic-fourth-client');
  const call = async (client: Client, name: string, arguments_: Record<string, unknown>) => client.callTool({ name, arguments: arguments_ });
  const data = (result: Awaited<ReturnType<typeof call>>) => {
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const text=result.content.filter(c=>c.type==='text').at(-1);assert.ok(text&&text.type==='text');
    assert.deepEqual(JSON.parse(text.text),result.structuredContent);
    return (result.structuredContent as { data: Record<string, unknown> }).data;
  };
  try {
    const [ta, tb] = await Promise.all([call(a.client, 'create_task', { title: 'Implement', confirmed: true }), call(b.client, 'create_task', { title: 'Test', confirmed: true })]);
    const la = data(await call(a.client, 'claim_task', { task_id: data(ta).id, agent: 'A', resources: ['file:a.txt'], confirmed: true }));
    const lb = data(await call(b.client, 'claim_task', { task_id: data(tb).id, agent: 'B', resources: ['file:b.txt'], confirmed: true }));
    const tc = data(await call(c.client, 'create_task', { title: 'Review', confirmed: true }));
    const lc = data(await call(c.client, 'claim_task', { task_id: tc.id, agent: 'C', resources: ['file:c.txt'], confirmed: true }));
    const fourth = data(await call(c.client, 'create_task', { title: 'Wait', confirmed: true }));
    const ld = data(await call(d.client, 'claim_task', { task_id: fourth.id, agent: 'D', resources: ['file:d.txt'], confirmed: true }));
    assert.equal(ld.status,'active');
    const fifth=data(await call(c.client,'create_task',{title:'Queued same-file review',confirmed:true}));
    const waiting=data(await call(c.client,'claim_task',{task_id:fifth.id,agent:'Reviewer',resources:['file:a.txt'],confirmed:true}));
    assert.equal(waiting.status,'waiting');
    const lease = (l: Record<string, unknown>) => ({ task_id: l.id, lease_token: l.lease_token });
    const writes = await Promise.all([call(a.client, 'create_text_file', { path: 'a.txt', content: 'A', confirmed: true, ...lease(la) }), call(b.client, 'create_text_file', { path: 'b.txt', content: 'B', confirmed: true, ...lease(lb) }), call(c.client, 'create_text_file', { path: 'c.txt', content: 'C', confirmed: true, ...lease(lc) }),call(d.client,'create_text_file',{path:'d.txt',content:'D',...lease(ld)})]);
    writes.forEach(data);
    const notActive=await call(c.client,'create_text_file',{path:'a.txt',content:'must not execute',...lease(waiting)});
    assert.equal((notActive.structuredContent as {error_code:string}).error_code,'TASK_LEASE_REQUIRED');
    const conflict = await call(b.client, 'create_text_file', { path: 'a.txt', content: 'wrong', confirmed: true });
    assert.equal((conflict.structuredContent as { error_code: string }).error_code, 'TASK_CONFLICT');
    const outside = await call(b.client, 'create_text_file', { path: 'a.txt', content: 'wrong', confirmed: true, ...lease(lb) });
    assert.equal((outside.structuredContent as { error_code: string }).error_code, 'TASK_SCOPE_DENIED');
    const shared = await b.client.readResource({ uri: 'app://pcrc/tasks/recent' });
    assert.ok(!JSON.stringify(shared).includes(String(la.lease_token)));
    assert.equal(data(await call(a.client, 'finish_task', { ...lease(la), status: 'completed', note: 'Created synthetic a.txt', confirmed: true })).status, 'completed');
    assert.equal(data(await call(c.client,'renew_task',{...lease(waiting),confirmed:true})).status,'active');
    assert.equal(data(await call(c.client,'finish_task',{...lease(waiting),status:'completed',confirmed:true})).status,'completed');
    assert.equal(data(await call(b.client, 'finish_task', { ...lease(lb), status: 'completed', confirmed: true })).status, 'completed');
    assert.equal(data(await call(c.client, 'finish_task', { ...lease(lc), status: 'completed', confirmed: true })).status, 'completed');
    assert.equal(data(await call(d.client,'finish_task',{...lease(ld),status:'completed',confirmed:true})).status,'completed');
  } finally {
    await a.client.close(); await b.client.close(); await c.client.close();await d.client.close(); await a.server.close(); await b.server.close(); await c.server.close();await d.server.close(); await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
