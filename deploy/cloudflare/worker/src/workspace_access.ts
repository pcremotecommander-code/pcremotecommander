export type WorkspaceAccess='read'|'edit';
export type WorkspaceScope={repository:string;branch:string;path:string};
export type WorkspaceGrant=WorkspaceScope&{id:string;accountId:string;access:WorkspaceAccess;approvedBy:string;approvedAt:number;expiresAt:number};
const repositoryPattern=/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const branchPattern=/^(?!\/)(?!.*\\.\\.)(?!.*\\.lock$)(?!.*\\/\\/)(?!.*\\/@\\{)(?!.*\\/$)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export function normalizeWorkspacePath(value:unknown):string|null {
 if(typeof value!=='string'||value.length===0||value.length>1024||/[\u0000-\u001f\u007f]/.test(value))return null;
 const path=value.replace(/\\/g,'/');
 if(path.startsWith('/')||/^[A-Za-z]:/.test(path)||path.startsWith('//'))return null;
 const parts=path.split('/');
 if(parts.some(part=>!part||part==='.'||part==='..'))return null;
 return parts.join('/');
}

export function validWorkspaceScope(value:unknown):value is WorkspaceScope {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const scope=value as Record<string,unknown>;
 return typeof scope.repository==='string'&&repositoryPattern.test(scope.repository)&&
  typeof scope.branch==='string'&&branchPattern.test(scope.branch)&&
  normalizeWorkspacePath(scope.path)!==null;
}

export function validWorkspaceGrant(value:unknown,now=Date.now()):value is WorkspaceGrant {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const grant=value as Record<string,unknown>;
 return typeof grant.id==='string'&&/^[a-f0-9-]{36}$/.test(grant.id)&&
  typeof grant.accountId==='string'&&/^\d{1,20}$/.test(grant.accountId)&&
  validWorkspaceScope(grant)&&
  (grant.access==='read'||grant.access==='edit')&&
  typeof grant.approvedBy==='string'&&/^\d{1,20}$/.test(grant.approvedBy)&&
  typeof grant.approvedAt==='number'&&Number.isSafeInteger(grant.approvedAt)&&
  typeof grant.expiresAt==='number'&&Number.isSafeInteger(grant.expiresAt)&&
  grant.expiresAt>now&&grant.expiresAt>grant.approvedAt&&
  grant.expiresAt-grant.approvedAt<=30*86400000;
}

export function workspaceGrantAllows(grant:unknown,request:{accountId:string;repository:string;branch:string;path:string;access:WorkspaceAccess},now=Date.now()):boolean {
 if(!validWorkspaceGrant(grant,now)||!request||typeof request!=='object')return false;
 const path=normalizeWorkspacePath(request.path),scopePath=normalizeWorkspacePath(grant.path);
 if(!path||!scopePath||grant.accountId!==request.accountId||grant.repository!==request.repository||grant.branch!==request.branch||grant.access!==request.access)return false;
 return path===scopePath||path.startsWith(scopePath+'/');
}

export function appendWorkspaceAudit<T extends {at:number}>(entries:T[],entry:T,now=Date.now(),limit=500):T[] {
 if(!Array.isArray(entries)||!Number.isInteger(limit)||limit<1||limit>5000||!entry||!Number.isSafeInteger(entry.at)||entry.at>now+60000)return [];
 return [...entries,entry].slice(-limit);
}
