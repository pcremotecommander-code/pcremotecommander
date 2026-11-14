import test from 'node:test';
import assert from 'node:assert/strict';
import {includeApprovalPreview} from '../src/approval_preview.ts';
import vm from 'node:vm';
import {approvalCardUri,approvalCardTool,approvalCardHtml,approvalCardResult,includeApprovalCard} from '../src/approval_card.ts';
import {proxyMcp,controlRequired} from '../src/policy.ts';

test('native-host discovery removes custom approval probes but preserves action receipts and write annotations',()=>{
  const reply={result:{tools:[{name:'create_text_file',annotations:{readOnlyHint:false,destructiveHint:false}},approvalCardTool,{name:'test_approval_dialog'}]}};
  const filtered=includeApprovalCard(includeApprovalPreview(reply,false),'tools/list',false);
  assert.deepEqual(filtered.result.tools.map(tool=>tool.name),['create_text_file','get_action_result']);
  assert.equal(filtered.result.tools[0].annotations.readOnlyHint,false);
  const resources=includeApprovalCard({result:{resources:[{uri:approvalCardUri},{uri:'app://pcrc/device/selected'}]}},'resources/list',false);
  assert.deepEqual(resources.result.resources,[{uri:'app://pcrc/device/selected'}]);
  const init=includeApprovalCard({result:{capabilities:{tools:{}}}},'initialize',false);
  assert.equal(init.result.capabilities.extensions,undefined);
});

