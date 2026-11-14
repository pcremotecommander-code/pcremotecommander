import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalPreview,includeApprovalPreview} from '../src/approval_preview.ts';
import {proxyMcp,controlRequired} from '../src/policy.ts';

const meta={'io.modelcontextprotocol/protocolVersion':'2026-07-28','io.modelcontextprotocol/clientCapabilities':{elicitation:{form:{}}}};
const call=(params={})=>({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'test_approval_dialog',arguments:{},_meta:meta,...params}});

test('native dialog probe negotiates form support and never requests permission to execute',()=>{
  const form=approvalPreview(call()).result;
  assert.equal(form.resultType,'input_required');
  assert.equal(form.inputRequests.pcrc_dialog_preview.params.mode,'form');
  assert.equal(form.inputRequests.pcrc_dialog_preview.params.requestedSchema.properties.test_dialog.default,false);
  for(const action of ['accept','decline','cancel']){
    const result=approvalPreview(call({requestState:form.requestState,inputResponses:{pcrc_dialog_preview:{action,content:{test_dialog:true}}}})).result;
    assert.equal(result.structuredContent.decision,action==='accept'?'accepted':action);
    assert.equal(result.structuredContent.execution_authorized,false);
  }
  for(const _meta of [{},{...meta,'io.modelcontextprotocol/clientCapabilities':{}},{...meta,'io.modelcontextprotocol/clientCapabilities':{elicitation:{url:{}}}}]){
    const result=approvalPreview(call({_meta})).result;
    assert.equal(result.structuredContent.supported,false);
    assert.equal(result.structuredContent.execution_authorized,false);
    assert.ok(!result.inputRequests);
  }
  assert.equal(approvalPreview(call({arguments:{command:'echo must-not-run',confirmed:true}})).result.structuredContent.decision,'invalid');
  assert.ok(approvalPreview(call({requestState:form.requestState,inputResponses:{pcrc_dialog_preview:{action:'accept',content:{test_dialog:false}}}})).result.inputRequests);
  assert.ok(approvalPreview(call({requestState:'forged',inputResponses:{pcrc_dialog_preview:{action:'accept',content:{test_dialog:true}}}})).result.inputRequests);
});

test('probe discovery is idempotent and preserves the existing device tool catalogue',()=>{
  const reply={jsonrpc:'2.0',id:1,result:{tools:[{name:'get_connection_status'}]}};
  includeApprovalPreview(reply);includeApprovalPreview(reply);
  assert.deepEqual(reply.result.tools.map(t=>t.name),['get_connection_status','test_approval_dialog','get_action_result']);
  assert.equal(reply.result.tools[1].annotations.readOnlyHint,true);
  assert.deepEqual(includeApprovalPreview({error:{code:-1}}),{error:{code:-1}});
});

test('authenticated preview stays in gateway, counts usage, and cannot reach the computer',async()=>{
  let counted=0;
  const env={JAN_PUBLIC_ORIGIN:'https://pcrc-test.example.workers.dev',JAN_ORIGIN:'https://unused.trycloudflare.com',JAN_PROXY_KEY:'A'.repeat(43),GITHUB_CLIENT_ID:'syntheticId',GITHUB_CLIENT_SECRET:'synthetic-private-key',ALLOWED_GITHUB_ID:'1234',JAN_SITE_ROLE:'public',JAN_MULTI_USER_ENABLED:'1',JAN_RELAY_ENABLED:'1',DEVICES:{idFromName:id=>id,get:()=>({fetch:async url=>{if(new URL(url).pathname==='/abuse/check')return new Response(null,{status:204});if(new URL(url).pathname==='/account/auth-version')return Response.json({authVersion:0});assert.equal(new URL(url).pathname,'/usage/increment');counted++;return Response.json({});}})}};
  const request=()=>new Request(env.JAN_PUBLIC_ORIGIN+'/mcp',{method:'POST',headers:{'Content-Type':'application/json','MCP-Protocol-Version':'2026-07-28','MCP-Method':'tools/call','MCP-Name':'test_approval_dialog'},body:JSON.stringify(call())});
  const auth={audience:env.JAN_PUBLIC_ORIGIN+'/mcp',userId:'5678',scope:['jan:read']};
  const never=()=>assert.fail('Preview reached an upstream computer');
  assert.equal(controlRequired(new TextEncoder().encode(JSON.stringify(call()))),false);
  const response=await proxyMcp(request(),env,auth,{githubId:'5678'},never);
  assert.equal(response.status,200);assert.equal(counted,1);
  assert.equal((await response.json()).result.resultType,'input_required');
  assert.equal((await proxyMcp(request(),env,{...auth,scope:[]},{githubId:'5678'},never)).status,403);
  assert.equal((await proxyMcp(request(),env,auth,{githubId:'9999'},never)).status,403);
  assert.equal(counted,1);
});
