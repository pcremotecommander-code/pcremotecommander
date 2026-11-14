import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

test('real task catalog completes reviewed Word PDF template table and page workflows',async()=>{
  const prefix=process.env.PCRC_DOCUMENT_QA_PREFIX||join(tmpdir(),'pcrc-document-test-');
  const root=await mkdtemp(prefix);const workspace=join(root,'files');await mkdir(workspace);
  const state=await mkdtemp(join(tmpdir(),'pcrc-document-private-'));
  const python=process.env.JAN_TEST_PYTHON||resolve(import.meta.dirname,'../../../.venv/Scripts/python.exe');
  const fixture=`from pathlib import Path
from zipfile import ZipFile,ZIP_DEFLATED
import sys
from PIL import Image
root=Path(sys.argv[1])
for filename,a,b in [('source.docx','Hello ','world'),('template.docx','{{cli','ent}}')]:
 with ZipFile(root/filename,'w',ZIP_DEFLATED) as z:
  z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">'+a+'</w:t></w:r><w:r><w:t>'+b+'</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Count</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Apples</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>12</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
Image.new('RGB',(120,60),'#1269c7').save(root/'image.png')
`;
  execFileSync(python,['-I','-c',fixture,workspace],{windowsHide:true});
  const transport=new StdioClientTransport({command:process.execPath,args:[process.env.PCRC_TEST_TASK_ENTRY||resolve(import.meta.dirname,'main.js'),'--foreground'],
    env:{...process.env,JAN_MCP_WORKSPACE:workspace,JAN_MCP_STATE_DIR:state,JAN_MCP_PYTHON:python,JAN_MCP_CONTROL:'1',JAN_MCP_CAPABILITIES:'files,commands'},stderr:'pipe'});
  const client=new Client({name:'pcrc-document-acceptance',version:'1'});
  const checks:Record<string,unknown>={};
  async function tool(name:string,args:Record<string,unknown>={}){
    const reply=await client.callTool({name,arguments:args});assert.equal(reply.isError,undefined,JSON.stringify(reply));
    const text=reply.content.filter(c=>c.type==='text').at(-1);
    assert.ok(text&&text.type==='text');assert.deepEqual(JSON.parse(text.text),reply.structuredContent);
    return {reply,data:(reply.structuredContent as {data:Record<string,unknown>}).data};
  }
  async function waitPlan(plan:Record<string,unknown>){
    const deadline=Date.now()+130000;
    while(['preparing','applying'].includes(String(plan.status))&&!plan.outcome_unknown){
      assert.ok(Date.now()<deadline,JSON.stringify(plan));await delay(1000);
      plan=(await tool('get_document_workflow',{plan_id:plan.plan_id})).data;
    }
    return plan;
  }
  async function apply(jobs:unknown[]){
    const p=await waitPlan((await tool('preview_document_workflow',{jobs})).data);
    assert.ok((p.jobs as Array<{status:string}>).every(job=>job.status==='ready'),JSON.stringify(p));
    const r=await waitPlan((await tool('apply_document_workflow',{plan_id:p.plan_id,review_sha256:p.review_sha256,review:p.jobs,confirmed:true})).data);
    assert.equal(r.status,'completed',JSON.stringify(r));
    assert.ok((r.jobs as Array<{outputs:Array<{verified:boolean}>}>).every(job=>job.outputs.every(o=>o.verified)));
    return r;
  }
  try{
    await client.connect(transport);
    const tools=(await client.listTools()).tools;
    assert.ok(!(await client.listResources()).resources.some(r=>r.uri==='ui://pcrc/result-preview-v1.html'));
    const names=tools.map(t=>t.name);
    for(const tool of tools.filter(t=>['inspect_office_document','inspect_document_pdf','preview_document_workflow','get_document_workflow'].includes(t.name))) {
      assert.equal(tool._meta?.['openai/outputTemplate'],undefined);
      assert.equal((tool._meta?.ui as {resourceUri?:string}|undefined)?.resourceUri,undefined);
    }
    for(const name of ['inspect_document_pdf','preview_document_workflow','apply_document_workflow','get_document_workflow'])assert.ok(names.includes(name));
    checks.catalog=true;
    const status=(await tool('get_connection_status')).data;
    if(process.env.PCRC_EXPECT_VERSION)assert.equal(status.version,process.env.PCRC_EXPECT_VERSION);
    assert.equal(status.connection_lifetime,'until terminal closes');checks.runtime=status.version;
    const source=(await tool('inspect_office_document',{path:'source.docx'})).data;
    assert.equal((source.locations as Array<{location:string}>)[0]?.location,'p00001');
    const revised=await apply([{kind:'revise_docx_pdf',path:'source.docx',expected_sha256:source.sha256,destination:'revised.docx',pdf_destination:'revised.pdf',edits:[{location:'p00001',old:'Hello world',new:'Reviewed PCRC document'}]}]);
    const receipt=(await tool('get_document_workflow',{plan_id:revised.plan_id})).data;assert.equal(receipt.status,'completed');
    assert.equal((await tool('inspect_office_document',{path:'source.docx'})).data.sha256,source.sha256);
    const saved=(await tool('inspect_office_document',{path:'revised.docx'})).data;assert.ok((saved.paragraphs as string[]).includes('Reviewed PCRC document'));checks.revised_word_pdf_reopen=true;
    const template=(await tool('inspect_office_document',{path:'template.docx'})).data;
    await apply([{kind:'fill_docx_template',path:'template.docx',expected_sha256:template.sha256,destination:'filled.docx',values:{client:'Sample Company'}},
      {kind:'extract_tables',path:'source.docx',expected_sha256:source.sha256,destination:'word.csv'}]);
    assert.match(await readFile(join(workspace,'word.csv'),'utf8'),/Apples,12/);checks.template_and_batch_csv=true;
    await apply([{kind:'create_markdown_pdf',destination:'formatted.pdf',markdown:'# Monthly summary\n\nSynthetic paragraph.\n\n- First item\n- Second item\n\n| Item | Count |\n| --- | --- |\n| Apples | 12 |\n\n![Image](image.png)'}]);
    const pdf=(await tool('inspect_document_pdf',{path:'formatted.pdf',pages:[1]}));
    assert.equal(pdf.data.rendering_verified,true);const image=pdf.reply.content.find(c=>c.type==='image');assert.ok(image&&image.type==='image');
    await writeFile(join(workspace,'formatted-preview.jpg'),Buffer.from(image.data,'base64'));checks.formatted_pdf_visual=true;
    const editedPdf=(await tool('inspect_document_pdf',{path:'revised.pdf',pages:[]})).data;
    await apply([{kind:'pdf_pages',destination:'arranged.pdf',sources:[{path:'formatted.pdf',sha256:pdf.data.sha256},{path:'revised.pdf',sha256:editedPdf.sha256}],pages:[{path:'formatted.pdf',page:1},{path:'revised.pdf',page:1},{path:'formatted.pdf',page:1}]}]);
    assert.equal((await tool('inspect_document_pdf',{path:'arranged.pdf',pages:[]})).data.page_count,3);checks.pdf_pages=true;
    await apply([{kind:'extract_tables',path:'formatted.pdf',expected_sha256:pdf.data.sha256,destination:'pdf.csv'}]);
    assert.match(await readFile(join(workspace,'pdf.csv'),'utf8'),/Apples,12/);checks.pdf_table_csv=true;
    for(const command of ['node --version','git --version']){
      const data=(await tool('run_command',{command,shell:process.platform==='win32'?'cmd':'system',confirmed:true})).data;assert.equal(data.exit_code,0);checks[command]=true;
    }
    const input=await readFile(join(workspace,'source.docx'));assert.equal(createHash('sha256').update(input).digest('hex'),source.sha256);
    const imageSource=(await tool('inspect_file',{path:'image.png'})).data;
    const imageCopy=(await tool('edit_media',{path:'image.png',destination:'resized.jpg',kind:'image',expected_sha256:imageSource.sha256,width:60,height:30,confirmed:true})).data;
    assert.deepEqual([imageCopy.format,imageCopy.width,imageCopy.height],['JPEG',60,30]);
    const imageRead=(await tool('inspect_media',{path:'resized.jpg',kind:'image'})).data;
    assert.deepEqual([imageRead.format,imageRead.width,imageRead.height],['JPEG',60,30]);checks.image_receipt_reopen=true;
    const leases:Array<Record<string,unknown>>=[];
    for(let i=0;i<9;i++){
      const task=(await tool('create_task',{title:'Synthetic queue '+i,confirmed:true})).data;
      const lease=(await tool('claim_task',{task_id:task.id,agent:'Synthetic assistant '+i,resources:['file:assignment-'+(i===8?0:i)+'.txt'],confirmed:true})).data;
      assert.equal(lease.status,i<8?'active':'waiting');leases.push(lease);
    }
    await tool('finish_task',{task_id:leases[0]!.id,lease_token:leases[0]!.lease_token,status:'completed',confirmed:true});
    const waiting=leases[8]!;
    assert.equal((await tool('renew_task',{task_id:waiting.id,lease_token:waiting.lease_token,confirmed:true})).data.status,'active');
    for(const lease of leases.slice(1))await tool('finish_task',{task_id:lease.id,lease_token:lease.lease_token,status:'completed',confirmed:true});
    checks.eight_assignments_and_queue=true;checks.text_only_results=true;
    await writeFile(join(root,'report.json'),JSON.stringify({candidate_only:true,checks,workspace},null,2));
    console.log(JSON.stringify({candidate_only:true,checks,workspace}));
  }finally{
    await client.close().catch(()=>undefined);
    assert.ok(resolve(state).startsWith(resolve(tmpdir())+sep));await rm(state,{recursive:true,force:true});
    if(!process.env.PCRC_DOCUMENT_QA_PREFIX){assert.ok(resolve(root).startsWith(resolve(tmpdir())+sep));await rm(root,{recursive:true,force:true});}
  }
});
