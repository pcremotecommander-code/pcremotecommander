type CloseState={started:number};
const DAY=86400000;
export async function deletionState(storage:Pick<DurableObjectStorage,'get'>) {
  return {closing:!!await storage.get('account:closing:v1'),deleted:!!await storage.get('account:deleted:v1')};
}
export async function beginDeletion(storage:DurableObjectStorage,confirmation:unknown):Promise<Response> {
  if(confirmation!=='DELETE')return Response.json({error:'Type DELETE to confirm'},{status:400});
  return storage.transaction(async tx=>{
    if(await tx.get('account:closing:v1'))return Response.json({ok:true});
    const subscriptions=await tx.get<Record<string,{status:string}>>('billing:subscriptions:v1')??{};
    if(Object.values(subscriptions).some(s=>s.status!=='canceled'))return Response.json({error:'Cancel all subscriptions and wait for cancellation to take effect before deleting your account.'},{status:409});
    await tx.put('account:closing:v1',{started:Date.now()} satisfies CloseState);
    await tx.delete('active');await tx.delete('actions:v1');
    return Response.json({ok:true});
  });
}
export async function finishDeletion(storage:DurableObjectStorage):Promise<Response> {
  if(!await storage.get('account:closing:v1')&&!await storage.get('account:deleted:v1'))return Response.json({error:'Deletion not requested'},{status:409});
  // Keep a minimal closure marker so stale OAuth tokens and late billing events cannot recreate the account.
  await storage.put('account:deleted:v1',await storage.get('account:deleted:v1')??{at:Date.now()});
  let remaining=true;
  for(let page=0;page<8;page++) {
    const entries=await storage.list({limit:128});
    const keys=[...entries.keys()].filter(k=>!['account:owner:v1','account:deleted:v1'].includes(k));
    if(keys.length)await storage.delete(keys);
    if(entries.size<128){remaining=false;break;}
  }
  return Response.json({ok:!remaining},{status:remaining?202:200});
}
export async function retainAccountData(storage:DurableObjectStorage,now=Date.now()):Promise<void> {
  const state=await deletionState(storage);
  if(state.deleted){await finishDeletion(storage);return;}
  if(state.closing)return;
  const cursor=await storage.get<string>('retention:cursor:v1');
  const entries=await storage.list<unknown>({limit:200,...(cursor?{startAfter:cursor}:{})});
  for(const [key,value] of entries) {
    if((key.startsWith('owner:reset-flow:')||key.startsWith('owner:reset-flow-account:')||key.startsWith('owner:totp-pending:')||key.startsWith('owner:mfa-session:')||key.startsWith('operator:nonce:')||key.startsWith('owner:ticket:')||key.startsWith('owner:account-ticket:')||key==='github-link:pending:v1'||key.startsWith('session:')&&key!=='session:index:v1'||key.startsWith('oauth:janportal.')||key.startsWith('pair:')||key.startsWith('actions:result:')||key.startsWith('actions:result-part:'))&&
      typeof value==='object'&&value!==null&&'expires' in value&&typeof value.expires==='number'&&value.expires<=now)await storage.delete(key);
  }
  if(entries.size===200)await storage.put('retention:cursor:v1',[...entries.keys()].at(-1)!);
  else await storage.delete('retention:cursor:v1');
  await storage.transaction(async tx=>{
    const tickets=await tx.get<{record:{expires:number}}[]>('support:tickets:v1');if(tickets)await tx.put('support:tickets:v1',tickets.filter(t=>t.record.expires>now));
    for(const key of ['session:index:v1','oauth:pending:v1']) {
      const items=await tx.get<Record<string,{expires:number}>>(key);
      if(items)await tx.put(key,Object.fromEntries(Object.entries(items).filter(([,v])=>v.expires>now)));
    }
    for(const key of ['pairing:v1','relay:nonces']) {
      const items=await tx.get<Record<string,number|{expires:number}>>(key);
      if(items)await tx.put(key,Object.fromEntries(Object.entries(items).filter(([,v])=>typeof v==='number'?v>now:v.expires+600000>now)));
    }
    const actions=await tx.get<{expires:number}[]>('actions:v1');
    if(actions)await tx.put('actions:v1',actions.filter(v=>v.expires>now));
    const activity=await tx.get<{at:number}[]>('activity:recent:v1');
    if(activity)await tx.put('activity:recent:v1',activity.filter(v=>v.at>now-30*DAY).slice(-50));
    const usage=await tx.get<{started:number;days:Record<string,number>}>('usage:daily:v1');
    if(usage){const oldest=new Date(now-186*DAY).toISOString().slice(0,10);usage.days=Object.fromEntries(Object.entries(usage.days).filter(([day])=>day>=oldest));await tx.put('usage:daily:v1',usage);}
    const devices=await tx.get<Record<string,{revoked?:boolean;revokedAt?:number}>>('devices');
    if(devices) {
      for(const [id,device] of Object.entries(devices))if(device.revoked) {
        device.revokedAt??=now;
        if(device.revokedAt<=now-30*DAY)delete devices[id];
      }
      await tx.put('devices',devices);
    }
  });
}
