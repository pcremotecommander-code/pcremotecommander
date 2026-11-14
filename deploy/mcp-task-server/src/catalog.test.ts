import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ServiceError, serviceImages, type Service } from './bridge.js';
import { createTaskServer } from './server.js';
import type { Capability } from './tasks.js';
import { includeTextResult } from './text-result.js';

test('Windows accessibility tools retain desktop scope, approval, exact IDs and screenshot image fallback',async()=>{
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const {server,client}=await connected({control:true,capabilities:new Set(['desktop'])},{call:async(name,args={})=>{
    calls.push({name,args});return {method:'windows_uia',controls:[],[serviceImages]:[{data:'c3ludGhldGlj',mimeType:'image/jpeg'}]};
  }});
  try {
    const tools=(await client.listTools()).tools;
    assert.equal(tools.find(t=>t.name==='inspect_desktop_controls')?.annotations?.readOnlyHint,true);
    assert.equal(tools.find(t=>t.name==='interact_desktop_control')?.annotations?.destructiveHint,true);
    const result=await client.callTool({name:'inspect_desktop_controls',arguments:{fallback_to_screenshot:true}});
    assert.ok(result.content.some(c=>c.type==='image'));
    const args={inspection_id:'a'.repeat(32),control_id:'b'.repeat(32),action:'invoke'};
    assert.equal((await client.callTool({name:'interact_desktop_control',arguments:args})).isError,true);
    assert.equal(calls.length,1);
    assert.equal((await client.callTool({name:'interact_desktop_control',arguments:{...args,confirmed:true}})).isError,undefined);
    assert.deepEqual(calls[1],{name:'jan_interact_desktop_control',args:{...args,text:''}});
    assert.equal((await client.callTool({name:'interact_desktop_control',arguments:{...args,control_id:'Save',confirmed:true}})).isError,true);
    assert.equal(calls.length,2);
  } finally {await client.close();await server.close();}
  const denied=await connected({control:true,capabilities:new Set(['files'])},{call:async()=>{throw Error('Must not dispatch');}});
  try {assert.ok(!(await denied.client.listTools()).tools.some(t=>['inspect_desktop_controls','interact_desktop_control'].includes(t.name)));}
  finally {await denied.client.close();await denied.server.close();}
});

test('text-only clients receive structured details once without losing images or errors',()=>{
  const data={ok:true,summary:'Diagnostic uname',data:{stdout:'Synthetic Windows',version:'test'}};
  const image={type:'image',mimeType:'image/jpeg',data:'c3ludGhldGlj'};
  const result={content:[{type:'text',text:data.summary},image],structuredContent:data,isError:false};
  includeTextResult(result);includeTextResult(result);
  assert.deepEqual(JSON.parse((result.content.at(-1) as {text:string}).text),data);
  assert.equal(result.content.length,3);assert.equal(result.content[1],image);assert.equal(result.isError,false);
  const large={content:[] as Array<{type:string;text:string}>,structuredContent:{ok:true,summary:'Large result',data:{text:'x'.repeat(70000)}}};
  includeTextResult(large);
  const fallback=JSON.parse((large.content[0] as {text:string}).text);
  assert.equal(fallback.text_result_truncated,true);assert.match(fallback.detail,/smaller/);
  assert.equal(large.structuredContent.data.text.length,70000);
});

