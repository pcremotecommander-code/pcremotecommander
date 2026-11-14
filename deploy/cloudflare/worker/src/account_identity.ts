/** A provider identity is usable for routing only when both OAuth claims agree. */
export function authenticatedGitHubId(authUserId: unknown, githubId: unknown): string | null {
  if (typeof authUserId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(authUserId) ||
      typeof githubId !== 'string' || githubId !== authUserId) return null;
  const numeric = Number(authUserId);
  return Number.isSafeInteger(numeric) && String(numeric) === authUserId ? authUserId : null;
}

/** Email identities have a separate namespace; never reinterpret one as a GitHub user ID. */
export const EMAIL_USERNAME_PATTERN='[a-z0-9]{3,12}';
export const validEmailUsername=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9]{3,12}$/.test(value);

export function authenticatedAccountId(value:unknown,claim:unknown=value):string|null {
  if(value!==claim)return null;
  return authenticatedGitHubId(value,claim)??(typeof value==='string'&&/^s-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)?value:null);
}

export function validBetaIds(value: unknown, ownerId: string): boolean {
  if(typeof value!=='string'||!value||value.length>220)return false;
  const ids=value.split(',');
  return ids.length>=2&&ids.length<=10&&new Set(ids).size===ids.length&&ids.includes(ownerId)&&
    ids.every(id=>authenticatedGitHubId(id,id)===id);
}

export function permittedAccount(accountId: unknown, ownerId: string, multiUserEnabled?: string, betaIds?: string): string | null {
  const canonical = authenticatedAccountId(accountId);
  return canonical && (multiUserEnabled === '1' && (betaIds===undefined || validBetaIds(betaIds,ownerId) && betaIds.split(',').includes(canonical)) || canonical === ownerId) ? canonical : null;
}

/** Routing hint only. The destination object still verifies the device signature. */
export function accountFromDeviceProof(raw: string | null, ownerId: string, multiUserEnabled?: string, betaIds?: string): string | null {
  if(!raw||raw.length>1024)return null;
  try {return permittedAccount((JSON.parse(raw) as {owner_id?:unknown}).owner_id,ownerId,multiUserEnabled,betaIds);} catch {return null;}
}
