import { authenticatedAccountId, authenticatedGitHubId, permittedAccount } from './account_identity.ts';
import { hasReadScope } from './oauth_scopes.ts';

export const PCRC_GITHUB_IDENTITY_ISSUER = 'urn:pcrc:identity:github-oauth';
export function supabaseAuthIssuerFromUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 256) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port ||
        url.pathname !== '/' || url.search || url.hash ||
        !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname)) return null;
    return url.origin + '/auth/v1';
  } catch {
    return null;
  }
}

export interface PcrcOAuthAuth {
  audience?: unknown;
  scope?: unknown;
  userId?: unknown;
}
export interface PcrcOAuthProps {
  accountId?: unknown;
  githubId?: unknown;
  authVersion?: unknown;
}
export interface PcrcIdentityPolicy {
  resource: string;
  ownerGithubId: string;
  multiUserEnabled?: string;
  betaGithubIds?: string;
  supabaseAuthIssuer?: string;
}
export interface VerifiedPcrcIdentityContext {
  version: 1;
  accountId: string;
  identityIssuer: string;
  identitySubject: string;
  provider: 'github' | 'supabase-email';
  audience: string;
  scopes: string[];
  authVersion: number;
}

function validEmailAccountId(value: unknown): value is string {
  return typeof value === 'string' &&
    /^s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
}

/**
 * Convert the already-validated OAuthResourceContext supplied by the OAuth
 * provider into the stable PCRC account and identity namespaces.
 *
 * This function does not validate a bearer token. Call it only from the
 * Worker callback after OAuthProvider has verified the resource token.
 */
export function createVerifiedIdentityContext(
  auth: PcrcOAuthAuth,
  props: PcrcOAuthProps,
  policy: PcrcIdentityPolicy,
): VerifiedPcrcIdentityContext | null {
  if (!auth || !props || !policy || typeof policy.resource !== 'string' ||
      auth.audience !== policy.resource || !Array.isArray(auth.scope) ||
      auth.scope.some((scope) => typeof scope !== 'string') ||
      !hasReadScope(auth.scope as string[]) ||
      !Number.isSafeInteger(props.authVersion ?? 0) ||
      (props.authVersion ?? 0) as number < 0) return null;

  const identityClaim = props.accountId ?? props.githubId;
  const canonical = authenticatedAccountId(auth.userId, identityClaim);
  const accountId = permittedAccount(
    canonical,
    policy.ownerGithubId,
    policy.multiUserEnabled,
    policy.betaGithubIds,
  );
  if (!accountId) return null;

  const authVersion = (props.authVersion ?? 0) as number;
  if (validEmailAccountId(accountId)) {
    // A linked GitHub login may access this same email-owned account. The
    // callback must carry its verified GitHub user ID separately in props.
    if (props.accountId !== accountId) return null;
    if (props.githubId !== undefined) {
      const githubId = authenticatedGitHubId(props.githubId, props.githubId);
      if (!githubId) return null;
      return {
        version: 1,
        accountId,
        identityIssuer: PCRC_GITHUB_IDENTITY_ISSUER,
        identitySubject: githubId,
        provider: 'github',
        audience: policy.resource,
        scopes: [...auth.scope as string[]],
        authVersion,
      };
    }
    if (!policy.supabaseAuthIssuer ||
        supabaseAuthIssuerFromUrl(policy.supabaseAuthIssuer.replace(/\/auth\/v1$/, '')) !== policy.supabaseAuthIssuer) return null;
    return {
      version: 1,
      accountId,
      identityIssuer: policy.supabaseAuthIssuer,
      identitySubject: accountId.slice(2),
      provider: 'supabase-email',
      audience: policy.resource,
      scopes: [...auth.scope as string[]],
      authVersion,
    };
  }

  const githubId = authenticatedGitHubId(auth.userId, identityClaim);
  if (!githubId || githubId !== accountId) return null;
  if (props.githubId !== undefined && props.githubId !== githubId) return null;
  if (props.accountId !== undefined && props.accountId !== githubId) return null;

  return {
    version: 1,
    accountId,
    identityIssuer: PCRC_GITHUB_IDENTITY_ISSUER,
    identitySubject: githubId,
    provider: 'github',
    audience: policy.resource,
    scopes: [...auth.scope as string[]],
    authVersion,
  };
}

export interface PcrcIdentityStoreBinding {
  fetch(request: Request): Promise<Response>;
}
export interface ResolvedPcrcIdentity {
  accountId: string;
  accountVersion: number;
  provider: VerifiedPcrcIdentityContext['provider'];
}

function identityStoreError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

async function readBoundedJson(response: Response, maxBytes = 4096): Promise<unknown> {
  if (!response.body) throw identityStoreError('IDENTITY_STORE_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw identityStoreError('IDENTITY_STORE_RESPONSE_INVALID');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw identityStoreError('IDENTITY_STORE_RESPONSE_INVALID');
  }
}

/**
 * Resolve identity through a private Cloudflare Service Binding. No bearer
 * token, cookie, publishable key, or service-role credential crosses this
 * boundary. The service must independently validate the caller binding and
 * invoke the private PostgreSQL resolver with a server-side DB credential.
 */
export async function resolveSharedPcrcIdentity(
  binding: PcrcIdentityStoreBinding,
  identity: VerifiedPcrcIdentityContext,
): Promise<ResolvedPcrcIdentity | null> {
  if (!binding || typeof binding.fetch !== 'function' || !identity ||
      identity.version !== 1 || !identity.accountId ||
      !identity.identityIssuer || !identity.identitySubject) {
    throw identityStoreError('IDENTITY_STORE_UNAVAILABLE');
  }

  let response: Response;
  try {
    response = await binding.fetch(new Request(
      'https://pcrc-identity.internal/v1/identity/resolve',
      {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Cache-Control': 'no-store',
          'X-PCRC-Identity-Version': '1',
        },
        body: JSON.stringify(identity),
        signal: AbortSignal.timeout(5000),
      },
    ));
  } catch {
    throw identityStoreError('IDENTITY_STORE_UNAVAILABLE');
  }

  if (response.status === 404) return null;
  if (response.status >= 300 && response.status < 400) {
    throw identityStoreError('IDENTITY_STORE_REDIRECT');
  }
  if (!response.ok) throw identityStoreError('IDENTITY_STORE_UNAVAILABLE');
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw identityStoreError('IDENTITY_STORE_RESPONSE_INVALID');
  }

  const value = await readBoundedJson(response) as Record<string, unknown>;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.status !== 'active' ||
      value.accountId !== identity.accountId ||
      value.identityIssuer !== identity.identityIssuer ||
      value.identitySubject !== identity.identitySubject ||
      !Number.isSafeInteger(value.accountVersion) ||
      (value.accountVersion as number) < 1) {
    return null;
  }

  return {
    accountId: value.accountId as string,
    accountVersion: value.accountVersion as number,
    provider: identity.provider,
  };
}
