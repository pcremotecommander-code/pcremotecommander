import test from 'node:test';
import assert from 'node:assert/strict';
import {PUBLIC_SCOPES,hasReadScope,hasControlScope,displayScopes} from '../src/oauth_scopes.ts';
import {consentPage} from '../src/authorization.ts';
import {confirmationProps} from '../src/native_confirmation.ts';

test('PCRC scopes and existing grants have identical permissions without advertising old names',()=>{
  assert.deepEqual(PUBLIC_SCOPES,['pcrc:read','pcrc:control']);
  for(const prefix of ['pcrc','jan']){
    assert.equal(hasReadScope([prefix+':read']),true);
    assert.equal(hasControlScope([prefix+':read']),false);
    assert.equal(hasControlScope([prefix+':control']),true);
    assert.deepEqual(confirmationProps({redirectUri:'https://claude.ai/api/mcp/auth_callback',scope:[prefix+':read',prefix+':control']}),{confirmationHost:'claude'});
    const page=consentPage({clientName:'Example',redirectHost:'client.example',scope:[prefix+':read',prefix+':control']},'synthetic');
    assert.ok(page.includes('pcrc:read')&&page.includes('pcrc:control'));
    assert.ok(!page.includes('jan:'));
  }
  for(const scopes of [undefined,[],['pcrc:write'],['pcrc:read:all']]) assert.equal(hasControlScope(scopes),false);
  assert.equal(hasReadScope([]),false);
  assert.deepEqual(displayScopes(['jan:read','pcrc:read','jan:control']),PUBLIC_SCOPES);
});
