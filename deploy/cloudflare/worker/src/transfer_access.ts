import {verifySignature} from './pairing.ts';
import {accountFromDeviceProof} from './account_identity.ts';
import {boundedBody,failure,type Settings} from './policy.ts';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type EnrolledKeys = (source:string,destination:string) => Promise<[string|null,string|null]>;

export async function checkTransferRequest(request:Request, env:Settings):Promise<Response> {
  if(request.method!=='POST'||new URL(request.url).search)return failure(405,'Transfer request denied');
  let proof:string;
  try {proof=new TextDecoder().decode(await boundedBody(request,1024));}
  catch {return failure(413,'Transfer proof too large');}
  const account=accountFromDeviceProof(proof,env.ALLOWED_GITHUB_ID,env.JAN_MULTI_USER_ENABLED,env.JAN_BETA_GITHUB_IDS);
  if(!account)return failure(403,'Transfer proof denied');
  try {
    if(!env.DEVICES)throw Error();
    const stub=env.DEVICES.get(env.DEVICES.idFromName(account));
    return await stub.fetch('https://internal.invalid/transfer/verify',{method:'POST',body:proof,headers:{'X-Jan-Account-Id':account,'Content-Type':'application/json'}});
  } catch {return failure(503,'Transfer verification unavailable');}
}

export async function verifyTransfer(input:unknown, account:string, enrolledKeys:EnrolledKeys, now=Math.floor(Date.now()/1000)):Promise<boolean> {
  if(!input||typeof input!=='object'||Array.isArray(input))return false;
  const {owner_id,source,destination,session,timestamp,sender,receiver}=input as Record<string,unknown>;
  if(Object.keys(input).length!==7||owner_id!==account||typeof source!=='string'||typeof destination!=='string'||
    source===destination||!uuid.test(source)||!uuid.test(destination)||typeof session!=='string'||!/^[0-9a-f]{64}$/.test(session)||
    typeof timestamp!=='number'||!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp)>60)return false;
  const [sourceKey,destinationKey]=await enrolledKeys(source,destination);
  if(!sourceKey||!destinationKey)return false;
  const message=['PCRC_LAN_TRANSFER_V1',account,source,destination,session,String(timestamp)].join('\n');
  if(!await verifySignature(sourceKey,sender,message)||!await verifySignature(destinationKey,receiver,message))return false;
  // WebCrypto yields. Check the keys and live sessions again after verification.
  const [currentSource,currentDestination]=await enrolledKeys(source,destination);
  return currentSource===sourceKey&&currentDestination===destinationKey;
}
