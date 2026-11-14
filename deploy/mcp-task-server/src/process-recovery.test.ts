import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {spawnSync} from 'node:child_process';

test('packaged process lifecycle, backup restoration and isolated shutdown have verified receipts',{timeout:90000},async()=>{
 const root=await mkdtemp(join(tmpdir(),'pcrc-process-recovery-'));
 const workspace=join(root,'files');await mkdir(workspace);
 const python=process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe');
 const transport=new StdioClientTransport({command:process.execPath,args:[process.env.PCRC_TEST_TASK_ENTRY||resolve(import.meta.dirname,'main.js'),'--foreground'],env:{...process.env,JAN_MCP_WORKSPACE:workspace,JAN_MCP_STATE_DIR:join(root,'private'),JAN_MCP_PYTHON:python,JAN_MCP_CONTROL:'1',JAN_MCP_CAPABILITIES:'files,commands'},stderr:'pipe'});
 const client=new Client({name:'pcrc-process-recovery-acceptance',version:'1'});
 const calls:Array<{tool:string;ms:number}>=[];
 const call=async(name:string,args:Record<string,unknown>={})=>{
  const start=performance.now();const value=await client.callTool({name,arguments:args});
  assert.equal(value.isError,undefined,JSON.stringify(value));calls.push({tool:name,ms:Math.round(performance.now()-start)});
  return (value.structuredContent as {data:Record<string,any>}).data;
 };
 const wait=async(id:string)=>{
  const end=Date.now()+10000;let value:Record<string,any>={running:true};
  while(value.running&&Date.now()<end){value=await call('read_process_output',{session_id:id});if(value.running)await delay(200);}
  assert.equal(value.running,false);return value;
 };
 try{
  await client.connect(transport);
  const version=(await call('get_connection_status')).version;
  if(process.env.PCRC_EXPECT_VERSION)assert.equal(version,process.env.PCRC_EXPECT_VERSION);
  await call('create_text_file',{path:'sample.txt',content:'before\n'});
  const initial=await call('inspect_file',{path:'sample.txt'});
  const args={path:'sample.txt',old_text:'before',new_text:'after',expected_sha256:initial.sha256};
  await call('preview_file_edit',args);
  const changed=await call('apply_file_edit',{...args,confirmed:true});
  assert.equal((await call('read_file_excerpt',{path:'sample.txt'})).content,'after\n');
  await call('restore_file_backup',{backup_id:changed.backup_id,confirmed:true});
  assert.equal((await call('read_file_excerpt',{path:'sample.txt'})).content,'before\n');
  const workbook=join(workspace,'sheet.xlsx');
  const fixtureCode=`import sys
from zipfile import ZipFile,ZIP_DEFLATED
with ZipFile(sys.argv[1],'w',ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
 z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Inputs" sheetId="1" r:id="rId1"/></sheets></workbook>')
 z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
 z.writestr('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="B3"><f>SUM(A1:A2)</f><v>3</v></c></row></sheetData></worksheet>')
`;
  const fixture=spawnSync(python,['-I','-c',fixtureCode,workbook],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(fixture.status,0,fixture.stderr);
  const sheetInfo=await call('inspect_file',{path:'sheet.xlsx'});
  await call('inspect_office_document',{path:'sheet.xlsx',sheet:'Inputs'});
  const spreadsheet={path:'sheet.xlsx',sheet:'Inputs',expected_sha256:sheetInfo.sha256,changes:[{cell:'A1',value:40},{cell:'B3',formula:'=SUM(A1:A2)'}]};
  await call('preview_spreadsheet_edit',spreadsheet);
  await call('apply_spreadsheet_edit',{...spreadsheet,confirmed:true});
  assert.notEqual((await call('inspect_file',{path:'sheet.xlsx'})).sha256,sheetInfo.sha256);
  const reopen=spawnSync(python,['-I','-c',"import sys,json,zipfile,xml.etree.ElementTree as E; s=E.fromstring(zipfile.ZipFile(sys.argv[1]).read('xl/worksheets/sheet1.xml')); n={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}; print(json.dumps([s.find(\".//s:c[@r='A1']/s:v\",n).text,s.find(\".//s:c[@r='B3']/s:f\",n).text]))",workbook],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(reopen.status,0,reopen.stderr);assert.deepEqual(JSON.parse(reopen.stdout),['40','SUM(A1:A2)']);
  const stale=await client.callTool({name:'apply_spreadsheet_edit',arguments:{...spreadsheet,confirmed:true}});assert.equal(stale.isError,true);
  const command=await call('run_command',{command:process.platform==='win32'?"Write-Output 'PCRC_COMMAND_OK'":"printf PCRC_COMMAND_OK",confirmed:true});
  assert.equal(command.exit_code,0);assert.match(command.output,/PCRC_COMMAND_OK/);
  const echo=await call('start_process',{command:'python -u -c "import sys; print(\'PCRC_READY\',flush=True); print(\'PCRC_ECHO:\'+sys.stdin.readline().strip(),flush=True)"',timeout_seconds:20,confirmed:true});
  await call('send_process_input',{session_id:echo.session_id,text:'synthetic-input',newline:true,confirmed:true});
  const output=await wait(echo.session_id);assert.equal(output.exit_code,0);assert.match(output.output,/PCRC_ECHO:synthetic-input/);
  const sleeping=()=>call('start_program',{executable:python,arguments:['-u','-c','import time; print("PCRC_SLEEP",flush=True); time.sleep(30)'],timeout_seconds:40,confirmed:true});
  const first=await sleeping();
  assert.ok(JSON.stringify(await call('list_processes')).includes(first.session_id));
  await call('stop_process',{session_id:first.session_id,confirmed:true});
  assert.ok(!JSON.stringify(await call('list_processes')).includes(first.session_id));
  const second=await sleeping();
  await call('force_terminate',{session_id:second.session_id,confirmed:true});
  assert.ok(!JSON.stringify(await call('list_processes')).includes(second.session_id));
  await call('shutdown',{confirmed:true});assert.equal((await call('get_capabilities')).control_enabled,false);
  const denied=await client.callTool({name:'run_command',arguments:{command:'echo MUST_NOT_RUN',confirmed:true}});
  assert.equal(denied.isError,true);
  const report={version,public_gateway_test:false,packaged_client:Boolean(process.env.PCRC_TEST_TASK_ENTRY),checks:{backup_restore_reopened:true,spreadsheet_edit_reopened_and_formula_preserved:true,spreadsheet_stale_hash_rejected:true,command_output:true,process_stdin_and_natural_exit:true,owned_program_stop:true,owned_program_force_terminate:true,isolated_shutdown_revokes_commands:true},calls};
  await writeFile(resolve(import.meta.dirname,'../../../work/process-recovery-latest-test.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
 }finally{
  await client.close();assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});
 }
});
