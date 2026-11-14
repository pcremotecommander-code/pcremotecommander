#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const args = process.argv.slice(2);
const gateway = 'https://pc-remote-commander.pcremotecommander.workers.dev';
const windows = process.platform === 'win32';
const first = args[0] || 'remote';
const cliName = windows ? 'npx.cmd' : 'npx';

if (['help', '--help', '-h'].includes(first)) {
  console.log([
    '',
    'PC REMOTE COMMANDER  |  Remote device agent',
    '------------------------------------',
    'Connect your computer to PC Remote Commander on Cloudflare.',
    '',
    'Commands:',
    '  connect          Staging: matching-code pairing, then secure relay (read-only default)',
    '  connect --enroll --capabilities files,commands,browser,desktop',
    '                   Request and approve explicit computer control',
    '  connect --pair-only  Pair and save credentials without starting the relay',
    '  remote           Connect this installed computer (existing transport)',
    '  remote --enroll  Pair this computer using the PC Remote Commander device website',
    '  relay            Start experimental outbound Cloudflare agent (explicit key paths required)',
    '  doctor           Check Node, PCRC installation, and next steps',
    '  help             Show this guide',
    '',
    'Manage devices: ' + gateway + '/devices',
    'ChatGPT / remote MCP: ' + gateway + '/mcp',
    '',
    'Local test package: ' + cliName + ' --offline --yes ./deploy/npm/jan-commander remote',
    '',
    'This launcher requires the full PCRC project already installed.',
    'Computer control requires matching browser approval, jan:control OAuth consent,',
    'and the same --capabilities choice on every local connection.',
    'The public npm installer is not released.',
    'The remote command retains its existing temporary-tunnel transport.',
    ''
  ].join('\n'));
  process.exit(0);
}

const projectAt = args.indexOf('--project');
let project = process.env.JAN_COMMANDER_HOME || process.cwd();
if (projectAt !== -1) {
  if (projectAt + 1 >= args.length || !path.isAbsolute(args[projectAt + 1])) {
    console.error('PCRC: --project requires the absolute path of your installed PCRC project.');
    process.exit(1);
  }
  project = args[projectAt + 1];
  args.splice(projectAt, 2);
}
const root = path.resolve(project);
const marker = path.join(root, 'pyproject.toml');
const present = fs.existsSync(marker) && /name\s*=\s*["']jan-mcp-commander["']/.test(fs.readFileSync(marker, 'utf8').slice(0, 4096));
const executable = path.join(root, '.venv', windows ? 'Scripts' : 'bin', windows ? 'jan-mcp.exe' : 'jan-mcp');
if (first === 'connect') {
  if(!present||!fs.existsSync(executable)) {console.error('PC Remote Commander requires the installed project. Run Setup-Windows.cmd first.');process.exitCode=1;}
  else {
    try {const pairing=require('./pair-device.cjs');pairing.run(root,pairing.parseArgs(args.slice(1))).catch(error=>{console.error('PC Remote Commander: '+error.message);process.exitCode=1;});}
    catch(error) {console.error(error.message);process.exitCode=1;}
  }
} else if (first === 'doctor') {
  require('./doctor.cjs').doctor(root, 'https://pc-remote-commander.pcremotecommander.workers.dev').then(checks=>{
    for(const [label,ok,help] of checks)console.log((ok===null?'NOT VERIFIED ':ok?'PASS ':'FAIL ')+label+(ok?'':' — '+help));
    if(checks.some(([,ok])=>ok===false))process.exitCode=1;
  }).catch(()=>{console.error('PCRC diagnostics unavailable. Check setup and retry.');process.exitCode=1;});
} else if (first === 'relay') {
  const agent = path.join(__dirname, 'relay-agent.cjs');
  console.log('PC Remote Commander | Experimental outbound relay');
  console.log('Requires a running local PC Remote Commander MCP server and saved, private device credentials.');
  console.log('Press Ctrl+C to disconnect. Existing remote tunnel remains available.');
  let relayArgs = args.slice(1);
  if(relayArgs.length===0) {
    try {
      const {resolveJanSession}=require('./resolve-session.cjs');
      const saved=resolveJanSession(root);
      relayArgs=['--session',saved.session,'--device-key',saved.deviceKey,'--local-key',saved.localKey];
    } catch {
      console.error('PCRC relay setup incomplete. Check your configured workspace and device enrollment.');
      process.exit(1);
    }
  }
  const child = spawn(process.execPath, [agent, ...relayArgs], {cwd: root, stdio: 'inherit', shell: false});
  child.on('error', () => {console.error('PCRC relay agent could not start.');process.exitCode=1;});
  child.on('exit', (code,signal) => {process.exitCode=signal?130:(code??1);});
} else if (!present) {
  console.error('PCRC project not found. Open your installed PCRC folder or pass --project with its absolute path.');
  process.exitCode = 1;
} else if (!fs.existsSync(executable)) {
  console.error('PCRC is not installed in this folder. Run Setup-Windows.cmd or bash setup-linux.sh.');
  process.exitCode = 1;
} else {
  console.log('PC Remote Commander | Starting local device agent');
  console.log('Project: ' + root);
  console.log('Press Ctrl+C to disconnect. Do not close this terminal while controlling your computer.');
  const child = spawn(executable, args.length ? args : ['remote'], {cwd: root, stdio: 'inherit', shell: false});
  child.on('error', () => {console.error('PCRC failed to start. Run doctor for installation help.'); process.exitCode = 1;});
  child.on('exit', (code, signal) => {process.exitCode = signal ? 130 : (code ?? 1);});
}
