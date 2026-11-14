import {ConnectedAccountLease} from './connected_capacity.ts';
import {RelayHandshakeVerifier} from './relay_handshake.ts';
import {JanRelaySession} from './relay_session.ts';
export interface RelayUpgradeEnvironment { ALLOWED_GITHUB_ID:string; JAN_PROXY_KEY:string; DEVICES?:DurableObjectNamespace; }
export class JanRelayUpgrade {
  private sessions=new Map<string,JanRelaySession>();
  private capacity:ConnectedAccountLease|null=null;
  private verifier=new RelayHandshakeVerifier();
  private readonly env:RelayUpgradeEnvironment;
  constructor(env:RelayUpgradeEnvironment) {this.env=env;}
  async handle(request:Request,allowed:(id:string)=>Promise<boolean|string>,consume?:(nonce:string)=>Promise<boolean>,accountId=this.env.ALLOWED_GITHUB_ID,accountName?:(deviceId:string)=>Promise<unknown>):Promise<Response> {
    if(request.method!=='GET'||new URL(request.url).pathname!=='/relay/connect') return Response.json({error:'Not found'},{status:404});
    if(request.headers.get('upgrade')?.toLowerCase()!=='websocket'||request.headers.get('connection')?.toLowerCase().split(',').map(x=>x.trim()).includes('upgrade')!==true) return Response.json({error:'Upgrade required'},{status:426});
    const raw=request.headers.get('x-jan-device-proof');
    if(!raw||raw.length>1024)return Response.json({error:'Device proof denied'},{status:403});
    let data:unknown;
    try{data=JSON.parse(raw);}catch{return Response.json({error:'Device proof denied'},{status:403});}
    if(!await this.verifier.verify(data,accountId,this.env.JAN_PROXY_KEY,allowed))return Response.json({error:'Device proof denied'},{status:403});
    const proof=data as {device_id:string;nonce:string;protocol?:number;lease_seconds?:number};
    if(consume&&!await consume(proof.device_id+':'+proof.nonce)) return Response.json({error:'Device proof replayed'},{status:403});
    const deviceId=(data as {device_id:string}).device_id;
    // Signature verification yields to WebCrypto; revocation may have run during that await.
    if(!await allowed(deviceId)) return Response.json({error:'Device revoked'},{status:403});
    const headers=new Headers();
    if(request.headers.get('X-PCRC-Terminal-Status')==='1') {
      headers.set('X-PCRC-Account-Id',accountId);
      const login=await accountName?.(deviceId);
      if(typeof login==='string'&&/^[A-Za-z0-9-]{1,39}$/.test(login))headers.set('X-PCRC-Account-Name',login);
      if(!await allowed(deviceId))return Response.json({error:'Device revoked'},{status:403});
    }
    if(!this.env.DEVICES)return Response.json({error:'Connection admission unavailable'},{status:503});
    this.capacity??=new ConnectedAccountLease(this.env.DEVICES,accountId,()=>{
      for(const session of this.sessions.values())session.close();this.sessions.clear();
    });
    const admission=await this.capacity.acquire();
    if(admission!==200)return Response.json({error:admission===429?'PCRC currently supports 200 connected accounts. Please retry shortly.':'Connection admission unavailable'},
      {status:admission,headers:{'Retry-After':'30','Cache-Control':'no-store'}});
    // Admission yields to the shared counter; revocation may have happened meanwhile.
    if(!await allowed(deviceId)){
      if(!this.sessions.size)this.capacity.stop();
      return Response.json({error:'Device revoked'},{status:403});
    }
    if(!this.capacity.valid)return Response.json({error:'Connection admission expired'},{status:503});
    // A fresh signed handshake replaces a socket the agent can no longer use.
    const previous=this.sessions.get(deviceId);
    let session:JanRelaySession|null=null;
    try {
    const pair=new WebSocketPair();
    const client=pair[0],server=pair[1];
    server.accept();
    session=new JanRelaySession(()=>{if(this.sessions.get(deviceId)===session){this.sessions.delete(deviceId);if(!this.sessions.size)this.capacity?.stop();}});
    session.attach(server,proof.protocol===3?proof.lease_seconds!:28800);
    this.sessions.set(deviceId,session);
    previous?.close();

    return new Response(null,{status:101,webSocket:client,headers});
    }catch{session?.close();if(!this.sessions.size)this.capacity.stop();return Response.json({error:'Connection setup unavailable'},{status:503});}
  }
  getSession(deviceId:string){if(!this.capacity?.valid){for(const session of this.sessions.values())session.close();this.sessions.clear();this.capacity?.stop();return null;}return this.sessions.get(deviceId)??null;}
  disconnect(deviceId:string){const item=this.sessions.get(deviceId);item?.close();this.sessions.delete(deviceId);if(!this.sessions.size)this.capacity?.stop();}
}
