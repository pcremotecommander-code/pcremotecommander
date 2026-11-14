import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PythonService, pythonServiceArgs, serviceImages, serviceResult } from './bridge.js';

test('control bridge preserves the locally approved lease and browser choice', () => {
  assert.deepEqual(pythonServiceArgs({ workspace: 'C:/safe', control: true, capabilities: 'files,commands,browser,desktop', durationMinutes: 12, browserChannel: 'msedge' }), [
    '-m', 'jan_mcp_commander.control', '--workspace', 'C:/safe', '--capabilities', 'files,commands,browser,desktop', '--duration-minutes', '12', '--browser-channel', 'msedge', '--transport', 'stdio',
  ]);
});

test('foreground is an explicit local bridge option and not a remotely callable renewal',()=>{
  const args=pythonServiceArgs({workspace:'C:/safe',control:true,foreground:true});
  assert.ok(args.includes('--foreground'));assert.equal(args[args.indexOf('--foreground-parent-pid')+1],String(process.pid));
  assert.ok(!pythonServiceArgs({workspace:'C:/safe',control:true}).includes('--foreground'));
  assert.ok(!pythonServiceArgs({workspace:'C:/safe',control:false,foreground:true}).includes('--foreground'));
});

test('closing during backend initialization rejects queued work without executing it',async()=>{
  let initialized!:()=>void;let calls=0;
  const service=Object.create(PythonService.prototype) as PythonService;
  Object.assign(service,{ready:new Promise<void>(resolve=>{initialized=resolve;}),closing:false,
    client:{close:async()=>undefined,callTool:async()=>{calls++;return {structuredContent:{executed:true}};}}});
  const pending=service.call('jan_write_text',{path:'synthetic.txt',content:'never execute'});
  const closed=service.close();initialized();await closed;
  await assert.rejects(pending,error=>(error as {code:string}).code==='CONNECTION_CLOSED');
  assert.equal(calls,0);
  await assert.rejects(service.call('jan_status'),error=>(error as {code:string}).code==='CONNECTION_CLOSED');
});

test('Python image results keep frames for MCP content without mixing them into metadata', () => {
  const result = serviceResult({ content: [{ type: 'text', text: '{"frame_id":"abc"}' }, { type: 'image', mimeType: 'image/jpeg', data: 'aGVsbG8=' }] });
  assert.equal(result.frame_id, 'abc');
  assert.deepEqual(result[serviceImages], [{ mimeType: 'image/jpeg', data: 'aGVsbG8=' }]);
  assert.ok(!JSON.stringify(result).includes('aGVsbG8='));
});

test('backend output privacy denies high-confidence secrets without echoing their values', () => {
  const samples = [
    'password = "C0mpl3x!SyntheticOnly"',
    'sk-proj-' + 'A'.repeat(40),
    'ghp_' + 'B'.repeat(36),
    '-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----',
    'Card number: 4111 1111 1111 1111',
    'Aadhaar: 2345 6789 0123',
  ];
  for (const value of samples) {
    for (const response of [{ structuredContent: { output: value } }, { content: [{ type: 'text', text: value }] }, { structuredContent: { ok: false }, content: [{ type: 'text', text: value }] }]) {
      assert.throws(() => serviceResult(response), error => {
        assert.equal((error as { code: string }).code, 'SENSITIVE_CONTENT_BLOCKED');
        assert.ok(!String(error).includes(value));
        return true;
      });
    }
  }
});

test('backend output privacy preserves required task routing and ordinary identity/status metadata', () => {
  const value = { id: 'a'.repeat(32), task_id: 'b'.repeat(32), lease_token: 'c'.repeat(43), session_id: 'd'.repeat(32), account_id: '123456789', username: 'PCRC user', stdout: 'Python 3.14.8\nBuild passed', nested: [{ cell: 'A1', value: 123.4 }] };
  assert.deepEqual(serviceResult({ structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] }), value);
  assert.deepEqual(serviceResult({ structuredContent: { output: 'Card estimate 1234 5678 9012 3456 is not a valid card' } }), { output: 'Card estimate 1234 5678 9012 3456 is not a valid card' });
});

