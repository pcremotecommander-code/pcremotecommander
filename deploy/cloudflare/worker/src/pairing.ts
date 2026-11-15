import {authenticatedAccountId} from './account_identity.ts';
/** Device authorization v1. Display codes identify a transaction; they never authorize it. */
export const PAIR_TTL=300000;
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const encoder=new TextEncoder();
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export const randomToken=()=>btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function displayCode() {
  let n:number;
  do {n=crypto.getRandomValues(new Uint32Array(1))[0];} while(n>=4294000000);
  const code=String(n%1000000).padStart(6,'0');
  return code.slice(0,3)+' '+code.slice(3);
}
export function decode64(value:string) {return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
export async function publicKey(value:string) {
  if(!/^[A-Za-z0-9_-]{120,128}$/.test(value)) throw Error('Invalid public key');
  const bytes=decode64(value);
  if(btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')!==value)throw Error('Noncanonical public key');
  const key=await crypto.subtle.importKey('spki',bytes,{name:'ECDSA',namedCurve:'P-256'},true,['verify']);
  const canonical=new Uint8Array(await crypto.subtle.exportKey('spki',key) as ArrayBuffer);
  if(canonical.length!==bytes.length||canonical.some((byte,i)=>byte!==bytes[i]))throw Error('Noncanonical public key encoding');
  return key;
}
export async function verifySignature(key:string,signature:unknown,payload:string) {
  try {
    if(typeof signature!=='string'||! /^[A-Za-z0-9_-]{86}$/.test(signature)) return false;
    return await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'},await publicKey(key),decode64(signature),encoder.encode(payload));
  } catch {return false;}
}
export function pairingProof(origin:string,id:string,action:string,challenge:string,nonce:string,timestamp:number) {
  return ['JAN_PAIR_DEVICE_V1',origin,id,action,challenge,nonce,String(timestamp)].join('\n');
}
type Pair={id:string;deviceId:string;ownerId:string;accountChoice?:boolean;approvedAt?:number;name:string;os:string;agentVersion:string;publicKey:string;capabilities:string[];code:string;challenge:string;expires:number;status:'pending'|'approved'|'rejected'|'cancelled'|'consumed';proved:boolean;attempts:number;approvalAttempts?:number;browserChoice?:boolean;selectForAi?:boolean;nonces:string[];lastPoll:number;login?:string};
type Entry=Record<string,unknown>;
type PairEnv={ALLOWED_GITHUB_ID:string;JAN_PUBLIC_ORIGIN?:string;JAN_PAIRING_ENABLED?:string;JAN_MULTI_USER_ENABLED?:string};
const CONTROL_CAPABILITIES=['browser','commands','desktop','files'];
export function requestedCapabilities(value:unknown):string[] {
  if(value===undefined)return ['read'];
  if(!Array.isArray(value)||value.length>4||new Set(value).size!==value.length||value.some(v=>typeof v!=='string'||!CONTROL_CAPABILITIES.includes(v)))throw Error('Invalid capabilities');
  return value.length?['read','control',...value.slice().sort()]:['read'];
}
const view=(p:Pair,now:number,includeCode=true)=>({id:p.id,name:p.name,os:p.os,agentVersion:p.agentVersion,...(includeCode?{code:p.code}:{}),...(p.browserChoice?{browserChoice:true}:{}),expires:p.expires,remainingSeconds:Math.max(0,Math.ceil((p.expires-now)/1000)),status:p.expires<=now?'expired':p.status,proved:p.proved,capabilities:p.capabilities??['read']});
const bindingKey=(key:string)=>'pairing:key-owner:v1:'+key;

export async function pairingStore(path:string,body:Entry,storage:DurableObjectStorage,env:PairEnv,now=Date.now()):Promise<Response> {
  if(env.JAN_PAIRING_ENABLED!=='1'&&!['/pairing/plan','/pairing/access'].includes(path)) return json({error:'Pairing preview disabled'},404);
  return storage.transaction(async tx=>{
    const pairs=await tx.get<Record<string,Pair>>('pairing:v1')??{};
    for(const [id,pair] of Object.entries(pairs)) if(pair.expires+PAIR_TTL<=now) delete pairs[id];
    const save=()=>tx.put('pairing:v1',pairs);
    const planPro=async(id:string|null)=>{if(!id)return false;const plan=await tx.get<{pro:boolean;validUntil?:number|null}>('pairing:pro:v1:'+id);return !!plan?.pro&&(plan.validUntil==null||plan.validUntil>now);};
    const updatePlan=async(ownerId:string)=>{
      if(typeof body.pro!=='boolean'||!Number.isSafeInteger(body.revision)||Number(body.revision)<0||body.validUntil!==undefined&&body.validUntil!==null&&(!Number.isSafeInteger(body.validUntil)||Number(body.validUntil)<0))return false;
      const key='pairing:pro:v1:'+ownerId,previous=await tx.get<{pro:boolean;revision:number;validUntil?:number|null}>(key);
      if(previous&&previous.revision===Number(body.revision)&&(previous.pro!==body.pro||(previous.validUntil??null)!==(body.validUntil??null)))return false;
      if(!previous||previous.revision<Number(body.revision))await tx.put(key,{pro:body.pro,revision:body.revision,...(body.validUntil!==undefined?{validUntil:body.validUntil}:{})});
      return true;
    };
    if(path==='/pairing/plan'){
      const ownerId=authenticatedAccountId(body.ownerId);
      if(!ownerId||!await updatePlan(ownerId))return json({error:'Invalid plan state'},400);
      return json({ok:true});
    }
    if(path==='/pairing/access'){
      const ownerId=authenticatedAccountId(body.ownerId);
      if(!ownerId||typeof body.publicKey!=='string'||!await updatePlan(ownerId))return json({error:'Invalid installation access'},400);
      const owners=await tx.get<string[]>(bindingKey(body.publicKey))??[];
      if(!owners.length||owners[0]===ownerId)return json({allowed:true});
      if(!owners.includes(ownerId))return json({allowed:false});
      for(const id of owners)if(!await planPro(id))return json({allowed:false});
      return json({allowed:true});
    }
    if(path==='/pairing/release-check'){
      const ownerId=authenticatedAccountId(body.ownerId);
      if(!ownerId||typeof body.publicKey!=='string'||typeof body.id!=='string')return json({error:'Invalid release check'},400);
      const ids=await tx.get<string[]>('pairing:released:v1:'+body.publicKey+':'+ownerId)??[];
      return json({released:ids.includes(body.id),bound:(await tx.get<string[]>(bindingKey(body.publicKey))??[]).includes(ownerId)});
    }
    if(path==='/pairing/release'){
      const ownerId=authenticatedAccountId(body.ownerId);
      if(!ownerId||typeof body.publicKey!=='string'||!Array.isArray(body.ids)||body.ids.some(id=>typeof id!=='string'||! /^[a-f0-9-]{36}$/.test(id)))return json({error:'Invalid release'},400);
      const owners=await tx.get<string[]>(bindingKey(body.publicKey))??[];
      const releaseKey='pairing:released:v1:'+body.publicKey+':'+ownerId;
      await tx.put(releaseKey,[...new Set([...(await tx.get<string[]>(releaseKey)??[]),...body.ids])]);
      await tx.put(bindingKey(body.publicKey),owners.filter(id=>id!==ownerId));
      for(const pair of Object.values(pairs))if(pair.publicKey===body.publicKey&&pair.ownerId===ownerId)pair.status='cancelled';
      await save();return json({ok:true});
    }
    if(path==='/pairing/start') {
      const fields=Object.keys(body).filter(key=>!['reconnectOwnerId','accountChoice','accountReleased'].includes(key)).sort().join(',');
      const multi=env.JAN_MULTI_USER_ENABLED==='1';
      const fieldSets=multi?['agentVersion,clientKey,name,os,publicKey','agentVersion,capabilities,clientKey,name,os,publicKey']:['agentVersion,name,os,publicKey','agentVersion,capabilities,name,os,publicKey'];
      const acceptedFields=fieldSets.concat(fieldSets.map(fields=>fields.split(',').concat('browserChoice').sort().join(',')));
      if(!acceptedFields.includes(fields)||(body.browserChoice!==undefined&&body.browserChoice!==true)||typeof body.name!=='string'||! /^[\w .-]{1,64}$/.test(body.name)||typeof body.os!=='string'||! /^[\w .()-]{1,80}$/.test(body.os)||typeof body.agentVersion!=='string'||! /^[\w.+-]{1,32}$/.test(body.agentVersion)||typeof body.publicKey!=='string'||multi&&(typeof body.clientKey!=='string'||!TOKEN.test(body.clientKey))) return json({error:'Invalid pairing metadata'},400);
      if(body.reconnectOwnerId!==undefined&&!authenticatedAccountId(body.reconnectOwnerId)||body.accountChoice!==undefined&&body.accountChoice!==true||body.accountReleased!==undefined&&body.accountReleased!==true)return json({error:'Invalid account binding'},400);
      let capabilities:string[];try {capabilities=requestedCapabilities(body.capabilities);} catch {return json({error:'Invalid requested capabilities'},400);}
      try {await publicKey(body.publicKey);} catch {return json({error:'Invalid device public key'},400);}
      const rate=await tx.get<{start:number;count:number}>('pairing:rate');
      const next=rate&&rate.start+60000>now?rate:{start:now,count:0};
      if(next.count>=(multi?60:10)||Object.keys(pairs).length>=(multi?256:64)) return json({error:'Pairing limit reached'},429);
      if(multi) {
        const clients=await tx.get<Record<string,{start:number;count:number}>>('pairing:client-rates:v1')??{};
        for(const [key,item] of Object.entries(clients))if(item.start+60000<=now)delete clients[key];
        const clientKey=body.clientKey as string;
        const client=clients[clientKey]??{start:now,count:0};
        if(client.count>=5)return json({error:'Pairing client limit reached'},429);
        client.count++;clients[clientKey]=client;
        await tx.put('pairing:client-rates:v1',clients);
      }
      next.count++;await tx.put('pairing:rate',next);
      const owners=multi?await tx.get<string[]>(bindingKey(body.publicKey))??[]:[];
      const expected=authenticatedAccountId(body.reconnectOwnerId);
      if(expected&&owners.length&&!owners.includes(expected))return json({error:'Account binding denied'},403);
      const p:Pair={id:randomToken(),deviceId:crypto.randomUUID(),ownerId:multi?expected??owners[0]??'':env.ALLOWED_GITHUB_ID,...(body.accountChoice?{accountChoice:true}:{}),name:body.name,os:body.os,agentVersion:body.agentVersion,publicKey:body.publicKey,capabilities,...(body.browserChoice?{browserChoice:true}:{}),code:displayCode(),challenge:randomToken(),expires:now+PAIR_TTL,status:'pending',proved:false,attempts:0,nonces:[],lastPoll:0};
      pairs[p.id]=p;await save();
      return json({...view(p,now),...(body.accountReleased?{accountReleased:true}:{}),server_time:now,challenge:p.challenge,interval:2,verification_uri:env.JAN_PUBLIC_ORIGIN+'/devices/approve?id='+p.id},201);
    }
    if(typeof body.id!=='string'||!TOKEN.test(body.id)||!pairs[body.id]) return json({error:'Pairing unavailable'},404);
    const p=pairs[body.id];
    if(path==='/pairing/context')return json({publicKey:p.publicKey,owners:[...new Set([...(await tx.get<string[]>(bindingKey(p.publicKey))??[]),...(p.ownerId?[p.ownerId]:[])])],accountChoice:p.accountChoice===true});
    if(path==='/pairing/view'||path==='/pairing/decide') {
      // Only the authenticated portal injects this immutable provider subject.
      const ownerId=authenticatedAccountId(body.ownerId);
      const owners=await tx.get<string[]>(bindingKey(p.publicKey))??[];
      if(owners.length>1&&ownerId!==owners[0])for(const id of owners)if(!await planPro(id))return json({error:'Shared installation requires Pro on each account'},402);
      const foreign=p.ownerId&&ownerId!==p.ownerId||owners.length&&!owners.includes(ownerId??'');
      const checkedOwners=Array.isArray(body.shareOwners)?body.shareOwners:[];
      let shareAllowed=p.accountChoice&&body.shareAllowed===true&&owners.every(id=>checkedOwners.includes(id));
      if(shareAllowed)for(const id of [...new Set([...owners,ownerId])])if(!await planPro(id)){shareAllowed=false;break;}
      if(!ownerId||foreign&&!shareAllowed) return json({error:'Wrong PCRC account'},403);
      if(path==='/pairing/view') return json(view(p,now,p.browserChoice||env.JAN_MULTI_USER_ENABLED!=='1'));
      if(p.expires<=now||p.status!=='pending') return json({error:'Pairing is no longer pending'},409);
      if(body.decision!=='approve'&&body.decision!=='reject') return json({error:'Invalid decision'},400);
      let selected=p.capabilities;
      if(p.browserChoice&&body.decision==='approve') {
        if(body.codesMatch!==true)return json({error:'Compare both codes and confirm they match'},403);
        try {selected=requestedCapabilities(body.capabilities);} catch {return json({error:'Invalid selected capabilities'},400);}
        if(selected.some(cap=>!p.capabilities.includes(cap)))return json({error:'Selected permissions exceed the computer offer'},403);
      }
      if(!p.browserChoice&&env.JAN_MULTI_USER_ENABLED==='1') {
        if((p.approvalAttempts??0)>=5)return json({error:'Verification code locked; start again'},403);
        const entered=typeof body.confirmationCode==='string'?body.confirmationCode.replace(' ',''):null;
        if(!entered||!/^[0-9]{6}$/.test(entered)||entered!==p.code.replace(' ','')) {
          p.approvalAttempts=(p.approvalAttempts??0)+1;await save();
          return json({error:'Verification code did not match'},403);
        }
      }
      if(body.decision==='approve'&&!p.proved) return json({error:'Wait for device key verification and refresh'},409);
      if(typeof body.login!=='string'||body.login.length>100) return json({error:'Invalid account'},403);
      p.capabilities=selected;
      if(p.browserChoice)p.selectForAi=body.selectForAi===true;
      p.status=body.decision==='approve'?'approved':'rejected';p.ownerId=ownerId;p.login=body.login;
      if(body.decision==='approve')p.approvedAt=now;
      if(body.decision==='approve'&&env.JAN_MULTI_USER_ENABLED==='1')await tx.put(bindingKey(p.publicKey),[...new Set([...owners,ownerId])]);
      await save();return json({ok:true});
    }
    if(path!=='/pairing/proof') return json({error:'Not found'},404);
    if(Object.keys(body).sort().join(',')!=='action,id,nonce,signature,timestamp'||!['status','collect','cancel'].includes(String(body.action))||typeof body.nonce!=='string'||!TOKEN.test(body.nonce)||typeof body.timestamp!=='number'||!Number.isSafeInteger(body.timestamp)) return json({error:'Invalid device proof'},400);
    if(p.attempts>=5) return json({error:'Pairing locked; start again'},403);
    if(Math.abs(now-body.timestamp)>60000||p.nonces.includes(body.nonce)||!await verifySignature(p.publicKey,body.signature,pairingProof(env.JAN_PUBLIC_ORIGIN??'',p.id,String(body.action),p.challenge,body.nonce,body.timestamp))) {
      p.attempts++;await save();return json({error:'Device proof denied'},403);
    }
    if(p.expires<=now) return json({status:'expired'},410);
    if(body.action!=='cancel'&&now-p.lastPoll<1000) return json({error:'Poll more slowly'},429);
    p.lastPoll=now;p.nonces.push(body.nonce);p.proved=true;
    if(body.action==='cancel'&&p.status!=='consumed') p.status='cancelled';
    if(body.action==='collect'&&(p.status==='approved'||p.status==='consumed')) {
      if(env.JAN_MULTI_USER_ENABLED==='1') {
        if(!p.ownerId||!p.login)return json({error:'Pairing denied'},403);
        p.status='consumed';await save();
        return json({...(p.browserChoice?{selectForAi:p.selectForAi===true}:{}),status:'consumed',session:{id:p.deviceId,name:p.name,owner_id:p.ownerId,worker:env.JAN_PUBLIC_ORIGIN,protocol:2,capabilities:p.capabilities??['read']},registration:{id:p.deviceId,name:p.name,os:p.os,agentVersion:p.agentVersion,ownerId:p.ownerId,login:p.login,publicKey:p.publicKey,capabilities:p.capabilities??['read'],created:now,approvedAt:p.approvedAt??p.expires-PAIR_TTL}});
      }
      const devices=await tx.get<Record<string,Entry>>('devices')??{};
      if(p.status==='approved') {
        if(Object.values(devices).filter(d=>!d.revoked).length>=12) return json({error:'Device limit reached'},429);
        devices[p.deviceId]={id:p.deviceId,name:p.name,os:p.os,agentVersion:p.agentVersion,ownerId:p.ownerId,login:p.login,publicKey:p.publicKey,capabilities:p.capabilities??['read'],created:now,revoked:false,lastSeen:0,origin:null};
        await tx.put('devices',devices);
        if(p.selectForAi===true)await tx.put('active',p.deviceId);
        p.status='consumed';
        // Keep the current selection. A new device is selected explicitly on the portal.
      }
      if(!devices[p.deviceId]||devices[p.deviceId].revoked) return json({error:'Device revoked'},403);
      await save();
      // Idempotent delivery contains no bearer credential. The device-held key is required for WSS.
      return json({...(p.browserChoice?{selectForAi:p.selectForAi===true}:{}),status:'consumed',session:{id:p.deviceId,name:p.name,owner_id:p.ownerId,worker:env.JAN_PUBLIC_ORIGIN,protocol:2,capabilities:p.capabilities??['read']}});
    }
    await save();return json({status:p.status,expires:p.expires});
  });
}
