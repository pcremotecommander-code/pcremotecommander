import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const project = resolve(import.meta.dirname, '../../..');
const python = process.env.JAN_TEST_PYTHON || join(project, '.venv', 'Scripts', 'python.exe');

test('task MCP exposes tools, resources and prompts while preserving read-only backend', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pcrc-task-mcp-'));
  const file = 'marker.txt';
  await writeFile(join(workspace, file), 'alpha\nbeta\ngamma\n');
  await mkdir(join(workspace, 'nested'));
  await writeFile(join(workspace, 'nested', 'sample.txt'), 'nested marker');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(import.meta.dirname, 'main.js')],
    env: { ...process.env, JAN_MCP_WORKSPACE: workspace, JAN_MCP_PYTHON: python, JAN_MCP_CONTROL: '0' } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'task-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.length >= 7);
    assert.ok(tools.tools.some((tool) => tool.name === 'get_capabilities'));
    assert.ok(tools.tools.some((tool) => tool.name === 'search_workspace'));
    for (const path of ['nested', 'nested/', ...(process.platform === 'win32' ? ['nested\\'] : [])]) {
      const listing = await client.callTool({ name: 'list_workspace_entries', arguments: { path } });
      assert.equal(listing.isError, undefined);
      assert.ok(JSON.stringify(listing.structuredContent).includes('sample.txt'));
    }
    const missing = await client.callTool({ name: 'inspect_file', arguments: { path: 'missing.txt' } });
    assert.equal(missing.isError, true);
    assert.equal((missing.structuredContent as { data: { error_code: string } }).data.error_code, 'FILE_NOT_FOUND');
    assert.equal((missing.structuredContent as { error_code: string }).error_code, 'FILE_NOT_FOUND');
    for (let round=0; round<3; round++) {
      const concurrent = await Promise.all(['get_connection_status','inspect_file','list_workspace_entries','read_file_excerpt'].map(name => client.callTool({name,arguments:name==='get_connection_status'?{}:{path:name==='list_workspace_entries'?'nested/':'nested/sample.txt'}})));
      assert.ok(concurrent.every(result=>!result.isError));
    }
    const workflow = await client.callTool({ name: 'suggest_workflow', arguments: { request: 'Diagnose my computer connection' } });
    assert.equal(workflow.isError, undefined);
    const suggestion = (workflow.structuredContent as { data: Record<string, unknown> }).data;
    assert.equal(suggestion.selected_skill, 'connection-diagnostics');
    assert.equal(suggestion.execution_performed, false);
    assert.equal(suggestion.permissions_granted, false);
    const status = await client.callTool({ name: 'get_connection_status', arguments: {} });
    assert.equal(status.isError, undefined);
    assert.equal((status.structuredContent as Record<string, unknown>)?.ok, true);
    const excerpt = await client.callTool({ name: 'read_file_excerpt', arguments: { path: file, start_line: 2, max_lines: 1 } });
    assert.equal(excerpt.isError, undefined);
    assert.equal(((excerpt.structuredContent as Record<string, unknown>)?.data as Record<string, unknown>).content, 'beta');
    const found = await client.callTool({ name: 'search_workspace', arguments: { query: 'beta', mode: 'text' } });
    assert.equal(found.isError, undefined);
    const matches = ((found.structuredContent as Record<string, unknown>).data as { matches: Array<{ path: string; line: number }> }).matches;
    assert.deepEqual(matches.map(({ path, line }) => ({ path, line })), [{ path: file, line: 2 }]);
    const inspected = await client.callTool({ name: 'inspect_file', arguments: { path: file } });
    assert.match(String(((inspected.structuredContent as Record<string, unknown>).data as Record<string, unknown>).sha256), /^[a-f0-9]{64}$/);
    assert.ok(!tools.tools.some((tool) => tool.name === 'create_text_file'));
    const prompts = await client.listPrompts();
    assert.ok(prompts.prompts.length >= 6);
    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === 'app://pcrc/device/selected'));
    assert.ok((await client.listResourceTemplates()).resourceTemplates.some((template) => template.uriTemplate === 'app://pcrc/files/{fileId}'));
    assert.ok((await client.readResource({ uri: 'app://pcrc/device/selected' })).contents.length);
    assert.ok((await client.getPrompt({ name: 'troubleshoot_connection', arguments: { goal: 'Check connection' } })).messages.length);
  } finally {
    await client.close().catch(() => undefined);
    await rm(workspace, { recursive: true, force: true });
  }
});

