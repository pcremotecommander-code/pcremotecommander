import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import type { Service } from './bridge.js';
import { serveLocalHttp } from './http.js';

async function rpc(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const line = body.split(/\r?\n/).find((part) => part.startsWith('data: '));
    assert.ok(line);
    return JSON.parse(line.slice(6)) as Record<string, unknown>;
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function freePort(): Promise<number> {
  const socket = createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  return address.port;
}

test('loopback HTTP requires the bearer token and does not expose control tools to read-only requests', async () => {
  const key = randomBytes(32).toString('base64url');
  const port = await freePort();
  const service: Service = { call: async () => ({ connected: true }) };
  const local = serveLocalHttp(service, { key, port, capabilities: new Set(['files']) });
  await once(local.server, 'listening');
  try {
    const url = `http://127.0.0.1:${port}/mcp`;
    const message = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'http-test', version: '1' } } });
    const unauthorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: message });
    assert.equal(unauthorized.status, 401);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', remote_connected: false });
    const authorized = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: message });
    assert.equal(authorized.status, 200);
    const data = await rpc(authorized);
    assert.equal(data.jsonrpc, '2.0');
    const list = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    assert.equal(list.status, 200);
    const listed = await rpc(list) as { result?: { tools?: Array<{ name: string }> } };
    assert.ok(listed.result?.tools?.some((tool) => tool.name === 'get_connection_status'));
    assert.ok(!listed.result?.tools?.some((tool) => tool.name === 'create_text_file'));
    const controlList = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`, 'X-JAN-Control': '1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }) });
    assert.equal(controlList.status, 200);
    const controlCatalog = await rpc(controlList) as { result?: { tools?: Array<{ name: string }> } };
    assert.ok(controlCatalog.result?.tools?.some((tool) => tool.name === 'apply_file_edit'));
    assert.ok(!controlCatalog.result?.tools?.some((tool) => tool.name === 'run_command'));
    const modern = await fetch(url, { method: 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}`,
      'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'resources/list',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'http-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } }) });
    assert.equal(modern.status, 200);
    const resources = await rpc(modern) as { result?: { resources?: Array<{ uri: string }> } };
    assert.ok(resources.result?.resources?.some((resource) => resource.uri === 'app://pcrc/device/selected'));
  } finally { await local.close(); }
});