async function connected(access: { control: boolean; capabilities: ReadonlySet<Capability> }, service: Service) {
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const server = createTaskServer(service, access);
  const client = new Client({ name: 'catalog-test', version: '0.1.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { server, client };
}

test('routine tools have no result panels or result UI resources',async()=>{
  const {server,client}=await connected({control:true,capabilities:new Set(['files'])},{call:async()=>({})});
  try {
    for(const tool of (await client.listTools()).tools){assert.equal(tool._meta?.['openai/outputTemplate'],undefined);assert.equal((tool._meta?.ui as {resourceUri?:string}|undefined)?.resourceUri,undefined);}
    assert.ok(!(await client.listResources()).resources.some(r=>r.uri==='ui://pcrc/result-preview-v1.html'));
  } finally {await client.close();await server.close();}
});

test('desktop typing catalog enforces the device keyboard budget before dispatch',async()=>{
  let calls=0;
  const {server,client}=await connected({control:true,capabilities:new Set(['desktop'])},{call:async()=>{calls++;return {};}});
  try {
    const tool=(await client.listTools()).tools.find(t=>t.name==='interact_desktop')!;
    const limit=process.platform==='win32'?1024:4096;
    assert.equal((tool.inputSchema.properties?.text as {maxLength:number}).maxLength,limit);
    const reply=await client.callTool({name:'interact_desktop',arguments:{action:'type',text:'A'.repeat(limit+1),confirmed:true}});
    assert.equal(reply.isError,true);assert.equal(calls,0);
  } finally {await client.close();await server.close();}
});

test('document workflow catalog binds exact review, capability, confirmation and rendered images',async()=>{
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const {server,client}=await connected({control:true,capabilities:new Set(['files'])},{call:async(name,args={})=>{
    calls.push({name,args});return {status:'synthetic',[serviceImages]:[{data:'c3ludGhldGlj',mimeType:'image/jpeg'}]};
  }});
  try{
    const tools=(await client.listTools()).tools;
    for(const name of ['inspect_document_pdf','preview_document_workflow','get_document_workflow'])assert.equal(tools.find(t=>t.name===name)?.annotations?.readOnlyHint,true);
    assert.equal(tools.find(t=>t.name==='apply_document_workflow')?.annotations?.destructiveHint,true);
    const jobs=[{kind:'create_markdown_pdf',markdown:'# Synthetic',destination:'sample.pdf'}];
    assert.equal((await client.callTool({name:'preview_document_workflow',arguments:{jobs}})).isError,undefined);
    assert.equal(calls[0]?.name,'jan_preview_document_workflow');
    const args={plan_id:'a'.repeat(32),review_sha256:'b'.repeat(64),review:[{kind:'create_markdown_pdf',status:'ready',outputs:[{path:'sample.pdf'}]}]};
    assert.equal((await client.callTool({name:'apply_document_workflow',arguments:args})).isError,true);
    assert.equal(calls.length,1);
    assert.equal((await client.callTool({name:'apply_document_workflow',arguments:{...args,confirmed:true}})).isError,undefined);
    assert.deepEqual(calls[1],{name:'jan_apply_document_workflow',args});
    const pdf=await client.callTool({name:'inspect_document_pdf',arguments:{path:'sample.pdf'}});
    assert.ok(pdf.content.some(c=>c.type==='image'));
    assert.deepEqual(calls[2],{name:'jan_inspect_document_pdf',args:{path:'sample.pdf',pages:[1]}});
  }finally{await client.close();await server.close();}
  const restricted=await connected({control:true,capabilities:new Set(['commands'])},{call:async()=>({})});
  try{assert.ok(!(await restricted.client.listTools()).tools.some(t=>/document_(pdf|workflow)$/.test(t.name)));}
  finally{await restricted.client.close();await restricted.server.close();}
});

test('public command descriptions and schemas expose the bounded script alternative',async()=>{
  let calls=0;const {server,client}=await connected({control:true,capabilities:new Set(['commands'])},{call:async()=>{calls++;return {};}});
  try{
    const tools=(await client.listTools()).tools;
    for(const name of ['run_command','start_process']){
      const tool=tools.find(t=>t.name===name)!;assert.match(tool.description!,/4096 characters/);assert.match(tool.description!,/start_program/);
      assert.equal((await client.callTool({name,arguments:{command:'x'.repeat(4097),confirmed:true}})).isError,true);
    }
    assert.equal(calls,0);
  }finally{await client.close();await server.close();}
});

test('shared assignments reach guarded backend calls without changing old handler arguments', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { server, client } = await connected({ control: true, capabilities: new Set(['files', 'browser']) }, {
    call: async (name, args = {}) => { calls.push({ name, args }); return { performed: true }; },
  });
  try {
    const tools = (await client.listTools()).tools;
    for (const name of ['list_tasks', 'claim_task', 'teach_browser_workflow', 'run_workflow_step']) assert.ok(tools.some(t => t.name === name));
    const lease = { task_id: 'a'.repeat(32), lease_token: 'b'.repeat(43) };
    await client.callTool({ name: 'create_text_file', arguments: { path: 'new.txt', content: 'synthetic', confirmed: true, ...lease } });
    assert.equal(calls[0]?.name, 'jan_coordinated_call');
    assert.deepEqual(calls[0]?.args, { name: 'jan_write_text', arguments: { path: 'new.txt', content: 'synthetic', overwrite: false }, ...lease });
    await client.callTool({ name: 'claim_task', arguments: { task_id: lease.task_id, agent: 'reviewer', resources: ['ui'], confirmed: true } });
    assert.equal(calls[1]?.name, 'jan_team');
    await client.callTool({ name: 'teach_browser_workflow', arguments: { action: 'start', title: 'Demo', confirmed: true, ...lease } });
    assert.equal(calls[2]?.args.name, 'jan_browser_workflow');
    const incomplete = await client.callTool({ name: 'create_text_file', arguments: { path: 'new.txt', content: 'synthetic', confirmed: true, task_id: lease.task_id } });
    assert.equal(incomplete.isError, true);
    assert.equal(calls.length, 3);
  } finally { await client.close(); await server.close(); }
});

test('safe backend errors remain structured and do not expose internal service tool names', async () => {
  const { server, client } = await connected({ control: true, capabilities: new Set(['files']) }, { call: async () => { throw new ServiceError('HASH_MISMATCH', 'Read and inspect the file again.'); } });
  try {
    const result = await client.callTool({ name: 'inspect_file', arguments: { path: 'synthetic.txt' } });
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { data: { error_code: string } }).data.error_code, 'HASH_MISMATCH');
    assert.equal((result.structuredContent as { error_code: string }).error_code, 'HASH_MISMATCH');
    assert.ok(!JSON.stringify(result).includes('jan_'));
  } finally { await client.close(); await server.close(); }
});

