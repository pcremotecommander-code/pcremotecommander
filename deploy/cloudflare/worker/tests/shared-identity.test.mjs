import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedIdentityContext, resolveSharedPcrcIdentity, supabaseAuthIssuerFromUrl } from '../src/shared_identity.ts';

const policy = {
  resource: 'https://pcrc.example.workers.dev/mcp',
  ownerGithubId: '1234',
  multiUserEnabled: '1',
  supabaseAuthIssuer: 'https://rttnxuyzeicqjqebxlab.supabase.co/auth/v1',
};
const github = {
  auth: { userId: '5678', audience: policy.resource, scope: ['pcrc:read', 'pcrc:control'] },
  props: { accountId: '5678', authVersion: 4 },
};
const email = {
  auth: { userId: 's-123e4567-e89b-42d3-a456-426614174000', audience: policy.resource, scope: ['jan:read'] },
  props: { accountId: 's-123e4567-e89b-42d3-a456-426614174000', authVersion: 0 },
};

test('maps trusted GitHub OAuth context to the existing canonical account namespace', () => {
  const context = createVerifiedIdentityContext(github.auth, github.props, policy);
  assert.deepEqual(context, {
    version: 1,
    accountId: '5678',
    identityIssuer: 'urn:pcrc:identity:github-oauth',
    identitySubject: '5678',
    provider: 'github',
    audience: policy.resource,
    scopes: ['pcrc:read', 'pcrc:control'],
    authVersion: 4,
  });
});

test('maps a verified linked GitHub identity to the existing email-owned account partition', () => {
  const context = createVerifiedIdentityContext(email.auth, {
    ...email.props, githubId: '5678',
  }, policy);
  assert.equal(context.accountId, email.auth.userId);
  assert.equal(context.identityIssuer, 'urn:pcrc:identity:github-oauth');
  assert.equal(context.identitySubject, '5678');
  assert.equal(context.provider, 'github');
});

test('maps verified Supabase Auth email identity without changing the s-UUID account ID', () => {
  const context = createVerifiedIdentityContext(email.auth, email.props, policy);
  assert.equal(context.accountId, email.auth.userId);
  assert.equal(context.identityIssuer, policy.supabaseAuthIssuer);
  assert.equal(context.identitySubject, '123e4567-e89b-42d3-a456-426614174000');
  assert.equal(context.provider, 'supabase-email');
  assert.equal(context.authVersion, 0);
});

test('Supabase issuer is bound to one canonical project URL', () => {
  assert.equal(supabaseAuthIssuerFromUrl('https://rttnxuyzeicqjqebxlab.supabase.co'), policy.supabaseAuthIssuer);
  for (const value of [
    'http://rttnxuyzeicqjqebxlab.supabase.co',
    'https://evil.example',
    'https://rttnxuyzeicqjqebxlab.supabase.co.attacker.example',
    'https://user@rttnxuyzeicqjqebxlab.supabase.co',
    'https://rttnxuyzeicqjqebxlab.supabase.co:8443',
    'https://rttnxuyzeicqjqebxlab.supabase.co/path',
  ]) assert.equal(supabaseAuthIssuerFromUrl(value), null);
});

test('accepts legacy jan:read scope while preserving the original token scope list', () => {
  const context = createVerifiedIdentityContext(email.auth, email.props, policy);
  assert.deepEqual(context.scopes, ['jan:read']);
});

test('rejects mismatched audience, account claim, and missing read scope', () => {
  assert.equal(createVerifiedIdentityContext({ ...github.auth, audience: 'https://attacker.example/mcp' }, github.props, policy), null);
  assert.equal(createVerifiedIdentityContext(github.auth, { ...github.props, accountId: '9999' }, policy), null);
  assert.equal(createVerifiedIdentityContext({ ...github.auth, scope: ['pcrc:control'] }, github.props, policy), null);
});

