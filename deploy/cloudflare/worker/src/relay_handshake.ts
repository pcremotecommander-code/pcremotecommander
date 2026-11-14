/** JAN relay device handshake verifier. Call before accepting a WebSocket. */
import {deviceKey} from './policy.ts';
import {verifySignature} from './pairing.ts';
const encoder=new TextEncoder();
const ID=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const NONCE=/^[A-Za-z0-9_-]{22,64}$/;
const hex=(data:ArrayBuffer)=>Array.from(new Uint8Array(data),b=>b.toString(16).padStart(2,'0')).join('');
export interface RelayHandshake {
  device_id:string;owner_id:string;timestamp:number;nonce:string;signature:string;
}
export async function signHandshake(key:string,value:Omit<RelayHandshake,'signature'>):Promise<string> {
  const raw=await crypto.subtle.importKey('raw',encoder.encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const payload=['JAN_RELAY_WS_V1',value.owner_id,value.device_id,String(value.timestamp),value.nonce].join('\n');
  return hex(await crypto.subtle.sign('HMAC',raw,encoder.encode(payload)));
}
export class RelayHandshakeVerifier {
  private used=new Map<string,number>();
  async verify(value:unknown,ownerId:string,masterKey:string,deviceAllowed:(id:string)=>Promise<boolean|string>,now=Math.floor(Date.now()/1000)):Promise<boolean> {
    if(!value||typeof value!=='object'||Array.isArray(value))return false;
    const v=value as Record<string,unknown>;
    const v2=v.protocol===2, v3=v.protocol===3;
    if(Object.keys(v).sort().join(',')!==(v3?'device_id,lease_seconds,nonce,owner_id,protocol,signature,timestamp':v2?'device_id,nonce,owner_id,protocol,signature,timestamp':'device_id,nonce,owner_id,signature,timestamp'))return false;
    if(typeof v.device_id!=='string'||!ID.test(v.device_id)||v.owner_id!==ownerId||
       typeof v.timestamp!=='number'||!Number.isSafeInteger(v.timestamp)||Math.abs(now-v.timestamp)>60||
       typeof v.nonce!=='string'||!NONCE.test(v.nonce)||
       (v3&&(!Number.isSafeInteger(v.lease_seconds)||Number(v.lease_seconds)<60||Number(v.lease_seconds)>28800))||
       typeof v.signature!=='string'||!(v2||v3?/^[A-Za-z0-9_-]{86}$/:/^[a-f0-9]{64}$/).test(v.signature))return false;
    const nonceKey=v.device_id+':'+v.nonce;
    for(const [key,expires] of this.used){if(expires<now)this.used.delete(key);}
    if(this.used.has(nonceKey)||this.used.size>=4096)return false;
    const approved=await deviceAllowed(v.device_id);
    if(!approved)return false;
    if(v2||v3) {
      const message=v3?['JAN_RELAY_WS_V3',ownerId,v.device_id,String(v.timestamp),v.nonce,String(v.lease_seconds)]:['JAN_RELAY_WS_V2',ownerId,v.device_id,String(v.timestamp),v.nonce];
      if(typeof approved!=='string'||!await verifySignature(approved,v.signature,message.join('\n'))) return false;
    } else {
      // A device enrolled with a public key can never fall back to the legacy master-derived key.
      if(typeof approved==='string') return false;
      const key=await deviceKey(masterKey,v.device_id);
      const expected=await signHandshake(key,{owner_id:ownerId,device_id:v.device_id,timestamp:v.timestamp,nonce:v.nonce});
      let diff=0;for(let i=0;i<64;i++)diff|=expected.charCodeAt(i)^v.signature.charCodeAt(i);
      if(diff!==0)return false;
    }
    this.used.set(nonceKey,now+120);
    return true;
  }
}