test('credential-like values cannot bypass privacy by borrowing routing field names', () => {
  for (const key of ['session_id', 'backup_id', 'lease_token', 'expected_sha256']) {
    assert.throws(() => serviceResult({ structuredContent: { [key]: 'ghp_' + 'B'.repeat(36) } }), /Sensitive personal or authentication data is blocked/);
  }
  assert.throws(() => serviceResult({ structuredContent: { output: { password: 'SyntheticPassword123!' } } }), /Sensitive personal or authentication data is blocked/);
});

test('backend output privacy rejects oversized or deeply nested records with a non-echoing error', () => {
  let nested: unknown = 'ordinary';
  for (let i = 0; i < 20; i++) nested = { nested };
  assert.throws(() => serviceResult({ structuredContent: { nested } }), /Output exceeded privacy inspection limits/);
});

test('quoted credential values never use the unquoted type or function-call exception', () => {
  for (const text of ['password="false"', "password='None'", 'password="null"', 'password="function()"']) {
    assert.throws(() => serviceResult({ structuredContent: { output: text } }), /Sensitive personal or authentication data is blocked/);
  }
  for (const value of ['false', 'null', 'None', 'function()']) {
    assert.throws(() => serviceResult({ structuredContent: { password: value } }), /Sensitive personal or authentication data is blocked/);
  }
  assert.deepEqual(serviceResult({ structuredContent: { output: 'password=None\ntoken=str\npassword=function()' } }), { output: 'password=None\ntoken=str\npassword=function()' });
});

test('numeric credentials in structured and rendered JSON cannot bypass the shared guard', () => {
  for (const value of [{ pin: 1234 }, { otp: 123456 }, { nested: { cvv: 123 } }]) {
    for (const response of [{ structuredContent: value }, { content: [{ type: 'text', text: JSON.stringify(value) }] }]) {
      assert.throws(() => serviceResult(response), error => {
        assert.equal((error as { code: string }).code, 'SENSITIVE_CONTENT_BLOCKED');
        assert.ok(!String(error).includes(JSON.stringify(value)));
        return true;
      });
    }
  }
  const ordinary = { count: 1234, account_id: 123456789, duration_ms: 123456, nested: { attempts: 3 } };
  assert.deepEqual(serviceResult({ structuredContent: ordinary }), ordinary);
});

test('sensitive ancestor labels survive nested arrays, objects and serialized JSON', () => {
  const samples = [{ password: ['synthetic-secret'] }, { password: { value: 'synthetic-secret' } }, { otp: [123456] }, { aadhaar: { number: '234567891234' } }, { password: { lease_token: 'a'.repeat(43) } }];
  for (const sample of samples) {
    for (const response of [{ structuredContent: sample }, { structuredContent: { output: JSON.stringify(sample) } }, { content: [{ type: 'text', text: JSON.stringify(sample) }] }]) {
      assert.throws(() => serviceResult(response), /Sensitive personal or authentication data is blocked/);
    }
  }
  assert.throws(() => serviceResult({ content: [{ type: 'text', text: '{"outer":{"password":{"value":"synthetic-secret"}},"outer":null}' }] }), /Output contains duplicate JSON fields/);
  assert.deepEqual(serviceResult({ structuredContent: { schema: { password: { type: 'string' } }, task: { lease_token: 'a'.repeat(43) } } }), { schema: { password: { type: 'string' } }, task: { lease_token: 'a'.repeat(43) } });
});

test('Python-style nested literal credentials are blocked without evaluating symbols or code', () => {
  const samples = ["{'password': {'value': 'synthetic-private-fixture'}}", "{'password': ['synthetic-private-fixture']}", "{'aadhaar': {'number': '234567891234'}}"];
  for (const text of samples) assert.throws(() => serviceResult({ structuredContent: { output: text } }), /Sensitive personal or authentication data is blocked/);
  const benign = ["{'password': {'type': 'string'}}", "{'password': {'type': str}}", "{'password': {'value': some_symbol}}", "{'ordinary': {'value': 'hello'}, 'enabled': True, 'optional': None}", "{'task': {'lease_token': '" + 'a'.repeat(43) + "'}}"];
  for (const text of benign) assert.deepEqual(serviceResult({ structuredContent: { output: text } }), { output: text });
});
