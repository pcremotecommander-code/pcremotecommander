'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');

async function doctor(root, gateway, fetcher = fetch, run = spawnSync) {
  const origin = new URL(gateway);
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.origin!==gateway)throw Error('Use an exact HTTPS gateway origin');
  const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const checks = [
    ['Node.js 20+', Number(process.versions.node.split('.')[0]) >= 20, 'Install Node.js 20 or newer.'],
    ['Python environment', fs.existsSync(python), 'Run the PCRC setup script for this OS.'],
    ['MCP runtime', fs.existsSync(path.join(root, 'deploy/mcp-task-server/dist/main.js')), 'Run setup again to build the runtime.'],
  ];
  async function probe(route, accept) {
    try {
      return accept(await fetcher(gateway + route, { redirect: 'error', signal: AbortSignal.timeout(5000) }));
    } catch {
      return false;
    }
  }
  const [healthy, oauth] = await Promise.all([
    probe('/healthz', response => response.status === 200),
    probe('/mcp', response => response.status === 401 && /^Bearer\b/i.test(response.headers.get('WWW-Authenticate') ?? '')),
  ]);
  checks.push(['Public gateway', healthy, 'Check internet access and retry.'],
    ['MCP OAuth challenge', oauth, 'Check whether the public MCP endpoint is reachable.']);
  let state;
  if(fs.existsSync(python))try {
    const port = require('./pair-device.cjs').parseArgs([]).port;
    const result = run(python,['-m','jan_mcp_commander.pairing_state','inspect','--port',String(port)],{cwd:root,encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:4096});
    if(!result.error&&result.status===0)state=JSON.parse(result.stdout);
  }catch{}
  checks.push(['Saved pairing', state?.paired===true, 'Run setup, sign in and approve the matching computer code.'],
    ['Pairing gateway', state?.paired===true&&state.gateway===gateway, 'Reconnect using the gateway that owns this saved pairing, or enroll on this gateway.'],
    ['Local agent', state?.local_agent===true, 'Run setup and keep its terminal open. A custom local port needs a matching inspection.'],
    ['Selected device and authenticated tool discovery', null, 'Open dashboard → Connection check. Public health and OAuth discovery alone do not verify your account or selected computer.']);
  return checks;
}

if (require.main === module) {
  doctor(process.cwd(), 'https://pc-remote-commander.pcremotecommander.workers.dev').then(checks => {
    for (const [label, ok, help] of checks) console.log((ok===null?'NOT VERIFIED ':ok?'PASS ':'FAIL ') + label + (ok?'':' — '+help));
    if (checks.some(([, ok]) => ok===false)) process.exitCode = 1;
  });
}
module.exports = { doctor };
