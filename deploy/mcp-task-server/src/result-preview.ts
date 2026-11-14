/** Retired result panels: preserve plain results and clear cached template references. */
export const resultPreviewUri='ui://pcrc/result-preview-v1.html';
export function resultPreviewResource(id:unknown) {
  return {jsonrpc:'2.0',id,result:{contents:[]}};
}
export function includeResultPreview(reply:any,method:string) {
  if(method==='tools/list'&&Array.isArray(reply?.result?.tools))for(const tool of reply.result.tools){
    if(tool._meta?.ui?.resourceUri===resultPreviewUri){delete tool._meta.ui.resourceUri;if(!Object.keys(tool._meta.ui).length)delete tool._meta.ui;}
    if(tool._meta?.['openai/outputTemplate']===resultPreviewUri)delete tool._meta['openai/outputTemplate'];
    if(tool._meta&&!Object.keys(tool._meta).length)delete tool._meta;
  }
  if(method==='resources/list'&&Array.isArray(reply?.result?.resources))reply.result.resources=reply.result.resources.filter((r:any)=>r.uri!==resultPreviewUri);
  return reply;
}
