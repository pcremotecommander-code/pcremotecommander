export const CONTROL_CATALOG_READ_TOOLS = new Set(['inspect_development','get_development_change','inspect_document_pdf','preview_document_workflow','get_document_workflow','read_pdf', 'inspect_media', 'transcribe_audio', 'list_processes', 'list_applications','inspect_office_document','preview_spreadsheet_edit','preview_file_edit','inspect_file','compare_files']);
/** JAN outbound relay: strict message contracts (no transport side-effects). */
export const RELAY_MAX_REQUEST=262144;
export const RELAY_MAX_RESPONSE=1048576;
export const RELAY_TIMEOUT_MS=20000;
export type RelayRequest={type:'request';request_id:string;payload:string;control:boolean};
export type RelayReply={type:'response';request_id:string;status:number;payload:string};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const byteSize=(s:string)=>new TextEncoder().encode(s).byteLength;
export function validateRelayRequest(v:unknown):RelayRequest {
  if(!v||typeof v!=='object'||Array.isArray(v)) throw Error('Invalid relay request');
  const o=v as Record<string,unknown>;
  if(Object.keys(o).sort().join(',')!=='control,payload,request_id,type'||o.type!=='request'||typeof o.request_id!=='string'||!uuid.test(o.request_id)||typeof o.control!=='boolean'||typeof o.payload!=='string'||byteSize(o.payload)>RELAY_MAX_REQUEST) throw Error('Invalid relay request');
  const msg=JSON.parse(o.payload);
  if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0'||typeof msg.method!=='string') throw Error('Invalid relay MCP payload');
  return o as RelayRequest;
}
export function validateRelayReply(v:unknown):RelayReply {
  if(!v||typeof v!=='object'||Array.isArray(v)) throw Error('Invalid relay reply');
  const o=v as Record<string,unknown>;
  if(Object.keys(o).sort().join(',')!=='payload,request_id,status,type'||o.type!=='response'||typeof o.request_id!=='string'||!uuid.test(o.request_id)||typeof o.status!=='number'||!Number.isInteger(o.status)||![200,202,204].includes(o.status)||typeof o.payload!=='string'||byteSize(o.payload)>RELAY_MAX_RESPONSE) throw Error('Invalid relay reply');
  if(o.status===200) {
    const msg=JSON.parse(o.payload);
    if(!msg||Array.isArray(msg)||msg.jsonrpc!=='2.0') throw Error('Invalid MCP reply');
  } else if(o.payload!=='') throw Error('Unexpected response body');
  return o as RelayReply;
}