test('read-only catalog excludes every control tool', async () => {
  const { server, client } = await connected({ control: false, capabilities: new Set() }, { call: async () => ({}) });
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 7);
    assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
    assert.ok(!tools.some((tool) => tool.name === 'run_command' || tool.name === 'interact_desktop'));
  } finally { await client.close(); await server.close(); }
});

test('media/PDF tools preserve capability, confirmation and image boundaries',async()=>{
  const calls:Array<{name:string;args:Record<string,unknown>}>=[];
  const image={data:'c3ludGhldGlj',mimeType:'image/jpeg' as const};
  const {server,client}=await connected({control:true,capabilities:new Set(['files'])},{call:async(name,args={})=>{
    calls.push({name,args});return {sha256:'a'.repeat(64),[serviceImages]:[image]};
  }});
  try{
    const tools=(await client.listTools()).tools;
    for(const name of ['read_pdf','rewrite_pdf','inspect_media','transcribe_audio','edit_media'])assert.ok(tools.some(t=>t.name===name));
    assert.ok(!tools.some(t=>t.name==='prepare_media'),'download process requires commands capability');
    const read=await client.callTool({name:'inspect_media',arguments:{path:'synthetic.png',kind:'image'}});
    assert.ok(read.content?.some(part=>part.type==='image'));
    assert.equal(calls[0]?.name,'jan_inspect_media');
    const denied=await client.callTool({name:'edit_media',arguments:{path:'synthetic.png',destination:'copy.jpg',kind:'image',expected_sha256:'a'.repeat(64)}});
    assert.equal(denied.isError,true);assert.equal(calls.length,1);
    await client.callTool({name:'edit_media',arguments:{path:'synthetic.png',destination:'copy.jpg',kind:'image',expected_sha256:'a'.repeat(64),confirmed:true}});
    assert.equal(calls[1]?.name,'jan_edit_media');assert.ok(!Object.hasOwn(calls[1]!.args,'confirmed'));
  }finally{await client.close();await server.close();}
});

test('full catalog is task oriented and file edits use preview then apply', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const service: Service = { call: async (name, args = {}) => { calls.push({ name, args }); return { diff: '+hello', sha256: 'a'.repeat(64) }; } };
  const capabilities = new Set<Capability>(['files', 'commands', 'browser', 'desktop']);
  const { server, client } = await connected({ control: true, capabilities }, service);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 25);
    for (const name of ['search_workspace', 'get_capabilities', 'move_files_bulk', 'delete_files_bulk', 'capture_desktop']) {
      assert.ok(tools.some((tool) => tool.name === name), name);
    }
    assert.equal(tools.find((tool) => tool.name === 'run_command')?.title, 'Run Command');
    const preview = tools.find((tool) => tool.name === 'preview_file_edit');
    const apply = tools.find((tool) => tool.name === 'apply_file_edit');
    assert.equal(preview?.annotations?.readOnlyHint, true);
    assert.equal(apply?.annotations?.destructiveHint, true);
    const args = { path: 'sample.txt', old_text: 'old', new_text: 'new', expected_sha256: 'a'.repeat(64) };
    const planned = await client.callTool({ name: 'preview_file_edit', arguments: args });
    assert.equal(planned.isError, undefined);
    const applied = await client.callTool({ name: 'apply_file_edit', arguments: { ...args, confirmed: true } });
    assert.equal(applied.isError, undefined);
    assert.deepEqual(calls.map((call) => call.name), ['jan_edit_text', 'jan_edit_text']);
    assert.equal(calls[0]?.args.dry_run, true);
    assert.equal(calls[1]?.args.dry_run, false);
  } finally { await client.close(); await server.close(); }
});

test('full-control catalog reaches existing process, browser and desktop actions', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const service: Service = { call: async (name, args = {}) => { calls.push({ name, args }); return { performed: true }; } };
  const { server, client } = await connected({ control: true, capabilities: new Set(['commands', 'browser', 'desktop']) }, service);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('start_program'));
    assert.ok(names.includes('manage_browser_tab'));
    assert.ok(!names.includes('apply_file_edit'));
    assert.equal((await client.callTool({ name: 'start_program', arguments: { executable: 'C:/Tools/tool.exe', arguments: ['--version'], confirmed: true } })).isError, undefined);
    assert.equal((await client.callTool({ name: 'manage_browser_tab', arguments: { action: 'back', confirmed: true } })).isError, undefined);
    assert.equal((await client.callTool({ name: 'interact_browser', arguments: { action: 'press', target: '#search', text: 'Enter', confirmed: true } })).isError, undefined);
    assert.equal((await client.callTool({ name: 'interact_desktop', arguments: { action: 'scroll', x: 20, y: 30, amount: -2, frame_id: 'fresh', confirmed: true } })).isError, undefined);
    assert.deepEqual(calls.map(({ name }) => name), ['jan_start_program', 'jan_browser', 'jan_browser', 'jan_desktop']);
    assert.deepEqual(calls[0]?.args, { executable: 'C:/Tools/tool.exe', arguments: ['--version'], timeout_seconds: 300 });
    assert.deepEqual(calls[1]?.args, { action: 'back', target: '' });
    assert.equal(calls[2]?.args.action, 'press');
    assert.equal(calls[3]?.args.amount, -2);
  } finally { await client.close(); await server.close(); }
});

