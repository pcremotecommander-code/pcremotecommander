import {inspectPublicOutput} from '../../../mcp-task-server/src/privacy-guard.ts';
import privacyRules from '../../../../src/jan_mcp_commander/privacy-rules.json' with {type:'json'};
import {authenticatedAccountId} from './account_identity.ts';
import {deviceKey} from './policy.ts';
import {openRecord,sealRecord,type SealedRecord} from './secure_store.ts';

type Env={ALLOWED_GITHUB_ID:string;JAN_PROXY_KEY:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export type MemberMeta={created:number|null;lastLogin:number|null;logins:number[]};
async function linkedEmail(storage:DurableObjectStorage|DurableObjectTransaction,id:string,env:Env,accountId:string){
  const subject=id.startsWith('s-')?id.slice(2):await storage.get<string>('email-link:v1:'+id);
  const username=subject?await storage.get<string>('email-username:v1:'+subject):null;
  const entry=username?await storage.get<{record:SealedRecord}>('email-login:v1:'+username):null;
  return {email:entry?(await openRecord<{email:string}>(env.JAN_PROXY_KEY,accountId,'email-login',entry.record)).email:null,subject:subject??null};
}
const searchKey=(s:string)=>encodeURIComponent(s.normalize('NFKC').toLowerCase());
export async function indexMember(storage:DurableObjectStorage|DurableObjectTransaction,id:string,login:string|boolean,created:number|null,deviceNames?:string[]){
  const old=await storage.get<string[]>('owner:search-keys:'+id)??[];
  const names=deviceNames??await storage.get<string[]>('owner:device-names:'+id)??[];
  if(deviceNames)await storage.put('owner:device-names:'+id,deviceNames);
  const keys=[...new Set([id,typeof login==='string'?login:'',...names].filter(Boolean).map(value=>'owner:search:'+searchKey(value)+':'+id))];
  for(const key of old)if(!keys.includes(key))await storage.delete(key);
  for(const key of keys)await storage.put(key,{id,login});
  await storage.put('owner:search-keys:'+id,keys);
  const recent='owner:recent:'+String(9999999999999-(created??0)).padStart(13,'0')+':'+id;
  const previousRecent=await storage.get<string>('owner:recent-key:'+id);if(previousRecent&&previousRecent!==recent)await storage.delete(previousRecent);
  await storage.put(recent,{id,login});await storage.put('owner:recent-key:'+id,recent);
}

/** Uses the operator's bound DO. Listings and analytics batches never load the whole directory. */
export async function ownerDataStore(path:string,body:any,storage:DurableObjectStorage,env:Env,accountId:string):Promise<Response|null>{
  if(!path.startsWith('/owner-data/'))return null;
  if(accountId!==env.ALLOWED_GITHUB_ID)return json({error:'Owner required'},403);
  if(path==='/owner-data/users'){
    if(typeof body.q!=='string'||body.q.length>100||/[\x00-\x1f]/.test(body.q)||body.after!==undefined&&(typeof body.after!=='string'||body.after.length>500))return json({error:'Invalid search'},400);
    const prefix=body.q?'owner:search:'+searchKey(body.q):'owner:recent:';
    if(body.after&&!body.after.startsWith(prefix))return json({error:'Invalid search cursor'},400);
    let items=await storage.list<{id:string;login:string|boolean}>({prefix,limit:21,...(body.after?{startAfter:body.after}:{})});
    if(!body.q&&!body.after&&!items.size){const legacy=await storage.list<string|boolean>({prefix:'directory:account:',limit:21});for(const [key,login]of legacy){const id=key.slice(18);await indexMember(storage,id,login,null);}items=await storage.list({prefix,limit:21});}
    const unique=new Map<string,{id:string;login:string|boolean}>();for(const item of items.values())if(await storage.get('directory:account:'+item.id)!==undefined&&!await storage.get('directory:deleted:'+item.id))unique.set(item.id,item);
    return json({users:[...unique.values()].slice(0,20),next:items.size>20?[...items.keys()][19]:null,search:!!body.q});
  }
  if(path==='/owner-data/index-device'){
    const id=authenticatedAccountId(body.id);if(!id||typeof body.name!=='string'||!body.name.trim()||body.name.length>64||/[\x00-\x1f]/.test(body.name))return json({error:'Invalid device search entry'},400);
    const login=await storage.get<string|boolean>('directory:account:'+id);if(login===undefined)return json({error:'Account not found'},404);
    const names=[...new Set([...(await storage.get<string[]>('owner:device-names:'+id)??[]),body.name])].slice(-32),meta=await storage.get<MemberMeta>('owner:member:'+id);
    await indexMember(storage,id,login,meta?.created??null,names);return json({ok:true});
  }
  if(path==='/owner-data/meta'){
    if(!authenticatedAccountId(body.id))return json({error:'Invalid account'},400);
    return json(await storage.get<MemberMeta>('owner:member:'+body.id)??{created:null,lastLogin:null,logins:[]});
  }
  if(path==='/owner-data/overview')return json({snapshot:await storage.get('owner:analytics:v1')??null,refreshing:!!await storage.get('owner:analytics-job:v1')});
  if(path==='/owner-data/begin')return storage.transaction(async tx=>{
    let job=await tx.get<any>('owner:analytics-job:v1');
    if(!job||job.expires<Date.now()){job={id:crypto.randomUUID(),after:null,started:Date.now(),expires:Date.now()+120000,totals:{users:0,pro:0,free:0,complimentary:0,signedIn:0,online:0,devices:0,unknownJoined:0},joined:{}};await tx.put('owner:analytics-job:v1',job);}
    return json(job);
  });
  if(path==='/owner-data/batch')return storage.transaction(async tx=>{
    const job=await tx.get<any>('owner:analytics-job:v1');
    if(!job||job.id!==body.id||job.after!==body.after||job.expires<Date.now()||!Array.isArray(body.accounts)||body.accounts.length>25)return json({error:'Refresh changed; retry'},409);
    const directory=await tx.list({prefix:'directory:account:',limit:26,...(job.after?{startAfter:'directory:account:'+job.after}:{})});
    const ids=[...directory.keys()].slice(0,25).map(k=>k.slice(18));
    if(JSON.stringify(ids)!==JSON.stringify(body.accounts.map((a:any)=>a.id)))return json({error:'Refresh batch mismatch'},409);
    for(const a of body.accounts){
      if(!a.status||!['free','pro'].includes(a.status.plan)||!Array.isArray(a.status.devices))return json({error:'Invalid account summary'},400);
      const meta=await tx.get<MemberMeta>('owner:member:'+a.id);
      const login=await tx.get<string|boolean>('directory:account:'+a.id)??true;
      await indexMember(tx,a.id,login,meta?.created??null,a.status.devices.map((d:any)=>String(d.name)));
      job.totals.users++;job.totals[a.status.plan]++;job.totals.devices+=a.status.devices.length;
      if(a.status.complimentary)job.totals.complimentary++;
      if(a.status.activeBrowserSessions>0)job.totals.signedIn++;
      if(a.status.devices.some((d:any)=>d.online===true))job.totals.online++;
      if(meta?.created){const day=new Date(meta.created).toISOString().slice(0,10);job.joined[day]=(job.joined[day]??0)+1;}else job.totals.unknownJoined++;
    }
    job.after=directory.size>25?ids.at(-1):null;job.expires=Date.now()+120000;
    if(job.after)await tx.put('owner:analytics-job:v1',job);else{await tx.put('owner:analytics:v1',{...job,measuredAt:Date.now()});await tx.delete('owner:analytics-job:v1');}
    return json({complete:!job.after,processed:job.totals.users});
  });
  if(path==='/owner-data/email'){
    const id=authenticatedAccountId(body.id);if(!id)return json({error:'Invalid account'},400);
    return json(await linkedEmail(storage,id,env,accountId));
  }
  if(path==='/owner-data/reset-start'){
    const id=authenticatedAccountId(body.id);
    if(!id||typeof body.hash!=='string'||!/^[a-f0-9]{64}$/.test(body.hash)||typeof body.verifier!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(body.verifier))return json({error:'Invalid recovery request'},400);
    return storage.transaction(async tx=>{
      if(await tx.get('directory:account:'+id)===undefined||await tx.get('directory:deleted:'+id))return json({error:'Account unavailable'},410);
      const target=await linkedEmail(tx,id,env,accountId);if(!target.email||!authenticatedAccountId('s-'+target.subject))return json({error:'Email sign-in unavailable'},409);
      const now=Date.now(),previous=await tx.get<number>('owner:reset:'+id)??0;
      if(now-previous<300000)return json({error:'Wait five minutes before another reset'},429);
      const old=await tx.get<{hash:string}>('owner:reset-flow-account:'+id);
      const pending=await tx.list<SealedRecord>({prefix:'owner:reset-flow:',limit:129});let active=0;
      for(const [key,record]of pending)if(record.expires<=now)await tx.delete(key);else if(key!=='owner:reset-flow:'+old?.hash)active++;
      if(active>=128)return json({error:'Recovery capacity reached'},429);
      if(old)await tx.delete('owner:reset-flow:'+old.hash);
      const expires=now+900000;
      await tx.put('owner:reset-flow:'+body.hash,await sealRecord(env.JAN_PROXY_KEY,accountId,'owner-password-reset',{accountId:id,subject:target.subject,email:target.email.toLowerCase(),verifier:body.verifier},expires));
      await tx.put('owner:reset-flow-account:'+id,{hash:body.hash,expires});await tx.put('owner:reset:'+id,now);
      return json({email:target.email});
    });
  }
  if(path==='/owner-data/reset-consume'){
    if(typeof body.hash!=='string'||!/^[a-f0-9]{64}$/.test(body.hash))return json({error:'Recovery denied'},403);
    return storage.transaction(async tx=>{
      const key='owner:reset-flow:'+body.hash,record=await tx.get<SealedRecord>(key);
      if(!record||record.expires<=Date.now()){if(record)await tx.delete(key);return json({error:'Recovery expired or used'},403);}
      const value=await openRecord<{accountId:string;subject:string;email:string;verifier:string}>(env.JAN_PROXY_KEY,accountId,'owner-password-reset',record);
      await tx.delete(key);
      const index=await tx.get<{hash:string}>('owner:reset-flow-account:'+value.accountId);
      if(index?.hash!==body.hash||await tx.get('directory:account:'+value.accountId)===undefined||await tx.get('directory:deleted:'+value.accountId))return json({error:'Recovery changed'},403);
      await tx.delete('owner:reset-flow-account:'+value.accountId);return json(value);
    });
  }
  if(path==='/owner-data/finance/get'||path==='/owner-data/finance/save'||path==='/owner-data/finance/cost'){
    if(typeof body.month!=='string'||!/^20\d{2}-(?:0[1-9]|1[012])$/.test(body.month))return json({error:'Invalid month'},400);
    if(path.endsWith('/save')){if(!body.revenue||body.revenue.month!==body.month||JSON.stringify(body.revenue).length>16000)return json({error:'Invalid finance snapshot'},400);await storage.put('owner:revenue:'+body.month,body.revenue);}
    if(path.endsWith('/cost')){if(typeof body.currency!=='string'||!/^[A-Z]{3}$/.test(body.currency)||!Number.isSafeInteger(body.amount)||body.amount<0)return json({error:'Invalid cost'},400);const costs=await storage.get<Record<string,number>>('owner:costs:'+body.month)??{};costs[body.currency]=body.amount;await storage.put('owner:costs:'+body.month,costs);}
    return json({revenue:await storage.get('owner:revenue:'+body.month)??null,costs:await storage.get('owner:costs:'+body.month)??{}});
  }
  if(path==='/owner-data/support-index'){
    const items=await storage.list({prefix:'owner:ticket:',limit:21,...(body.after?{startAfter:body.after}:{})});
    return json({tickets:[...items.values()].slice(0,20),next:items.size>20?[...items.keys()][19]:null});
  }
  if(path==='/owner-data/support-index-add'){
    if(!authenticatedAccountId(body.accountId)||! /^[a-f0-9-]{36}$/.test(body.id)||!Number.isFinite(body.created))return json({error:'Invalid ticket'},400);
    const key='owner:ticket:'+String(9999999999999-body.created).padStart(13,'0')+':'+body.id;await storage.put(key,{id:body.id,accountId:body.accountId,created:body.created,expires:body.created+365*86400000});await storage.put('owner:account-ticket:'+body.accountId+':'+body.id,{key,expires:body.created+365*86400000});return json({ok:true});
  }
  return json({error:'Unknown owner data operation'},404);
}

export async function removeMemberIndex(tx:DurableObjectTransaction,id:string){
  const reset=await tx.get<{hash:string}>('owner:reset-flow-account:'+id);if(reset)await tx.delete('owner:reset-flow:'+reset.hash);
  await tx.delete('owner:reset-flow-account:'+id);
  for(const key of await tx.get<string[]>('owner:search-keys:'+id)??[])await tx.delete(key);
  const recent=await tx.get<string>('owner:recent-key:'+id);if(recent)await tx.delete(recent);
  for(const suffix of ['search-keys:','recent-key:','device-names:','member:','reset:'])await tx.delete('owner:'+suffix+id);
  const prefix='owner:account-ticket:'+id+':';
  for(let page=0;page<100;page++){
    const tickets=await tx.list<{key:string}>({prefix,limit:25});
    if(!tickets.size)return;
    for(const [key,item]of tickets){await tx.delete(item.key);await tx.delete(key);}
  }
  if((await tx.list({prefix,limit:1})).size)throw Error('Support index cleanup limit reached; run retention before retrying account closure');
}

export const operatorProof=(key:string,path:string,account:string,time:string,raw:string)=>deviceKey(key,'PCRC_OPERATOR_V1\n'+path+'\n'+account+'\n'+time+'\n'+raw);
export async function validOperator(request:Request,env:Env,account:string,raw:string):Promise<boolean>{
  const time=request.headers.get('X-PCRC-Operator-Time')??'',proof=request.headers.get('X-PCRC-Operator-Proof')??'';
  if(!/^\d{13}$/.test(time)||Math.abs(Date.now()-Number(time))>30000||!/^[A-Za-z0-9_-]{43}$/.test(proof))return false;
  const expected=await operatorProof(env.JAN_PROXY_KEY,new URL(request.url).pathname,account,time,raw);let different=0;for(let i=0;i<43;i++)different|=expected.charCodeAt(i)^proof.charCodeAt(i);return !different;
}

export async function supportStore(path:string,body:any,storage:DurableObjectStorage,env:Env,accountId:string):Promise<Response|null>{
  if(!path.startsWith('/support/'))return null;
  const key='support:tickets:v1',tickets=(await storage.get<any[]>(key)??[]).filter(t=>t.record.expires>Date.now());
  if(path==='/support/list')return json({tickets:tickets.map(({record,...t})=>t)});
  if(path==='/support/get'){const ticket=tickets.find(t=>t.id===body.id);return ticket?json({...ticket,record:undefined,...await openRecord<Record<string,unknown>>(env.JAN_PROXY_KEY,accountId,'support-ticket',ticket.record)}):json({error:'Ticket not found'},404);}
  if(path!=='/support/create'&&path!=='/support/reply')return json({error:'Unknown ticket operation'},404);
  try{inspectPublicOutput([{message:body.text,title:body.title??''}],privacyRules);}catch{return json({error:'Remove credentials and private secrets from your message'},400);}
  if(typeof body.text!=='string'||!body.text.trim()||body.text.length>4000||/\b(?:password|api[_ -]?key|access[_ -]?token)\s*[:=]\s*\S{6,}/i.test(body.text))return json({error:'Message is empty, too long or contains a credential. Remove sensitive values.'},400);
  return storage.transaction(async tx=>{
    const now=Date.now(),current=(await tx.get<any[]>(key)??[]).filter(t=>t.record.expires>now);
    if(path==='/support/create'){
      if(current.length>=20||current.filter(t=>t.created>now-86400000).length>=5)return json({error:'Ticket limit reached'},429);
      const id=crypto.randomUUID(),title=String(body.title??'').trim();if(!title||title.length>100)return json({error:'Choose a short subject'},400);
      const ticket={id,title,created:now,updated:now,status:'open',record:await sealRecord(env.JAN_PROXY_KEY,accountId,'support-ticket',{messages:[{author:'user',at:now,text:body.text}]},now+365*86400000)};
      current.push(ticket);await tx.put(key,current);return json({id,created:now});
    }
    const ticket=current.find(t=>t.id===body.id);if(!ticket)return json({error:'Ticket not found'},404);
    const content=await openRecord<{messages:any[]}>(env.JAN_PROXY_KEY,accountId,'support-ticket',ticket.record);
    if(content.messages.length>=40)return json({error:'Thread limit reached'},429);
    content.messages.push({author:body.operator===true?'owner':'user',at:now,text:body.text});ticket.updated=now;ticket.status=body.close===true?'closed':'open';ticket.record=await sealRecord(env.JAN_PROXY_KEY,accountId,'support-ticket',content,now+365*86400000);await tx.put(key,current);return json({ok:true});
  });
}
