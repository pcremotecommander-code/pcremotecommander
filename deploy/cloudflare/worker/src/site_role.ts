export function siteRouteAllowed(role:'public'|'owner'|undefined,path:string,portalCallback=false):boolean {
  if(role==='public')return !['/admin','/admin/subscriptions','/admin/prompts','/admin/accounts','/owner/login','/owner/logout'].includes(path);
  if(role==='owner')return ['/', '/admin','/admin/subscriptions','/admin/prompts','/admin/accounts','/owner/login','/owner/logout'].includes(path)||path==='/callback'&&portalCallback;
  return true;
}