test('browser and desktop captures return image content without base64 in structured data', async () => {
  const service: Service = { call: async () => ({ frame_id: 'frame-1', [serviceImages]: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }] }) };
  const { server, client } = await connected({ control: true, capabilities: new Set(['browser', 'desktop']) }, service);
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('capture_browser'));
    for (const name of ['capture_browser', 'capture_desktop']) {
      const result = await client.callTool({ name, arguments: {} });
      assert.equal(result.isError, undefined);
      assert.ok(result.content?.some((part) => part.type === 'image' && part.data === 'aGVsbG8='));
      assert.ok(!JSON.stringify(result.structuredContent).includes('aGVsbG8='));
    }
  } finally { await client.close(); await server.close(); }
});

test('visual control loop passes fresh frame IDs to cursor actions and recaptures afterward', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let frame = 0;
  const service: Service = { call: async (name, args = {}) => {
    calls.push({ name, args });
    return args.action === 'screenshot'
      ? { frame_id: `frame-${++frame}`, [serviceImages]: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }] }
      : { performed: true };
  } };
  const { server, client } = await connected({ control: true, capabilities: new Set(['browser', 'desktop']) }, service);
  try {
    for (const action of ['move', 'click', 'drag']) {
      const capture = await client.callTool({ name: 'capture_desktop', arguments: {} });
      const frameId = (capture.structuredContent as { data: { frame_id: string } }).data.frame_id;
      const result = await client.callTool({ name: 'interact_desktop', arguments: { action, x: 20, y: 30, end_x: 40, end_y: 50, frame_id: frameId, confirmed: true } });
      assert.equal(result.isError, undefined);
      assert.equal(calls.at(-1)?.args.frame_id, frameId);
      assert.equal((await client.callTool({ name: 'capture_desktop', arguments: {} })).isError, undefined);
    }
    assert.equal((await client.callTool({ name: 'interact_browser', arguments: { action: 'click', target: '#synthetic-button', confirmed: true } })).isError, undefined);
    const after = await client.callTool({ name: 'capture_browser', arguments: {} });
    assert.ok(after.content?.some((part) => part.type === 'image'));
    assert.equal(calls.at(-2)?.args.target, '#synthetic-button');
  } finally { await client.close(); await server.close(); }
});


test('installed app discovery and launch preserve capability and confirmation boundaries',async()=>{
 const calls:Array<{name:string;args:Record<string,unknown>}>=[];
 const service:Service={call:async(name,args={})=>{calls.push({name,args});return {launch_requested:true,visible_verified:false};}};
 const {server,client}=await connected({control:true,capabilities:new Set<Capability>(['commands'])},service);
 try {
  const tools=(await client.listTools()).tools;
  assert.equal(tools.find(t=>t.name==='list_applications')?.annotations?.readOnlyHint,true);
  assert.equal(tools.find(t=>t.name==='open_application')?.annotations?.destructiveHint,true);
  const denied=await client.callTool({name:'open_application',arguments:{application:'Excel'}});
  assert.equal(denied.isError,true);assert.equal(calls.length,0);
  await client.callTool({name:'list_applications',arguments:{query:'Excel'}});
  await client.callTool({name:'open_application',arguments:{application:'Vendor.Excel!App',confirmed:true}});
  assert.deepEqual(calls.map(c=>c.name),['jan_list_applications','jan_open_application']);
  assert.deepEqual(calls[1]?.args,{application:'Vendor.Excel!App'});
 } finally {await client.close();await server.close();}
 const readonly=await connected({control:false,capabilities:new Set()},service);
 try {assert.ok(!(await readonly.client.listTools()).tools.some(t=>t.name==='open_application'||t.name==='list_applications'));}
 finally {await readonly.client.close();await readonly.server.close();}
});


test('computer use skill is discoverable without granting computer access',async()=>{
 const {server,client}=await connected({control:false,capabilities:new Set()}, {call:async(name)=>{
  assert.equal(name,'jan_skill_guide');return {computer_use:{content:'# Synthetic PCRC Computer Use'}};
 }});
 try {
  assert.ok((await client.listResources()).resources.some(r=>r.uri==='app://pcrc/skills/computer-use'));
  const resource=await client.readResource({uri:'app://pcrc/skills/computer-use'});
  const content=resource.contents[0];
  assert.ok(content && 'text' in content);
  assert.equal(content.text,'# Synthetic PCRC Computer Use');
  assert.ok((await client.listPrompts()).prompts.some(p=>p.name==='monitor_app_task'));
 } finally {await client.close();await server.close();}
});


