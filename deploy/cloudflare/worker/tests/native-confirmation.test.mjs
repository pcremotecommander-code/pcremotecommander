import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeConfirmationHost,verifiedConfirmationHost,confirmationProps} from '../src/native_confirmation.ts';

test('public native confirmation requires a provider-verified client domain and matching callback',()=>{
  const request={redirectUri:'https://claude.ai/api/mcp/auth_callback',scope:['pcrc:read','pcrc:control']};
  assert.deepEqual(confirmationProps(request,{...request,clientDomain:'claude.ai'}),{confirmationHost:'claude',confirmationVerified:true});
  assert.match(consentPage({...request,clientDomain:'claude.ai',clientName:'Claude'},'synthetic',undefined,true),/handles tool confirmations for this connection/);
  assert.doesNotMatch(consentPage({...request,clientName:'Claude'},'synthetic',undefined,true),/handles tool confirmations for this connection/);
  for(const domain of [undefined,'evil.example','claude.ai.evil.example','chatgpt.com']){
    assert.equal(verifiedConfirmationHost({...request,clientDomain:domain}),null);
    assert.equal(confirmationProps(request,{...request,clientDomain:domain}).confirmationVerified,undefined);
  }
});
import {consentPage} from '../src/authorization.ts';

test('native confirmation is automatic only for a provider-validated host callback and control scope',()=>{
  for(const [redirectUri,host] of [['https://chatgpt.com/connector_platform_oauth_redirect','chatgpt'],['https://chatgpt.com/connector/oauth/synthetic_callback-123','chatgpt'],['https://claude.ai/api/mcp/auth_callback','claude']]){
    const request={redirectUri,scope:['jan:read','jan:control']};
    assert.equal(nativeConfirmationHost(redirectUri),host);
    assert.deepEqual(confirmationProps(request),{confirmationHost:host});
    assert.deepEqual(confirmationProps({...request,scope:['jan:read']}),{});
    const html=consentPage({...request,clientName:'Example',redirectHost:new URL(redirectUri).hostname},'synthetic');
    assert.ok(!html.includes('name="host_confirmation"'));
    assert.ok(!html.includes('type="checkbox"'));
    assert.match(html,/handles tool confirmations for this connection/);
    assert.match(html,/may remember choices or automatically allow calls/);
  }
  for(const redirect of ['http://chatgpt.com/connector_platform_oauth_redirect','https://chatgpt.com.evil.example/connector_platform_oauth_redirect','https://evil.example/chatgpt.com','https://chatgpt.com/anything','https://claude.ai.evil.example/api/mcp/auth_callback','https://claude.ai/api/mcp/auth_callback?next=https://evil.example','https://claude.ai:444/api/mcp/auth_callback','https://user@claude.ai/api/mcp/auth_callback','http://127.0.0.1:6276/callback']){
    assert.equal(nativeConfirmationHost(redirect),null);
    assert.deepEqual(confirmationProps({redirectUri:redirect,scope:['jan:read','jan:control']}),{});
  }
  assert.ok(!consentPage({clientName:'ChatGPT',redirectUri:'https://evil.example/callback',redirectHost:'evil.example',scope:['jan:read','jan:control']},'synthetic').includes('name="host_confirmation"'));
});