test('native-host cached diagnostic calls cannot open PCRC UI or authorize execution',async()=>{
  const origin='https://pcrc-test.example.workers.dev';
  const env={JAN_PUBLIC_ORIGIN:origin,JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticId',GITHUB_CLIENT_SECRET:'synthetic-private-key',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:id=>id,get:()=>({fetch:async url=>{if(String(url).endsWith('/abuse/check'))return new Response(null,{status:204});assert.ok(String(url).endsWith('/account/auth-version'));return Response.json({authVersion:0});}})}};
  const auth={audience:origin+'/mcp',userId:'5678',scope:['pcrc:read','pcrc:control']};
  for(const host of ['chatgpt','claude'])for(const params of [{name:'test_approval_card',arguments:{}},{name:'test_approval_dialog',arguments:{}},{uri:approvalCardUri}]){
    const message={jsonrpc:'2.0',id:1,method:params.uri?'resources/read':'tools/call',params};
    const response=await proxyMcp(new Request(origin+'/mcp',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(message)}),env,auth,{githubId:'5678',confirmationHost:host},()=>assert.fail('Disabled probe reached computer'));
    const reply=await response.json();
    assert.equal(reply.result.isError,true);
    assert.match(reply.result.content[0].text,/client's own tool confirmations/);
    assert.ok(!JSON.stringify(reply).includes('<html'));
  }
});

test('card is a separate readonly UI capability, not permission to execute',()=>{
  const reply={result:{tools:[]}};includeApprovalCard(reply,'tools/list');includeApprovalCard(reply,'tools/list');
  assert.deepEqual(reply.result.tools,[approvalCardTool]);
  assert.equal(approvalCardTool._meta.ui.resourceUri,approvalCardUri);
  const init=includeApprovalCard({result:{capabilities:{tools:{},extensions:{other:{}}}}},'initialize');
  assert.deepEqual(init.result.capabilities.extensions['io.modelcontextprotocol/ui'].mimeTypes,['text/html;profile=mcp-app']);
  assert.ok(init.result.capabilities.extensions.other);
  assert.equal(approvalCardResult({id:1,params:{arguments:{}}}).result.structuredContent.execution_authorized,false);
  assert.equal(approvalCardResult({id:1,params:{arguments:{approved:true,command:'must not run'}}}).result.isError,true);
});

test('authenticated UI tools and exact template reads never reach a computer',async()=>{
  let counted=0;
  const env={JAN_PUBLIC_ORIGIN:'https://pcrc-test.example.workers.dev',JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticId',GITHUB_CLIENT_SECRET:'synthetic-private-key',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:id=>id,get:()=>({fetch:async url=>{if(new URL(url).pathname==='/abuse/check')return new Response(null,{status:204});if(new URL(url).pathname==='/account/auth-version')return Response.json({authVersion:0});assert.equal(new URL(url).pathname,'/usage/increment');counted++;return Response.json({});}})}};
  const auth={audience:env.JAN_PUBLIC_ORIGIN+'/mcp',userId:'5678',scope:['jan:read']};
  for(const message of [{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'test_approval_card',arguments:{}}},{jsonrpc:'2.0',id:2,method:'resources/read',params:{uri:approvalCardUri}}]){
    const req=()=>new Request(env.JAN_PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2025-11-25'},body:JSON.stringify(message)});
    assert.equal(controlRequired(new TextEncoder().encode(JSON.stringify(message))),false);
    const response=await proxyMcp(req(),env,auth,{githubId:'5678'},()=>assert.fail('UI probe dispatched to computer'));
    assert.equal(response.status,200);
    const rpc=await response.json();
    if(message.method==='resources/read'){
      assert.equal(rpc.result.contents[0].text,approvalCardHtml);
      assert.deepEqual(rpc.result.contents[0]._meta.ui.csp.connectDomains,[]);
    }else assert.equal(rpc.result.structuredContent.status,'awaiting_ui_test');
    assert.equal((await proxyMcp(req(),env,{...auth,scope:[]},{githubId:'5678'})).status,403);
    assert.equal((await proxyMcp(req(),env,auth,{githubId:'9999'})).status,403);
  }
  assert.equal(counted,1);
  assert.throws(()=>controlRequired(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',method:'resources/read',params:{uri:approvalCardUri+'?token=not-allowed'}}))),/Resource denied/);
});

function widget(){
  const elements=Object.fromEntries(['confirm','cancel','status'].map(id=>[id,{disabled:id!=='status',textContent:''}]));
  const sent=[],timers=new Map();let receive,timer=0;
  const parent={postMessage:message=>sent.push(message)};
  vm.runInNewContext(approvalCardHtml.match(/<script>([\s\S]*?)<\/script>/)[1],{document:{getElementById:id=>elements[id]},crypto:{randomUUID:()=> 'synthetic'},window:{parent,addEventListener:(_name,fn)=>receive=fn},setTimeout:fn=>{timers.set(++timer,fn);return timer;},clearTimeout:id=>timers.delete(id)});
  return {elements,sent,timers,receive:message=>receive({source:parent,data:message}),spoof:message=>receive({source:{},data:message})};
}
test('UI bridge requires host handshake and clicks send diagnostic context only',async()=>{
  for(const decision of ['confirmed','cancelled']){
    const ui=widget(),init=ui.sent[0];
    assert.equal(init.method,'ui/initialize');assert.equal(ui.elements.confirm.disabled,true);
    const response={jsonrpc:'2.0',id:init.id,result:{protocolVersion:'2026-01-26'}};
    ui.spoof(response);await Promise.resolve();assert.equal(ui.elements.confirm.disabled,true);
    ui.receive(response);await Promise.resolve();
    assert.equal(ui.elements.confirm.disabled,false);
    const clicked=ui.elements[decision==='confirmed'?'confirm':'cancel'].onclick();
    const context=ui.sent.at(-1);assert.equal(context.method,'ui/update-model-context');
    assert.equal(JSON.parse(context.params.content[0].text).execution_authorized,false);
    assert.equal(JSON.parse(context.params.content[0].text).pcrc_ui_test,decision);
    ui.receive({jsonrpc:'2.0',id:context.id,result:{}});await clicked;
    assert.match(ui.elements.status.textContent,/No computer action was authorized/);
    assert.equal(ui.elements.confirm.disabled,true);assert.equal(ui.timers.size,0);
    assert.ok(ui.sent.every(message=>!['tools/call','ui/message'].includes(message.method)));
  }
  const missing=widget();for(const fn of missing.timers.values())fn();
  await Promise.resolve();await Promise.resolve();
  assert.equal(missing.elements.confirm.disabled,true);
  assert.match(missing.elements.status.textContent,/No compatible chat UI bridge/);
});