test('binary file inspection uses bounded backend metadata without decoding media as text',async()=>{
 const calls:string[]=[];
 const {server,client}=await connected({control:false,capabilities:new Set()}, {call:async name=>{
  calls.push(name);assert.equal(name,'jan_file_info');
  return {path:'sample.wav',kind:'file',bytes:8044,sha256:'a'.repeat(64)};
 }});
 try {
  const result=await client.callTool({name:'inspect_file',arguments:{path:'sample.wav'}});
  assert.ok(!result.isError);assert.deepEqual(calls,['jan_file_info']);
  assert.equal((result.structuredContent as {data:{sha256:string}}).data.sha256,'a'.repeat(64));
 }finally{await client.close();await server.close();}
});

test('bounded search snapshots, file batches and reviewed maintenance tools', async () => {
  const calls: string[] = [];
  const service: Service = { call: async (name, args) => {
    calls.push(name);
    if (name === 'jan_find_files') return { matches: ['a.txt', 'b.txt'] };
    if (name === 'jan_read_text' && args?.path === 'missing.txt') throw new ServiceError('FILE_NOT_FOUND', 'Missing file.');
    return { content: 'x'.repeat(9000) };
  } };
  const first = await connected({ control: true, capabilities: new Set(['files', 'commands']) }, service);
  const read = await connected({ control: false, capabilities: new Set() }, service);
  const call = (client: Client, name: string, arguments_: Record<string, unknown> = {}) => client.callTool({ name, arguments: arguments_ });
  const data = (result: Awaited<ReturnType<typeof call>>) => {
    assert.equal(result.isError, undefined);
    return (result.structuredContent as { data: Record<string, unknown> }).data;
  };
  try {
    assert.equal(data(await call(read.client, 'get_config')).search_page_size, 10);
    assert.equal((await call(first.client, 'set_config_value', { key: 'proxy_key', value: 1, confirmed: true })).isError, true);
    data(await call(first.client, 'set_config_value', { key: 'search_page_size', value: 1, confirmed: true }));
    assert.deepEqual(data(await call(read.client, 'search_workspace', { query: 'txt' })).matches, ['a.txt', 'b.txt']);
    const search = data(await call(read.client, 'search_workspace', { query: 'txt', paginate: true }));
    assert.deepEqual(search.matches, ['a.txt']);
    assert.equal(search.next_offset, 1);
    const search_id = search.search_id;
    assert.deepEqual(data(await call(read.client, 'list_searches')).searches, [{ search_id, total: 2 }]);
    assert.deepEqual(data(await call(first.client, 'get_more_search_results', { search_id, offset: 1 })).matches, ['b.txt']);
    assert.equal(data(await call(first.client, 'stop_search', { search_id, confirmed: true })).stopped, true);
    assert.equal((await call(read.client, 'get_more_search_results', { search_id, offset: 1 })).isError, true);
    assert.deepEqual(data(await call(read.client, 'read_multiple_files', { paths: ['a.txt', 'missing.txt'] })).files, [
      { path: 'a.txt', ok: true, content: 'x'.repeat(8000), truncated: true },
      { path: 'missing.txt', ok: false, error_code: 'FILE_NOT_FOUND' },
    ]);
    assert.equal(data(await call(read.client, 'who_am_i')).authenticated_pcrc_account, false);
    for (const [tool, backend, args] of [
      ['create_directory', 'jan_create_directory', { path: 'demo' }],
      ['force_terminate', 'jan_stop_session', { session_id: 'a'.repeat(32) }],
      ['shutdown', 'jan_disable_control', {}],
    ] as const) {
      const count = calls.length;
      assert.equal((await call(first.client, tool, args)).isError, true);
      assert.equal(calls.length, count);
      data(await call(first.client, tool, { ...args, confirmed: true }));
      assert.equal(calls.at(-1), backend);
    }
    data(await call(first.client, 'list_processes'));
    assert.equal(calls.at(-1), 'jan_list_sessions');
  } finally {
    for (const pair of [first, read]) { await pair.client.close(); await pair.server.close(); }
  }
});

test('paginated text searches resume beyond one batch and read-only clients can cancel', async () => {
  let reads = 0;
  const service: Service = { call: async (name, args = {}) => {
    if (name === 'jan_list_files') return { entries: Array.from({ length: 85 }, (_, i) => ({ name: `file-${i}.txt`, kind: 'file' })) };
    if (name === 'jan_read_text') { reads++; return { content: String(args.path) === 'file-84.txt' ? 'needle at end' : 'ordinary text' }; }
    throw new Error('Unexpected service call');
  } };
  const { server, client } = await connected({ control: false, capabilities: new Set() }, service);
  const data = (result: Awaited<ReturnType<typeof client.callTool>>) => {
    assert.equal(result.isError, undefined, JSON.stringify(result));
    return (result.structuredContent as { data: Record<string, unknown> }).data;
  };
  try {
    const first = data(await client.callTool({ name: 'search_workspace', arguments: { query: 'needle', mode: 'text', paginate: true } }));
    assert.equal(first.partial, true);
    assert.equal(first.next_offset, 0);
    assert.equal(reads, 40);
    const second = data(await client.callTool({ name: 'get_more_search_results', arguments: { search_id: first.search_id, offset: first.next_offset } }));
    assert.equal(second.partial, true);
    assert.equal(reads, 80);
    const third = data(await client.callTool({ name: 'get_more_search_results', arguments: { search_id: first.search_id, offset: second.next_offset } }));
    assert.deepEqual(third.matches, [{ path: 'file-84.txt', line: 1, text: 'needle at end' }]);
    assert.equal(third.partial, false);
    assert.equal(third.next_offset, null);
    assert.equal(reads, 85);
    data(await client.callTool({ name: 'stop_search', arguments: { search_id: first.search_id, confirmed: true } }));
    assert.equal((await client.callTool({ name: 'get_more_search_results', arguments: { search_id: first.search_id, offset: 0 } })).isError, true);
    assert.equal(reads, 85);
  } finally { await client.close(); await server.close(); }
});

