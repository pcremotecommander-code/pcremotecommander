export function siteRouteAllowed(role:'public'|'owner'|undefined,path:string,portalCallback=false):boolean {
  if(role==='public')return !(path==='/admin'||path.startsWith('/admin/')||path==='/owner'||path.startsWith('/owner/'));
  if(role==='owner')return ['/', '/admin','/admin/subscriptions','/admin/prompts','/admin/accounts','/admin/users','/admin/users/action','/admin/support','/admin/security','/admin/security/setup','/admin/security/verify','/admin/analytics/refresh','/admin/revenue/refresh','/admin/revenue/cost','/owner/login','/owner/logout'].includes(path)||path==='/callback'&&portalCallback;
  return true;
}
