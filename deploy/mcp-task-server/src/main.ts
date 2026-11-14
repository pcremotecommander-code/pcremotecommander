import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { PythonService } from './bridge.js';
import { createTaskServer } from './server.js';
import type { Capability } from './tasks.js';
import { serveLocalHttp } from './http.js';

const workspace = process.env.JAN_MCP_WORKSPACE;
if (!workspace) throw new Error('Set JAN_MCP_WORKSPACE to an approved folder');
const service = new PythonService({
  python: process.env.JAN_MCP_PYTHON || 'python',
  workspace,
  control: process.env.JAN_MCP_CONTROL === '1',
  capabilities: process.env.JAN_MCP_CAPABILITIES,
  durationMinutes: Number(process.env.JAN_MCP_DURATION_MINUTES || '60'),
  browserChannel: process.env.JAN_MCP_BROWSER_CHANNEL || 'chromium',
  foreground:process.argv.includes('--foreground'),
});
const capabilities = new Set((process.env.JAN_MCP_CAPABILITIES || (process.env.JAN_MCP_CONTROL === '1' ? 'files' : '')).split(',').filter((value): value is Capability => ['files', 'commands', 'browser', 'desktop'].includes(value)));
if (process.env.JAN_MCP_TRANSPORT === 'http') {
  const local = serveLocalHttp(service, { key: process.env.JAN_MCP_LOCAL_KEY || '', port: Number(process.env.JAN_MCP_PORT || '8866'), capabilities });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void local.close().finally(() => service.close()); });
  if(process.argv.includes('--foreground')){
    // The launcher owns this anonymous pipe; its death closes it even after an ungraceful exit.
    process.stdin.once('end',()=>{void Promise.allSettled([service.close(),local.close()]).finally(()=>process.exit(0));});
    process.stdin.resume();
  }
} else {
  const handle = serveStdio(() => createTaskServer(service, { control: process.env.JAN_MCP_CONTROL === '1', capabilities }), { onerror: (error) => process.stderr.write(`MCP transport: ${error.message}\n`) });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void handle.close().finally(() => service.close()); });
}
