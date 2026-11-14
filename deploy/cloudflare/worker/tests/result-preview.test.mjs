import test from 'node:test';
import assert from 'node:assert/strict';
import {resultPreviewUri,resultPreviewResource,includeResultPreview} from '../src/result_preview.ts';
import {controlRequired,proxyMcp} from '../src/policy.ts';

test('cached result templates are removed without changing native tool annotations',()=>{
 const tools=['preview_document_workflow','get_document_workflow','get_action_result','inspect_office_document'].map(name=>({name,_meta:{ui:{resourceUri:resultPreviewUri,visibility:['model']},'openai/outputTemplate':resultPreviewUri,other:'preserved'},annotations:{readOnlyHint:true}}));
 includeResultPreview({result:{tools}},'tools/list');
 for(const tool of tools){assert.equal(tool._meta.ui.resourceUri,undefined);assert.equal(tool._meta['openai/outputTemplate'],undefined);assert.deepEqual(tool._meta.ui.visibility,['model']);assert.equal(tool._meta.other,'preserved');assert.equal(tool.annotations.readOnlyHint,true);}
});
test('result panels are absent from discovery and retired reads contain no HTML or private data',()=>{
 const resources={result:{resources:[{uri:resultPreviewUri},{uri:'app://pcrc/device/selected'}]}};
 includeResultPreview(resources,'resources/list');includeResultPreview(resources,'resources/list');
 assert.deepEqual(resources.result.resources,[{uri:'app://pcrc/device/selected'}]);
 assert.deepEqual(resultPreviewResource(1),{jsonrpc:'2.0',id:1,result:{contents:[]}});
 const initialized={result:{capabilities:{}}};includeResultPreview(initialized,'initialize');
 assert.deepEqual(initialized.result.capabilities,{});
});
test('plain results and other app resources are preserved; removal grants no authority',()=>{
 const reply={result:{content:[{type:'text',text:'Synthetic result'}],structuredContent:{ok:true,data:{value:12}}}};
 const expected=structuredClone(reply);includeResultPreview(reply,'tools/call');assert.deepEqual(reply,expected);
 const tool={name:'separate_ui_test',_meta:{ui:{resourceUri:'ui://pcrc/approval-card'}}};includeResultPreview({result:{tools:[tool]}},'tools/list');assert.equal(tool._meta.ui.resourceUri,'ui://pcrc/approval-card');
 for(const name of ['inspect_office_document','preview_spreadsheet_edit','preview_file_edit'])assert.equal(controlRequired(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name}}))),false);
 assert.equal(controlRequired(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name:'apply_spreadsheet_edit'}}))),true);
});
test('retired result resources remain authenticated and never reach a computer',async()=>{
 const origin='https://result-test.example.workers.dev';
 const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticId',GITHUB_CLIENT_SECRET:'synthetic-private-key',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:id=>id,get:()=>({fetch:async url=>new URL(url).pathname==='/abuse/check'?new Response(null,{status:204}):Response.json(new URL(url).pathname==='/account/auth-version'?{authVersion:0}:{})})}};
 const auth={audience:origin+'/mcp',userId:'5678',scope:['pcrc:read']};
 const request=()=>new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:resultPreviewUri}})});
 const response=await proxyMcp(request(),env,auth,{accountId:'5678'},()=>assert.fail('Retired view dispatched to computer'));
 assert.equal(response.status,200);assert.deepEqual((await response.json()).result.contents,[]);
 assert.equal((await proxyMcp(request(),env,{...auth,scope:[]},{accountId:'5678'})).status,403);
 assert.equal((await proxyMcp(request(),env,auth,{accountId:'9012'})).status,403);
});