test('rejects non-canonical email IDs and auth-version values', () => {
  assert.equal(createVerifiedIdentityContext(
    { ...email.auth, userId: 's-123e4567-e89b-12d3-a456-426614174000' },
    { accountId: 's-123e4567-e89b-12d3-a456-426614174000' }, policy), null);
  assert.equal(createVerifiedIdentityContext(github.auth, { ...github.props, authVersion: -1 }, policy), null);
  assert.equal(createVerifiedIdentityContext(github.auth, { ...github.props, authVersion: 1.2 }, policy), null);
});

test('preserves current beta-account allowlist policy', () => {
  assert.equal(createVerifiedIdentityContext(github.auth, github.props, {
    ...policy, betaGithubIds: '1234,9999',
  }), null);
  assert.equal(createVerifiedIdentityContext({
    ...github.auth, userId: '1234',
  }, { accountId: '1234', authVersion: 0 }, {
    ...policy, betaGithubIds: '1234,9999',
  }).accountId, '1234');
});

test('private identity binding receives only the normalized context and validates the mapping response', async () => {
  const context = createVerifiedIdentityContext(github.auth, github.props, policy);
  let captured;
  const binding = {
    async fetch(request) {
      captured = request;
      return Response.json({
        accountId: '5678',
        identityIssuer: context.identityIssuer,
        identitySubject: context.identitySubject,
        status: 'active',
        accountVersion: 1,
      });
    },
  };
  const result = await resolveSharedPcrcIdentity(binding, context);
  assert.deepEqual(result, { accountId: '5678', accountVersion: 1, provider: 'github' });
  assert.equal(captured.url, 'https://pcrc-identity.internal/v1/identity/resolve');
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.get('authorization'), null);
  assert.equal(captured.headers.get('cookie'), null);
  assert.equal(captured.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await captured.json(), context);
});

test('missing database identity mapping fails closed', async () => {
  const context = createVerifiedIdentityContext(github.auth, github.props, policy);
  const result = await resolveSharedPcrcIdentity({ fetch: async () => new Response(null, { status: 404 }) }, context);
  assert.equal(result, null);
});

test('database cannot switch the established account partition or identity subject', async () => {
  const context = createVerifiedIdentityContext(github.auth, github.props, policy);
  const changedAccount = await resolveSharedPcrcIdentity({
    fetch: async () => Response.json({
      accountId: '9999', identityIssuer: context.identityIssuer,
      identitySubject: context.identitySubject, status: 'active', accountVersion: 1,
    }),
  }, context);
  assert.equal(changedAccount, null);

  const changedSubject = await resolveSharedPcrcIdentity({
    fetch: async () => Response.json({
      accountId: '5678', identityIssuer: context.identityIssuer,
      identitySubject: '9999', status: 'active', accountVersion: 1,
    }),
  }, context);
  assert.equal(changedSubject, null);
});

test('identity resolver rejects redirects, oversized responses and unavailable service', async () => {
  const context = createVerifiedIdentityContext(github.auth, github.props, policy);
  await assert.rejects(
    resolveSharedPcrcIdentity({ fetch: async () => new Response(null, { status: 302, headers: { Location: 'https://outside.example' } }) }, context),
    { code: 'IDENTITY_STORE_REDIRECT' },
  );
  await assert.rejects(
    resolveSharedPcrcIdentity({ fetch: async () => new Response('x'.repeat(5000), { headers: { 'Content-Type': 'application/json' } }) }, context),
    { code: 'IDENTITY_STORE_RESPONSE_INVALID' },
  );
  await assert.rejects(
    resolveSharedPcrcIdentity({ fetch: async () => new Response(null, { status: 503 }) }, context),
    { code: 'IDENTITY_STORE_UNAVAILABLE' },
  );
});

test('untrusted caller data cannot use this adapter to select arbitrary account IDs', () => {
  assert.equal(createVerifiedIdentityContext({
    ...github.auth, userId: '9999',
  }, { accountId: '5678' }, policy), null);
  assert.equal(createVerifiedIdentityContext({
    ...github.auth, userId: '5678',
  }, { accountId: '5678', githubId: '9999' }, policy), null);
});

