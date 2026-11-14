import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,access,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';

test('packaged Windows accessibility actions, negative guards and measured screenshot fallback',{
 skip:process.platform!=='win32'||process.env.PCRC_UIA_NATIVE_TEST!=='1',timeout:180000,
},async()=>{
 const root=process.env.PCRC_UIA_QA_DIR||await mkdtemp(join(tmpdir(),'pcrc-uia-'));
 await mkdir(root,{recursive:true});const workspace=join(root,'files');await mkdir(workspace);
 const fixture=resolve(import.meta.dirname,'../../../tests/fixtures/windows-uia-fixture.ps1');
 const gui=spawn(join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-STA','-File',fixture,'-State',root,...(process.env.PCRC_UIA_QA_FULLSCREEN==='1'?['-FullScreen']:[])],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let fixtureError='';gui.stderr.on('data',b=>{fixtureError+=String(b).slice(0,3000);});
 const transport=new StdioClientTransport({command:process.execPath,args:[process.env.PCRC_TEST_TASK_ENTRY||resolve(import.meta.dirname,'main.js'),'--foreground'],env:{...process.env,JAN_MCP_WORKSPACE:workspace,JAN_MCP_STATE_DIR:join(root,'private'),JAN_MCP_PYTHON:process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe'),JAN_MCP_CONTROL:'1',JAN_MCP_CAPABILITIES:'desktop'},stderr:'pipe'});
 const client=new Client({name:'pcrc-uia-acceptance',version:'1'});
 const checks:Record<string,boolean>={};const timings:Array<{method:string;ms:number;calls:number;returned_bytes:number}>=[];
 let bytes=0,calls=0;
 async function tool(name:string,args:Record<string,unknown>={},expectedError?:string){
  const started=performance.now();
  const reply=await client.callTool({name,arguments:args});bytes+=Buffer.byteLength(JSON.stringify(reply));calls++;
  const result=reply.structuredContent as {ok:boolean;error_code?:string;data:Record<string,any>};
  console.log(JSON.stringify({tool:name,action:args.action,ms:Math.round(performance.now()-started),ok:result.ok,error_code:result.error_code}));
  if(expectedError){assert.equal(reply.isError,true,JSON.stringify(reply));assert.equal(result.error_code,expectedError);}
  else assert.equal(reply.isError,undefined,JSON.stringify(reply));
  return {data:result.data,reply};
 }
 async function command(text:string){
  await unlink(join(root,'ack.txt')).catch(()=>undefined);
  await writeFile(join(root,'command.txt'),text);
  const end=Date.now()+4000;
  while(Date.now()<end){try{if((await readFile(join(root,'ack.txt'),'utf8'))===text)return;}catch{}await delay(30);}
  throw Error('Synthetic UI command not acknowledged');
 }
 async function inspect(){return (await tool('inspect_desktop_controls')).data;}
 async function verifySaved(path:string,expected:string){
  const end=Date.now()+2000;
  let contents='';
  while(Date.now()<end){
   try {contents=await readFile(path,'utf8');if(contents===expected)break;}catch{}
   await delay(25);
  }
  assert.equal(contents,expected);
 }
 async function captureFixture(handle:string){
  const frame=await tool('capture_desktop');
  assert.equal(frame.data.foreground_window,handle,'The disposable fixture lost focus');
  return frame;
 }
 async function act(state:Record<string,any>,name:string,action='invoke',text=''){
  const target=state.controls.find((c:any)=>c.name===name);assert.ok(target,name);
  return (await tool('interact_desktop_control',{inspection_id:state.inspection_id,control_id:target.control_id,action,text,confirmed:true})).data;
 }
 try {
  const end=Date.now()+12000;
  while(Date.now()<end){try{await access(join(root,'ready.txt'));break;}catch{}assert.equal(gui.exitCode,null,fixtureError);await delay(50);}
  await access(join(root,'ready.txt'));await client.connect(transport);
  const fixtureHandle=await readFile(join(root,'ready.txt'),'utf8');
  async function inspectFixture(){
   const end=Date.now()+5000;
   while(Date.now()<end){
    const state=await inspect();
    if(state.window?.handle===fixtureHandle&&state.controls?.some((c:any)=>c.name==='Message'))return state;
    await command('focus');
   }
   throw Error('The disposable fixture controls did not return to the foreground');
  }
  const names=(await client.listTools()).tools.map(t=>t.name);
  const version=(await tool('get_connection_status')).data.version;
  if(process.env.PCRC_EXPECT_VERSION)assert.equal(version,process.env.PCRC_EXPECT_VERSION);
  assert.ok(names.includes('inspect_desktop_controls')&&names.includes('interact_desktop_control'));checks.packaged_catalog=true;
  await command('focus');
  await command('save-dialog');
  const dialogDeadline=Date.now()+12000;
  let dialog:Record<string,any>|undefined;
  while(Date.now()<dialogDeadline){
   try {dialog=await inspect();} catch(error) {
    if(!(error instanceof Error)||!error.message.includes('UIA_TARGET_CHANGED'))throw error;
   }
   if(dialog?.window?.title==='PCRC synthetic Save As')break;
   await command('focus-save-dialog');
   await delay(50);
  }
  assert.ok(dialog?.window?.title==='PCRC synthetic Save As','The disposable Save As dialog was not observed in the foreground before the deadline; no input sent');
  assert.equal(dialog.method,'uia_unavailable','The native file dialog must require the reviewed keyboard path');
  assert.match(dialog.reason,/file dialog/i);assert.deepEqual(dialog.controls,[]);assert.equal(dialog.inspection_id,undefined);
  await assert.rejects(access(join(root,'default.txt')));
  const expected=join(root,'reviewed.txt');
  for(const args of [{action:'hotkey',keys:['alt','n']},{action:'hotkey',keys:['ctrl','a']},{action:'type',text:expected},{action:'hotkey',keys:['enter']}]){
   const frame=(await captureFixture(dialog.window.handle)).data;
   await tool('interact_desktop',{...args,frame_id:frame.frame_id,confirmed:true});
  }
  await verifySaved(expected,'PCRC_DIALOG_SAVED');await assert.rejects(access(join(root,'default.txt')));
  checks.file_dialog_keyboard_path_verified=true;
  await command('focus');
  let state=await inspectFixture();assert.equal(state.method,'windows_uia');
  assert.ok(!state.controls.some((c:any)=>/password|\bpin\b|hidden/i.test(c.name)));checks.protected_and_hidden_omitted=true;
  const duplicates=state.controls.filter((c:any)=>c.name==='Duplicate');assert.equal(duplicates.length,2);assert.notEqual(duplicates[0].control_id,duplicates[1].control_id);checks.duplicate_names_have_distinct_ids=true;
  const message=state.controls.find((c:any)=>c.name==='Message');assert.ok(message);
  await tool('interact_desktop_control',{inspection_id:state.inspection_id,control_id:message.control_id,action:'set_value',text:'password=hunter2',confirmed:true},'SENSITIVE_CONTENT_BLOCKED');checks.protected_input_rejected=true;
  let result=await act(state,'Message','set_value','PCRC_UIA_Ab9');assert.equal(result.value_matches,true);checks.set_value_readback=true;
  await tool('interact_desktop_control',{inspection_id:state.inspection_id,control_id:duplicates[0].control_id,action:'invoke',confirmed:true},'UIA_INSPECTION_REQUIRED');checks.single_use=true;
  state=await inspectFixture();result=await act(state,'Save draft');
  assert.equal(result.performed,true);
  await verifySaved(join(root,'saved.txt'),'PCRC_UIA_Ab9');checks.invoke_readback=true;
  for(const stimulus of ['replace','change','disable','hide']){
   await command('reset');state=await inspectFixture();await command(stimulus);
   const target=state.controls.find((c:any)=>c.name==='Message');
   await tool('interact_desktop_control',{inspection_id:state.inspection_id,control_id:target.control_id,action:'set_value',text:'Must not write',confirmed:true},'UIA_TARGET_CHANGED');checks[stimulus+'_rejected']=true;
  }
  await command('reset');state=await inspectFixture();await command('blank');
  await tool('interact_desktop_control',{inspection_id:state.inspection_id,control_id:state.controls[0].control_id,action:'invoke',confirmed:true},'UIA_INSPECTION_REQUIRED');checks.foreground_change_rejected=true;
  assert.equal((await inspect()).method,'uia_unavailable');
  const fallback=await tool('inspect_desktop_controls',{fallback_to_screenshot:true});
  assert.equal(fallback.data.method,'screenshot');assert.ok(fallback.data.frame_id);assert.ok(fallback.reply.content.some(c=>c.type==='image'));checks.explicit_fresh_screenshot_fallback=true;
  await command('focus');await command('reset');
  const positions=JSON.parse(await readFile(join(root,'positions.json'),'utf8'));
  for(let trial=0;trial<3;trial++)for(const method of ['windows_uia','screenshot']){
   await command('focus');await command('reset');
   const marker='PCRC_'+method+'_'+trial;const start=performance.now();bytes=0;calls=0;
   if(method==='windows_uia'){
    await act(await inspectFixture(),'Message','set_value',marker);
    const result=await act(await inspectFixture(),'Save draft');assert.equal(result.performed,true);
   } else {
    // Fixed synthetic fixture geometry is the test oracle; production fallback never chooses coordinates.
    let frame=(await captureFixture(fixtureHandle)).data;
    await tool('interact_desktop',{action:'click',...positions.field,frame_id:frame.frame_id,confirmed:true});
    frame=(await captureFixture(fixtureHandle)).data;
    await tool('interact_desktop',{action:'type',text:marker,frame_id:frame.frame_id,confirmed:true});
    frame=(await captureFixture(fixtureHandle)).data;
    await tool('interact_desktop',{action:'click',...positions.save,frame_id:frame.frame_id,confirmed:true});
    const last=await captureFixture(fixtureHandle);const image=last.reply.content.find(c=>c.type==='image');
    assert.ok(image&&image.type==='image');await writeFile(join(root,'screenshot-final-'+trial+'.jpg'),Buffer.from(image.data,'base64'));
   }
   await verifySaved(join(root,'saved.txt'),marker);
   timings.push({method,ms:Math.round(performance.now()-start),calls,returned_bytes:bytes});
  }
  checks.screenshot_completion=true;
  const report={published:false,packaged_client:Boolean(process.env.PCRC_TEST_TASK_ENTRY),version,transport:'local stdio; not public network benchmark',checks,timings,fixture_only:true};
  await writeFile(join(root,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 } finally {
  await writeFile(join(root,'checkpoint.json'),JSON.stringify({checks,timings},null,2)).catch(()=>undefined);
  await writeFile(join(root,'command.txt'),'close').catch(()=>undefined);
  await client.close().catch(()=>undefined);
  if(gui.exitCode===null){await delay(300);if(gui.exitCode===null)gui.kill();}
 }
});
