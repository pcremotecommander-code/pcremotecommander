/** Isolated JAN relay session; transport integration must authenticate the device first. */
import {validateRelayRequest,validateRelayReply,RELAY_TIMEOUT_MS,type RelayRequest,type RelayReply} from './relay_protocol.ts';
export class JanRelaySession {
  private socket:WebSocket|null=null;
  private pending=new Map<string,{resolve:(v:RelayReply)=>void;reject:(e:Error)=>void;timeout:ReturnType<typeof setTimeout>}>();
  private expired=new Set<string>();
  private closed=false;
  private leaseTimer:ReturnType<typeof setTimeout>|null=null;
  private stopped:()=>void;
  constructor(stopped=()=>{}){this.stopped=stopped;}
  attach(socket:WebSocket,leaseSeconds=28800) {
    if(this.closed) throw Error('Session closed');
    if(this.socket) throw Error('Device already connected');
    if(!Number.isSafeInteger(leaseSeconds)||leaseSeconds<60||leaseSeconds>28800) throw Error('Invalid relay lease');
    this.socket=socket;
    this.leaseTimer=setTimeout(()=>this.close(),leaseSeconds*1000);
    socket.addEventListener('message',(event)=>{
      try {
        if(typeof event.data!=='string') throw Error('Binary denied');
        const reply=validateRelayReply(JSON.parse(event.data));
        const item=this.pending.get(reply.request_id);
        if(!item) {
          if(this.expired.has(reply.request_id))return;
          throw Error('Unknown response');
        }
        this.pending.delete(reply.request_id);
        clearTimeout(item.timeout);
        item.resolve(reply);
      } catch {this.close(); }
    });
    socket.addEventListener('close',()=>this.close());
    socket.addEventListener('error',()=>this.close());
  }
  async forward(value:unknown):Promise<RelayReply> {
    const request=validateRelayRequest(value);
    if(this.closed||!this.socket||this.socket.readyState!==1) throw Error('Device offline');
    // The installed agent accepts at most four concurrent calls.
    if(this.pending.size>=4) throw Error('Relay busy');
    if(this.pending.has(request.request_id)||this.expired.has(request.request_id)) throw Error('Duplicate request');
    return new Promise<RelayReply>((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        this.pending.delete(request.request_id);
        this.expired.add(request.request_id);
        reject(Error('Relay timeout'));
        // Bound retained IDs without ever matching an old reply to a new call.
        if(this.expired.size>=128)this.close();
      },RELAY_TIMEOUT_MS);
      this.pending.set(request.request_id,{resolve,reject,timeout});
      try {this.socket!.send(JSON.stringify(request));}
      catch {clearTimeout(timeout);this.pending.delete(request.request_id);reject(Error('Relay send failed'));}
    });
  }
  close() {
    if(this.closed)return;
    this.closed=true;
    if(this.leaseTimer!==null){clearTimeout(this.leaseTimer);this.leaseTimer=null;}
    for(const pending of this.pending.values()){clearTimeout(pending.timeout);pending.reject(Error('Device disconnected'));}
    this.pending.clear();
    this.expired.clear();
    const socket=this.socket;this.socket=null;
    if(socket&&socket.readyState<2)try{socket.close(1000,'Disconnected');}catch{}
    this.stopped();
  }
  get online(){return !this.closed&&this.socket?.readyState===1;}
}