test('scoped searches continue empty batches inside only the requested folder',async()=>{
 const service:Service={call:async(name,args={})=>{
  if(name==='jan_find_files'){assert.equal(args.path,'qa');return {matches:['qa/file-84.txt']};}
  if(name==='jan_list_files'){assert.equal(args.path,'qa');return {entries:Array.from({length:85},(_,i)=>({name:`file-${i}.txt`,kind:'file'}))};}
  assert.equal(name,'jan_read_text');assert.match(String(args.path),/^qa\/file-\d+\.txt$/);
  return {content:args.path==='qa/file-84.txt'?'synthetic needle':'ordinary text'};
 }};
 const {server,client}=await connected({control:false,capabilities:new Set()},service);
 const data=async(name:string,args:Record<string,unknown>)=>{
  const result=await client.callTool({name,arguments:args});assert.equal(result.isError,undefined);
  return (result.structuredContent as {data:Record<string,any>}).data;
 };
 try{
  assert.deepEqual((await data('search_workspace',{query:'file',path:'qa'})).matches,['qa/file-84.txt']);
  let result=await data('search_workspace',{query:'synthetic needle',mode:'text',path:'qa',paginate:true});
  for(let batch=0;batch<2;batch++){
   assert.deepEqual(result.matches,[]);assert.equal(result.next_offset,0);assert.equal(result.partial,true);
   result=await data('get_more_search_results',{search_id:result.search_id,offset:result.next_offset});
  }
  assert.deepEqual(result.matches,[{path:'qa/file-84.txt',line:1,text:'synthetic needle'}]);
  assert.equal(result.partial,false);assert.equal(result.truncated,false);assert.equal(result.next_offset,null);
 }finally{await client.close();await server.close();}
});

test('throttled search continuation preserves the unread file or directory for an explicit retry',async()=>{
 for(const boundary of ['file','directory']){
  let throttle=true;let attempts=0;
  const service:Service={call:async(name,args={})=>{
   if(name==='jan_list_files'&&args.path==='.')return {entries:[...Array.from({length:40},(_,i)=>({name:`plain-${i}.txt`,kind:'file'})),{name:boundary==='file'?'last.txt':'nested',kind:boundary}]};
   if(name==='jan_list_files'&&args.path==='nested'){
    attempts++;if(throttle)throw new ServiceError('RATE_LIMITED','Wait 60 seconds before retrying a read.');
    return {entries:[{name:'last.txt',kind:'file'}]};
   }
   if(name==='jan_read_text'){
    if(args.path==='last.txt'&&boundary==='file'){attempts++;if(throttle)throw new ServiceError('RATE_LIMITED','Wait 60 seconds before retrying a read.');}
    return {content:String(args.path).endsWith('last.txt')?'needle':'ordinary'};
   }
   throw Error('Unexpected synthetic backend operation');
  }};
  const {server,client}=await connected({control:false,capabilities:new Set()},service);
  try{
   const first=await client.callTool({name:'search_workspace',arguments:{query:'needle',mode:'text',paginate:true}});
   assert.equal(first.isError,undefined);
   const start=(first.structuredContent as {data:Record<string,any>}).data;
   assert.equal(start.partial,true);
   const args={search_id:start.search_id,offset:start.next_offset};
   const blocked=await client.callTool({name:'get_more_search_results',arguments:args});
   assert.equal(blocked.isError,true,boundary);
   assert.equal((blocked.structuredContent as {error_code:string}).error_code,'RATE_LIMITED');
   assert.equal(attempts,1,'No automatic retry');
   throttle=false;
   const resumed=await client.callTool({name:'get_more_search_results',arguments:args});
   assert.equal(resumed.isError,undefined);
   const result=(resumed.structuredContent as {data:Record<string,any>}).data;
   assert.deepEqual(result.matches,[{path:boundary==='file'?'last.txt':'nested/last.txt',line:1,text:'needle'}]);
   assert.equal(result.skipped_files,0);assert.equal(result.next_offset,null);assert.equal(attempts,2);
  }finally{await client.close();await server.close();}
 }
});

