import type {AuthRequest} from '@cloudflare/workers-oauth-provider';
import {hasControlScope} from './oauth_scopes.ts';
export type ConfirmationHost='chatgpt'|'claude';
export function requiresWebsiteApproval(env:{JAN_SITE_ROLE?:string;JAN_MULTI_USER_ENABLED?:string}):boolean {
  return env.JAN_SITE_ROLE==='public'||env.JAN_MULTI_USER_ENABLED==='1';
}
/** Only provider-validated OAuth callback URIs identify an eligible host, never a client name. */
export function nativeConfirmationHost(redirect:string):ConfirmationHost|null {
  try {
    const url=new URL(redirect);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)return null;
    if(url.hostname==='chatgpt.com'&&(url.pathname==='/connector_platform_oauth_redirect'||/^\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname)))return 'chatgpt';
    if(url.hostname==='claude.ai'&&url.pathname==='/api/mcp/auth_callback')return 'claude';
  }catch{}
  return null;
}
export function verifiedConfirmationHost(details:{redirectUri:string;clientDomain?:string}):ConfirmationHost|null {
  const host=nativeConfirmationHost(details.redirectUri);
  return host&&details.clientDomain===(host==='chatgpt'?'chatgpt.com':'claude.ai')?host:null;
}
export function confirmationProps(request:AuthRequest,details?:{redirectUri:string;clientDomain?:string}):{confirmationHost?:ConfirmationHost;confirmationVerified?:true} {
  const host=nativeConfirmationHost(request.redirectUri);
  return host&&hasControlScope(request.scope)?{confirmationHost:host,...(details&&details.redirectUri===request.redirectUri&&verifiedConfirmationHost(details)===host?{confirmationVerified:true as const}:{})}:{};
}
