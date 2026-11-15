import {openRecord,sealRecord,type SealedRecord} from './secure_store.ts';

const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function totpSecret(bytes=crypto.getRandomValues(new Uint8Array(20))):string {
  let bits=0,value=0,out='';for(const byte of bytes){value=(value<<8)|byte;bits+=8;while(bits>=5){out+=alphabet[(value>>>(bits-=5))&31];}}if(bits)out+=alphabet[(value<<(5-bits))&31];return out;
}
export async function totpCode(secret:string,step:number):Promise<string> {
  if(!/^[A-Z2-7]{32}$/.test(secret)||!Number.isSafeInteger(step)||step<0)throw Error('Invalid authenticator input');
  let bits=0,value=0;const bytes:number[]=[];for(const char of secret){value=(value<<5)|alphabet.indexOf(char);bits+=5;if(bits>=8)bytes.push((value>>>(bits-=8))&255);}
  const key=await crypto.subtle.importKey('raw',new Uint8Array(bytes),{name:'HMAC',hash:'SHA-1'},false,['sign']);
  const counter=new ArrayBuffer(8);new DataView(counter).setBigUint64(0,BigInt(step));
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,counter)),offset=digest[19]&15;
  return String(((digest[offset]&127)*16777216+digest[offset+1]*65536+digest[offset+2]*256+digest[offset+3])%1000000).padStart(6,'0');
}
const hash=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
const result=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store'}});
type Config={record:SealedRecord;lastStep:number;recovery:string[]};
type Env={JAN_PROXY_KEY:string;ALLOWED_GITHUB_ID:string;PCRC_OWNER_GITHUB_ID?:string};

/** All state is in the bound operator DO, including replay/throttle decisions. */
export async function ownerSecurityStore(path:string,body:any,storage:DurableObjectStorage,env:Env,accountId:string):Promise<Response|null> {
  if(!path.startsWith('/owner-auth/'))return null;
  if(accountId!==env.ALLOWED_GITHUB_ID)return result({error:'Owner required'},403);
  if(env.PCRC_OWNER_GITHUB_ID&&body.principal!==env.PCRC_OWNER_GITHUB_ID)return result({error:'Owner authentication changed'},403);
  const now=Date.now(),session=body.session;
  if(typeof session!=='string'||!/^[a-f0-9]{64}$/.test(session))return result({error:'Owner session required'},403);
  const principal=env.PCRC_OWNER_GITHUB_ID;
  const suffix=principal?':'+principal:'';
  const activeKey='owner:totp:v1'+suffix,pendingKey='owner:totp-pending:'+session+suffix,grantKey='owner:mfa-session:'+session+suffix,attemptsKey='owner:totp-attempts:v1'+suffix;
  return storage.transaction(async tx=>{
    const active=await tx.get<Config>(activeKey);
    const grant=await tx.get<{expires:number}>(grantKey);
    if(path==='/owner-auth/status')return result({enabled:!!active,verified:!!active&&!!grant&&grant.expires>now});
    if(path==='/owner-auth/enroll'){
      if(active)return result({error:'Authenticator already enabled'},409);
      if(body.recent!==true)return result({error:'Sign in with owner GitHub again before setup'},403);
      let pending=await tx.get<SealedRecord>(pendingKey);
      if(!pending||pending.expires<=now){pending=await sealRecord(env.JAN_PROXY_KEY,accountId,'owner-totp-pending'+suffix,{secret:totpSecret()},now+300000);await tx.put(pendingKey,pending);}
      return result({secret:(await openRecord<{secret:string}>(env.JAN_PROXY_KEY,accountId,'owner-totp-pending'+suffix,pending)).secret,expires:pending.expires});
    }
    if(path!=='/owner-auth/verify')return result({error:'Unknown security operation'},404);
    const attempts=await tx.get<{count:number;until:number}>(attemptsKey);
    if(attempts&&attempts.until>now&&attempts.count>=5)return result({error:'Too many codes. Wait ten minutes.'},429);
    const code=typeof body.code==='string'?body.code.trim():'';
    let step=-1,recoveryIndex=-1,secret='';
    if(active){
      if(active.record.expires<=now)return result({error:'Authenticator requires operator recovery'},403);
      secret=(await openRecord<{secret:string}>(env.JAN_PROXY_KEY,accountId,'owner-totp'+suffix,active.record)).secret;
      if(/^[A-Z2-7]{16}$/.test(code))recoveryIndex=active.recovery.indexOf(await hash(code));
    }else{
      const pending=await tx.get<SealedRecord>(pendingKey);
      if(!pending||pending.expires<=now||body.recent!==true)return result({error:'Authenticator setup expired. Sign in again.'},403);
      secret=(await openRecord<{secret:string}>(env.JAN_PROXY_KEY,accountId,'owner-totp-pending'+suffix,pending)).secret;
    }
    if(/^\d{6}$/.test(code))for(const candidate of [Math.floor(now/30000),Math.floor(now/30000)-1,Math.floor(now/30000)+1]){
      if(candidate>(active?.lastStep??-1)&&await totpCode(secret,candidate)===code){step=candidate;break;}
    }
    if(step<0&&recoveryIndex<0){await tx.put(attemptsKey,{count:attempts&&attempts.until>now?attempts.count+1:1,until:attempts&&attempts.until>now?attempts.until:now+600000});return result({error:'Code invalid, expired or already used'},403);}
    let recoveryCodes:string[]=[];
    const next=active??{record:await sealRecord(env.JAN_PROXY_KEY,accountId,'owner-totp'+suffix,{secret},now+10*365*86400000),lastStep:-1,recovery:[]};
    if(!active){recoveryCodes=Array.from({length:8},()=>totpSecret(crypto.getRandomValues(new Uint8Array(10))));next.recovery=await Promise.all(recoveryCodes.map(hash));}
    if(recoveryIndex>=0)next.recovery.splice(recoveryIndex,1);else next.lastStep=step;
    await tx.put(activeKey,next);await tx.delete(pendingKey);await tx.delete(attemptsKey);
    await tx.put(grantKey,{expires:now+3600000});
    return result({verified:true,recoveryCodes});
  });
}
