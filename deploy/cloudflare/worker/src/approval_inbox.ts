import {escaped} from './policy.ts';
import {actionPurpose,requiresActionReview,type PendingAction} from './action_access.ts';

export function approvalInbox(items:PendingAction[],csrf:string):string {
  const rows=items.map(item=>{
    const id=escaped(item.id),args=item.args as Record<string,unknown>|null;
    const targets=args&&typeof args==='object'?['path','source','destination','target','url'].flatMap(key=>typeof args[key]==='string'?[key+': '+String(args[key]).slice(0,512)]:[]):[];
    return '<details class="approval-item" data-approval-item data-access="'+item.access+'"><summary><span><strong>'+escaped(item.name)+'</strong><small>'+escaped(item.deviceName)+' · '+(item.access==='read'?'Read only':'Write / control')+'</small></span><label class="approval-select" aria-label="Select '+escaped(item.name)+'"><input type="checkbox" name="ids" value="'+id+'"> Select</label></summary><div class="approval-body">'+(requiresActionReview(item.name)?'<p class="notice error" role="alert">High-risk or sensitive action. Review the command, targets and private information before approving. This runs once.</p>':'')+'<p>'+escaped(actionPurpose(item.name))+'</p><p><strong>Where:</strong> '+escaped(targets.join(' · ')||'Selected computer; review the exact arguments below.')+'</p><p>Expires: <time datetime="'+new Date(item.expires).toISOString()+'">'+new Date(item.expires).toISOString()+'</time></p><pre>'+escaped(JSON.stringify(item.args,null,2))+'</pre><fieldset><legend>Allow for this request only</legend><label><input type="checkbox" name="read_'+id+'" value="yes" data-allow-read checked> Read</label> <label><input type="checkbox" name="write_'+id+'" value="yes" data-allow-write'+(item.access==='read'?' disabled':'')+'> Write / control</label><input type="hidden" value="read" data-access-value></fieldset>'+(item.access==='write'?'<p class="footnote">Read alone cannot run this action. Write / control also includes read for this exact request.</p>':'')+'</div></details>';
  }).join('');
  return '<p>Review the tool, computer and exact targets. Approvals apply once to selected requests and expire with them. Future writes require new approval.</p>'+(items.length?'<form method="post" action="/devices/approvals" data-approval-form><input type="hidden" name="csrf" value="'+escaped(csrf)+'">'+rows+'<div class="action-row"><button type="button" class="button neutral" data-select-access="read">Select all read requests</button><button type="button" class="button neutral" data-select-access="write">Select all write requests</button></div><p><label><input type="checkbox" name="reviewed" value="yes" required> I reviewed the selected requests and their exact targets.</label></p><div class="action-row"><button class="button primary" name="decision" value="approve">Approve selected once</button><button class="button danger" name="decision" value="deny">Deny selected</button></div><p role="status" data-approval-feedback></p></form>':'<p role="status">No pending requests for your selected computer. Ask your assistant to start a new action if the previous request expired.</p>');
}

export const approvalInboxStyles=`
.approval-dialog{width:min(760px,calc(100% - 24px));max-height:90svh;overflow:auto;background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:16px;padding:24px}.approval-dialog::backdrop{background:#0009}.approval-item{border:1px solid var(--border);border-radius:10px;padding:14px;margin:12px 0}.approval-item summary{display:flex;justify-content:space-between;gap:14px;align-items:center}.approval-item small{display:block;color:var(--muted)}.approval-select{white-space:nowrap}.approval-body pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:240px;overflow:auto;background:var(--bg);padding:12px;border-radius:8px}.approval-body fieldset{border:1px solid var(--border);border-radius:8px}.approval-body input,.approval-item input{width:auto}.approval-item:has(input[name=ids]:checked){border-color:var(--accent)}
`;

export const approvalInboxScript=String.raw`
(()=>{
 const dialog=document.querySelector('[data-approval-dialog]');
 const list=document.querySelector('[data-approval-list]');
 async function refresh(){
  if(!dialog||!list||dialog.open||document.hidden)return;
  try{const response=await fetch('/devices/approvals?format=json',{cache:'no-store',credentials:'same-origin'});if(!response.ok)throw Error();const data=await response.json();list.innerHTML=data.html;document.querySelectorAll('[data-approval-count]').forEach(el=>el.textContent=String(data.count));}
  catch{document.querySelectorAll('[data-approval-count]').forEach(el=>el.textContent='check');}
 }
 document.querySelector('[data-open-approvals]')?.addEventListener('click',async event=>{event.preventDefault();await refresh();dialog.showModal();});
 dialog?.querySelector('[data-close-approvals]').addEventListener('click',()=>dialog.close());
 document.addEventListener('change',event=>{
  const item=event.target.closest('[data-approval-item]');if(!item)return;
  const read=item.querySelector('[data-allow-read]'),write=item.querySelector('[data-allow-write]');
  if(event.target===write&&write.checked)read.checked=true;
  if(event.target===read&&!read.checked)write.checked=false;
  item.querySelector('[data-access-value]').value=write.checked?'write':read.checked?'read':'none';
 });
 document.addEventListener('click',event=>{
  const select=event.target.closest('[data-select-access]');if(!select)return;
  for(const item of select.closest('form').querySelectorAll('[data-approval-item]')){
   if(item.dataset.access!==select.dataset.selectAccess)continue;
   item.querySelector('input[name=ids]').checked=true;item.querySelector('[data-allow-read]').checked=true;
   item.querySelector('[data-allow-write]').checked=item.dataset.access==='write';item.querySelector('[data-access-value]').value=item.dataset.access;
  }
 });
 document.addEventListener('submit',event=>{
  const form=event.target;if(!form.matches('[data-approval-form]'))return;
  const selected=[...form.querySelectorAll('[data-approval-item]')].filter(item=>item.querySelector('input[name=ids]').checked);
  if(!selected.length||!form.querySelector('[name=reviewed]').checked||event.submitter?.value!=='deny'&&selected.some(item=>item.querySelector('[data-access-value]').value==='none'||item.dataset.access==='write'&&item.querySelector('[data-access-value]').value!=='write')){
   event.preventDefault();form.querySelector('[data-approval-feedback]').textContent='Select requests, enable the required access and confirm you reviewed them. Read-only cannot approve writes.';return;
  }
  form.querySelectorAll('button').forEach(button=>{button.setAttribute('aria-disabled','true');});
 });
 if(dialog&&list){refresh();setInterval(refresh,10000);}
})();
`;