test('file-control tools preview and apply a synthetic edit through the existing service', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pcrc-task-control-'));
  await writeFile(join(workspace, 'edit.txt'), 'before\n');
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(import.meta.dirname, 'main.js')],
    env: { ...process.env, JAN_MCP_WORKSPACE: workspace, JAN_MCP_PYTHON: python, JAN_MCP_CONTROL: '1', JAN_MCP_CAPABILITIES: 'files' } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'control-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.some((tool) => tool.name === 'apply_file_edit'));
    assert.ok(!tools.some((tool) => tool.name === 'run_command'));
    const directory = await client.callTool({ name: 'create_directory', arguments: { path: 'new-folder', confirmed: true } });
    assert.equal(directory.isError, undefined, JSON.stringify(directory));
    const details = await client.callTool({ name: 'inspect_file', arguments: { path: 'edit.txt' } });
    const sha = String(((details.structuredContent as Record<string, unknown>).data as Record<string, unknown>).sha256);
    const args = { path: 'edit.txt', old_text: 'before', new_text: 'after', expected_sha256: sha };
    const preview = await client.callTool({ name: 'preview_file_edit', arguments: args });
    assert.equal(preview.isError, undefined);
    const applied = await client.callTool({ name: 'apply_file_edit', arguments: { ...args, confirmed: true } });
    assert.equal(applied.isError, undefined);
    const read = await client.callTool({ name: 'read_file_excerpt', arguments: { path: 'edit.txt' } });
    assert.equal(((read.structuredContent as Record<string, unknown>).data as Record<string, unknown>).content, 'after\n');
    const stale = await client.callTool({ name: 'apply_file_edit', arguments: { ...args, confirmed: true } });
    assert.equal(stale.isError, true);
    assert.equal((stale.structuredContent as { data: { error_code: string } }).data.error_code, 'HASH_MISMATCH');
  } finally { await client.close().catch(() => undefined); await rm(workspace, { recursive: true, force: true }); }
});

test('approved command tool runs a bounded synthetic command through the Python control service', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'pcrc-task-command-'));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(import.meta.dirname, 'main.js')],
    env: { ...process.env, JAN_MCP_WORKSPACE: workspace, JAN_MCP_PYTHON: python, JAN_MCP_CONTROL: '1', JAN_MCP_CAPABILITIES: 'commands' } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'command-test', version: '0.1.0' });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('run_command'));
    assert.ok(!names.includes('apply_file_edit'));
    const command = process.platform === 'win32' ? 'Write-Output PCRC_SYNTHETIC_TEST' : 'printf PCRC_SYNTHETIC_TEST';
    const result = await client.callTool({ name: 'run_command', arguments: { command, timeout_seconds: 10, confirmed: true } });
    assert.equal(result.isError, undefined);
    const data = (result.structuredContent as { data: Record<string, unknown> }).data;
    assert.ok(JSON.stringify(data).includes('PCRC_SYNTHETIC_TEST'));
    const call = async (name: string, arguments_: Record<string, unknown> = {}) => {
      const response = await client.callTool({ name, arguments: arguments_ });
      assert.equal(response.isError, undefined, JSON.stringify(response));
      return (response.structuredContent as { data: Record<string, unknown> }).data;
    };
    const sleeper = process.platform === 'win32' ? 'Start-Sleep -Seconds 30' : 'sleep 30';
    const processInfo = await call('start_process', { command: sleeper, confirmed: true });
    const processes = await call('list_processes');
    assert.ok((processes.sessions as Array<{ session_id: string }>).some(s => s.session_id === processInfo.session_id));
    assert.equal((await call('force_terminate', { session_id: processInfo.session_id, confirmed: true })).running, false);
    assert.equal((await call('shutdown', { confirmed: true })).control_enabled, false);
    const denied = await client.callTool({ name: 'run_command', arguments: { command, confirmed: true } });
    assert.equal(denied.isError, true);
  } finally { await client.close().catch(() => undefined); await rm(workspace, { recursive: true, force: true }); }
});
