import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { Service } from './bridge.js';
import { createTaskServer } from './server.js';
import type { Capability } from './tasks.js';

function equalToken(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function serveLocalHttp(service: Service, options: { key: string; port: number; capabilities: ReadonlySet<Capability> }) {
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(options.key)) throw new Error('JAN_MCP_LOCAL_KEY must be a strong URL-safe bearer token');
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('Invalid loopback port');
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const mcp = createMcpHandler(({ requestInfo }) => {
    const control = requestInfo?.headers.get('x-jan-control') === '1';
    return createTaskServer(service, { control, capabilities: options.capabilities, transport: 'authenticated-loopback-http' });
  }, { responseMode: 'auto', maxRequestBodySize: 262144, onerror: (error) => process.stderr.write(`MCP handler: ${error.message}\n`) });
  const nodeHandler = toNodeHandler(mcp, { maxRequestBodySize: 262144 });
  const server = createServer(async (request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    const authorization = request.headers.authorization || '';
    if (!authorization.startsWith('Bearer ') || !equalToken(authorization.slice(7), options.key)) {
      response.writeHead(401, { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' }).end(); return;
    }
    if (request.url === '/healthz' && request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ status: 'ok', remote_connected: false })); return;
    }
    if (request.url !== '/mcp' || request.method !== 'POST') {
      response.writeHead(405, { 'Cache-Control': 'no-store' }).end(); return;
    }
    await nodeHandler(request, response);
  });
  server.listen(options.port, '127.0.0.1');
  return { server, close: async () => { await mcp.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); } };
}
