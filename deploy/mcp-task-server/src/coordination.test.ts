import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { PythonService } from './bridge.js';
import { createTaskServer } from './server.js';

test('MCP clients receive immediate single-assistant conflicts without creating queue entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pcrc-single-assistant-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  const previous = process.env.JAN_MCP_STATE_DIR;
  process.env.JAN_MCP_STATE_DIR = join(root, 'private');
  const service = new PythonService({
    python: process.env.JAN_TEST_PYTHON || resolve(import.meta.dirname, '../../../.venv/Scripts/python.exe'),
    workspace,
    control: true,
    capabilities: 'files',
  });
  if (previous === undefined) delete process.env.JAN_MCP_STATE_DIR;
  else process.env.JAN_MCP_STATE_DIR = previous;

  const connect = async (name: string) => {
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    const server = createTaskServer(service, { control: true, capabilities: new Set(['files']) });
    const client = new Client({ name, version: '1' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { server, client };
  };
  const a = await connect('single-assistant-a');
  const b = await connect('single-assistant-b');
  const call = async (client: Client, name: string, arguments_: Record<string, unknown>) =>
    client.callTool({ name, arguments: arguments_ });
  const data = (result: Awaited<ReturnType<typeof call>>) => {
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const item = result.content.filter(content => content.type === 'text').at(-1);
    assert.ok(item && item.type === 'text');
    assert.deepEqual(JSON.parse(item.text), result.structuredContent);
    return (result.structuredContent as { data: Record<string, any> }).data;
  };
  try {
    const taskA = data(await call(a.client, 'create_task', { title: 'First task', confirmed: true }));
    const taskB = data(await call(b.client, 'create_task', { title: 'Second task', confirmed: true }));
    const leaseA = data(await call(a.client, 'claim_task', {
      task_id: taskA.id, agent: 'connected-assistant', resources: ['file:a.txt'], confirmed: true,
    }));
    assert.equal(leaseA.status, 'active');

    const blocked = await call(b.client, 'claim_task', {
      task_id: taskB.id, agent: 'same-assistant', resources: ['file:b.txt'], confirmed: true,
    });
    assert.equal((blocked.structuredContent as { error_code: string }).error_code, 'TASK_CONFLICT');

    const listed = data(await call(a.client, 'list_tasks', {}));
    assert.equal(listed.tasks.find((item: { id: string }) => item.id === taskB.id).status, 'queued');
    assert.ok(listed.tasks.every((item: { status: string }) => item.status !== 'waiting'));

    const lease = (item: Record<string, unknown>) => ({ task_id: item.id, lease_token: item.lease_token });
    const writeA = await call(a.client, 'create_text_file', {
      path: 'a.txt', content: 'A', confirmed: true, ...lease(leaseA),
    });
    data(writeA);

    const overlappingWrite = await call(b.client, 'create_text_file', {
      path: 'a.txt', content: 'must not overwrite', confirmed: true,
    });
    assert.equal((overlappingWrite.structuredContent as { error_code: string }).error_code, 'TASK_CONFLICT');

    const outOfScopeWrite = await call(a.client, 'create_text_file', {
      path: 'b.txt', content: 'out of scope', confirmed: true, ...lease(leaseA),
    });
    assert.equal((outOfScopeWrite.structuredContent as { error_code: string }).error_code, 'TASK_SCOPE_DENIED');

    data(await call(a.client, 'finish_task', {
      ...lease(leaseA), status: 'completed', note: 'Created synthetic a.txt', confirmed: true,
    }));
    const leaseB = data(await call(b.client, 'claim_task', {
      task_id: taskB.id, agent: 'connected-assistant', resources: ['file:b.txt'], confirmed: true,
    }));
    assert.equal(leaseB.status, 'active');
    data(await call(b.client, 'create_text_file', {
      path: 'b.txt', content: 'B', confirmed: true, ...lease(leaseB),
    }));
    data(await call(b.client, 'finish_task', {
      ...lease(leaseB), status: 'completed', note: 'Created synthetic b.txt', confirmed: true,
    }));
    assert.ok(!JSON.stringify(listed).includes(String(leaseA.lease_token)));
  } finally {
    await a.client.close();
    await b.client.close();
    await a.server.close();
    await b.server.close();
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