test('text search reports a partial match limit even inside its only directory', async () => {
  const { server, client } = await connected({ control: false, capabilities: new Set() }, { call: async name => name === 'jan_list_files' ? { entries: [{ name: 'a.txt', kind: 'file' }, { name: 'b.txt', kind: 'file' }] } : { content: 'needle' } });
  try {
    const result = await client.callTool({ name: 'search_workspace', arguments: { query: 'needle', mode: 'text', limit: 1 } });
    assert.equal(result.isError, undefined);
    const data = (result.structuredContent as { data: Record<string, unknown> }).data;
    assert.equal(data.truncated, true);
  } finally { await client.close(); await server.close(); }
});

test('stopping a shared search during a page read cancels further work without leaking a partial page', async () => {
  let reads = 0;
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const service: Service = { call: async name => {
    if (name === 'jan_list_files') return { entries: Array.from({ length: 90 }, (_, i) => ({ name: `${i}.txt`, kind: 'file' })) };
    reads++;
    if (reads === 41) { entered(); await blocked; }
    return { content: 'ordinary' };
  } };
  const a = await connected({ control: false, capabilities: new Set() }, service), b = await connected({ control: false, capabilities: new Set() }, service);
  try {
    const initial = await a.client.callTool({ name: 'search_workspace', arguments: { query: 'needle', mode: 'text', paginate: true } });
    const id = (initial.structuredContent as { data: { search_id: string } }).data.search_id;
    const next = b.client.callTool({ name: 'get_more_search_results', arguments: { search_id: id, offset: 0 } });
    await waiting;
    const stopped = await a.client.callTool({ name: 'stop_search', arguments: { search_id: id } });
    assert.equal(stopped.isError, undefined);
    release();
    const result = await next;
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error_code: string }).error_code, 'SEARCH_CANCELLED');
    assert.equal(reads, 41);
  } finally { release(); await a.client.close(); await b.client.close(); await a.server.close(); await b.server.close(); }
});

test('resumed match pages preserve line positions and report backend directory truncation', async () => {
  const { server, client } = await connected({ control: false, capabilities: new Set() }, { call: async name => name === 'jan_list_files' ? { entries: [{ name: 'a.txt', kind: 'file' }], truncated: true } : { content: 'needle one\nneedle two\nneedle three' } });
  try {
    const first = await client.callTool({ name: 'search_workspace', arguments: { query: 'needle', mode: 'text', limit: 1, paginate: true } });
    const data = (first.structuredContent as { data: Record<string, unknown> }).data;
    assert.deepEqual(data.matches, [{ path: 'a.txt', line: 1, text: 'needle one' }]);
    const next = await client.callTool({ name: 'get_more_search_results', arguments: { search_id: data.search_id, offset: data.next_offset } });
    const result = (next.structuredContent as { data: Record<string, unknown> }).data;
    assert.deepEqual(result.matches, [{ path: 'a.txt', line: 2, text: 'needle two' }, { path: 'a.txt', line: 3, text: 'needle three' }]);
    assert.equal(result.stop_reason, 'listing_limit');
    assert.equal(result.truncated, true);
    assert.equal(result.partial, false);
    assert.equal(result.next_offset, null);
  } finally { await client.close(); await server.close(); }
});

test('Office inspection and exact spreadsheet previews preserve capability and approval boundaries', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const { server, client } = await connected({ control: true, capabilities: new Set(['files']) }, { call: async (name, args = {}) => { calls.push({ name, args }); return { sha256: 'a'.repeat(64), preview: [{ cell: 'A1', before: 'old', after: 'new' }] }; } });
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find(t => t.name === 'inspect_office_document')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'preview_spreadsheet_edit')?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'preview_spreadsheet_edit')?._meta,undefined);
    assert.equal(tools.find(t => t.name === 'apply_spreadsheet_edit')?._meta, undefined);
    assert.equal(tools.find(t => t.name === 'apply_spreadsheet_edit')?.annotations?.destructiveHint, true);
    assert.equal((await client.callTool({ name: 'inspect_office_document', arguments: { path: 'synthetic.docx' } })).isError, undefined);
    assert.deepEqual(calls[0], { name: 'jan_inspect_office', args: { path: 'synthetic.docx', sheet: '', start_row: 1, max_rows: 50 } });
    const args = { path: 'synthetic.xlsx', sheet: 'Sheet1', changes: [{ cell: 'A1', value: 'new' }, { cell: 'B1', formula: '=SUM(A2:A4)' }], expected_sha256: 'a'.repeat(64) };
    assert.equal((await client.callTool({ name: 'preview_spreadsheet_edit', arguments: args })).isError, undefined);
    assert.equal(calls[1]?.name, 'jan_preview_spreadsheet');
    assert.equal(calls[1]?.args.dry_run, undefined);
    const before = calls.length;
    assert.equal((await client.callTool({ name: 'apply_spreadsheet_edit', arguments: args })).isError, true);
    assert.equal(calls.length, before);
    assert.equal((await client.callTool({ name: 'apply_spreadsheet_edit', arguments: { ...args, confirmed: true } })).isError, undefined);
    assert.equal(calls[2]?.name, 'jan_edit_spreadsheet');
    assert.equal(calls[2]?.args.dry_run, false);
    assert.equal(Object.hasOwn(calls[2]!.args, 'confirmed'), false);
    assert.equal((await client.callTool({ name: 'preview_spreadsheet_edit', arguments: { ...args, changes: [{ cell: 'A1', value: 'text', formula: '=1' }] } })).isError, true);
    assert.equal((await client.callTool({ name: 'preview_spreadsheet_edit', arguments: { ...args, changes: Array.from({ length: 51 }, (_, i) => ({ cell: `A${i+1}`, value: i })) } })).isError, true);
  } finally { await client.close(); await server.close(); }
});

