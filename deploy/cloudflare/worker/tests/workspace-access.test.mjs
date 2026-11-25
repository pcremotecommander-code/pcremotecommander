import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWorkspacePath,validWorkspaceGrant,workspaceGrantAllows,appendWorkspaceAudit} from '../src/workspace_access.ts';

const now=Date.now();
const grant={id:'11111111-1111-4111-8111-111111111111',accountId:'1234',repository:'acme/pcrc',branch:'feature/admin',path:'src/worker',access:'read',approvedBy:'1234',approvedAt:now-1000,expiresAt:now+60000};

test('workspace paths reject traversal, absolute paths and ambiguous segments',()=>{
 for(const path of ['../secrets','.','src/../secrets','/etc/passwd','C:\\secrets','src//worker',''])assert.equal(normalizeWorkspacePath(path),null,path);
 assert.equal(normalizeWorkspacePath('src/worker/file.ts'),'src/worker/file.ts');
});

test('workspace grants are bound to account, repository, branch, path boundary and exact access',()=>{
 assert.equal(validWorkspaceGrant(grant,now),true);
 const base={accountId:'1234',repository:'acme/pcrc',branch:'feature/admin',path:'src/worker/index.ts',access:'read'};
 assert.equal(workspaceGrantAllows(grant,base,now),true);
 assert.equal(workspaceGrantAllows(grant,{...base,path:'src/workers/index.ts'},now),false);
 assert.equal(workspaceGrantAllows(grant,{...base,branch:'main'},now),false);
 assert.equal(workspaceGrantAllows(grant,{...base,accountId:'5678'},now),false);
 assert.equal(workspaceGrantAllows(grant,{...base,access:'edit'},now),false,'read approval never authorizes edits');
});

test('expired and overlong grants fail closed',()=>{
 assert.equal(validWorkspaceGrant({...grant,expiresAt:now},now),false);
 assert.equal(validWorkspaceGrant({...grant,expiresAt:now+31*86400000},now),false);
 assert.equal(workspaceGrantAllows({...grant,expiresAt:now-1},{accountId:'1234',repository:'acme/pcrc',branch:'feature/admin',path:'src/worker/a.ts',access:'read'},now),false);
});

test('audit records remain bounded and reject future-dated entries',()=>{
 const rows=appendWorkspaceAudit([{at:now-2},{at:now-1}],{at:now},now,2);
 assert.deepEqual(rows,[{at:now-1},{at:now}]);
 assert.deepEqual(appendWorkspaceAudit([],{at:now+120000},now),[]);
});