const workerEnv = {
  JAN_PUBLIC_ORIGIN: 'https://pcrc.example.workers.dev',
  JAN_ORIGIN: 'https://local-agent.trycloudflare.com',
  JAN_PROXY_KEY: 'Z'.repeat(43),
  GITHUB_CLIENT_ID: 'syntheticClientId',
  GITHUB_CLIENT_SECRET: 'synthetic-secret-for-tests',
  ALLOWED_GITHUB_ID: '1234',
  SUPABASE_URL: 'https://rttnxuyzeicqjqebxlab.supabase.co',
  PCRC_SHARED_IDENTITY_ENABLED: '1',
};
const workerAuth = {
  userId: '1234', audience: workerEnv.JAN_PUBLIC_ORIGIN + '/mcp', scope: ['pcrc:read'],
};
const workerProps = { githubId: '1234', authVersion: 0 };
const mcpRequest = () => new Request(workerEnv.JAN_PUBLIC_ORIGIN + '/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
});

test('Worker proxy consults the private identity binding before routing when explicitly enabled', async () => {
  const { proxyMcp } = await import('../src/policy.ts');
  let resolved = 0;
  let routed = 0;
  const identityStore = {
    async fetch(request) {
      resolved += 1;
      const submitted = await request.json();
      assert.equal(submitted.accountId, '1234');
      assert.equal(submitted.identityIssuer, 'urn:pcrc:identity:github-oauth');
      assert.equal(submitted.identitySubject, '1234');
      return Response.json({
        accountId: '1234', identityIssuer: submitted.identityIssuer,
        identitySubject: submitted.identitySubject, status: 'active', accountVersion: 1,
      });
    },
  };
  const response = await proxyMcp(mcpRequest(), {
    ...workerEnv, PCRC_IDENTITY_STORE: identityStore,
  }, workerAuth, workerProps, async (url) => {
    routed += 1;
    assert.equal(url, workerEnv.JAN_ORIGIN + '/mcp');
    return Response.json({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
  });
  assert.equal(response.status, 200);
  assert.equal(resolved, 1);
  assert.equal(routed, 1);
});

test('Worker proxy fails closed if the private database has no verified identity mapping', async () => {
  const { proxyMcp } = await import('../src/policy.ts');
  let routed = 0;
  const response = await proxyMcp(mcpRequest(), {
    ...workerEnv, PCRC_IDENTITY_STORE: { fetch: async () => new Response(null, { status: 404 }) },
  }, workerAuth, workerProps, async () => {
    routed += 1;
    return Response.json({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
  });
  assert.equal(response.status, 403);
  assert.equal(routed, 0);
});

test('Worker proxy fails closed on shared identity service outage', async () => {
  const { proxyMcp } = await import('../src/policy.ts');
  let routed = 0;
  const response = await proxyMcp(mcpRequest(), {
    ...workerEnv, PCRC_IDENTITY_STORE: { fetch: async () => { throw new Error('synthetic unavailable'); } },
  }, workerAuth, workerProps, async () => {
    routed += 1;
    return Response.json({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
  });
  assert.equal(response.status, 503);
  assert.equal(routed, 0);
});

test('shared identity gate remains disabled unless the explicit staging flag is set', async () => {
  const { proxyMcp } = await import('../src/policy.ts');
  let identityCalls = 0;
  let routed = 0;
  const response = await proxyMcp(mcpRequest(), {
    ...workerEnv, PCRC_SHARED_IDENTITY_ENABLED: undefined,
    PCRC_IDENTITY_STORE: { fetch: async () => { identityCalls += 1; return new Response(null, { status: 404 }); } },
  }, workerAuth, workerProps, async () => {
    routed += 1;
    return Response.json({ jsonrpc: '2.0', id: 7, result: { tools: [] } });
  });
  assert.equal(response.status, 200);
  assert.equal(identityCalls, 0);
  assert.equal(routed, 1);
});