test('text search reports depth omissions without claiming a complete traversal', async () => {
  const { server, client } = await connected({ control: false, capabilities: new Set() }, { call: async (name, args = {}) => {
    assert.equal(name, 'jan_list_files');
    const depth = String(args.path) === '.' ? 0 : String(args.path).split('/').length;
    return { entries: [{ name: `level${depth + 1}`, kind: 'directory' }] };
  } });
  try {
    const first = await client.callTool({ name: 'search_workspace', arguments: { query: 'needle', mode: 'text', paginate: true } });
    assert.equal(first.isError, undefined);
    const data = (first.structuredContent as { data: Record<string, unknown> }).data;
    assert.equal(data.truncated, true);
    assert.equal(data.skipped_directories, 1);
    assert.equal(data.stop_reason, 'depth_limit');
    assert.equal(data.partial, false);
    assert.equal(data.next_offset, null);
  } finally { await client.close(); await server.close(); }
});

test('text search reports unreadable omissions without exposing private paths or backend errors', async () => {
  const { server, client } = await connected({ control: false, capabilities: new Set() }, { call: async name => {
    if (name === 'jan_list_files') return { entries: [{ name: 'private-fixture.txt', kind: 'file' }] };
    throw new ServiceError('PATH_POLICY_DENIED', 'PRIVATE_ERROR_TEXT');
  } });
  try {
    const first = await client.callTool({ name: 'search_workspace', arguments: { query: 'needle', mode: 'text', paginate: true } });
    assert.equal(first.isError, undefined);
    const data = (first.structuredContent as { data: Record<string, unknown> }).data;
    assert.equal(data.truncated, true);
    assert.equal(data.skipped_files, 1);
    assert.equal(data.stop_reason, 'unreadable_files');
    assert.equal(data.partial, false);
    assert.equal(data.next_offset, null);
    assert.ok(!JSON.stringify(first).includes('private-fixture.txt'));
    assert.ok(!JSON.stringify(first).includes('PRIVATE_ERROR_TEXT'));
  } finally { await client.close(); await server.close(); }
});

test('generic handler errors cannot echo sensitive backend messages', async () => {
  const { server, client } = await connected({ control: false, capabilities: new Set() }, { call: async () => { throw new Error('password=synthetic-handler-error'); } });
  try {
    const result = await client.callTool({ name: 'inspect_file', arguments: { path: 'synthetic.txt' } });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('synthetic-handler-error'));
    assert.equal((result.structuredContent as { error_code: string }).error_code, 'SENSITIVE_CONTENT_BLOCKED');
  } finally { await client.close(); await server.close(); }
});

test('successful handler results use the same privacy boundary as Python service results', async () => {
  const { server, client } = await connected({ control: false, capabilities: new Set() }, { call: async () => ({ output: { password: ['synthetic-handler-secret'] } }) });
  try {
    const result = await client.callTool({ name: 'inspect_file', arguments: { path: 'synthetic.txt' } });
    assert.equal(result.isError, true);
    assert.ok(!JSON.stringify(result).includes('synthetic-handler-secret'));
    assert.equal((result.structuredContent as { error_code: string }).error_code, 'SENSITIVE_CONTENT_BLOCKED');
  } finally { await client.close(); await server.close(); }
});

test('search discovery documents the enforced match limit before the backend is called', async () => {
  let calls = 0;
  const { server, client } = await connected({ control: false, capabilities: new Set() }, { call: async () => { calls++; return { matches: [] }; } });
  try {
    const tool = (await client.listTools()).tools.find(item => item.name === 'search_workspace')!;
    const schema = tool.inputSchema as unknown as { properties: { limit: { maximum?: number; default?: number; description?: string } } };
    assert.equal(schema.properties.limit.maximum, 50);
    assert.equal(schema.properties.limit.default, 20);
    assert.match(tool.description ?? '', /1[–.\-]+50/);
    assert.match(schema.properties.limit.description ?? '', /1[–.\-]+50/);
    const invalid = await client.callTool({ name: 'search_workspace', arguments: { query: 'needle', limit: 51 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls, 0);
  } finally { await client.close(); await server.close(); }
});


test('development tools require both commands and files catalog capabilities',async()=>{
  for(const capabilities of [new Set<import('./tasks.js').Capability>(['commands']),new Set<import('./tasks.js').Capability>(['files'])]){
    const {client,server}=await connected({control:true,capabilities},{call:async()=>{throw Error('Must not dispatch');}});
    try{assert.ok(!(await client.listTools()).tools.some(t=>['inspect_development','preview_development_change','apply_development_change','get_development_change'].includes(t.name)));}
    finally{await client.close();await server.close();}
  }
});
