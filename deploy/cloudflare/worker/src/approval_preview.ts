import {actionResultTool} from './action_result.ts';
/** Capability probe only: never issues an authorization token or executes an action. */
export const approvalPreviewTool={
  name:'test_approval_dialog',
  description:'Test MCP elicitation FORM support only. This does NOT test ChatGPT or Claude built-in tool confirmation prompts, nor MCP Apps cards. Accepting this harmless test cannot approve computer actions or payments.',
  inputSchema:{type:'object',properties:{},additionalProperties:false},
  outputSchema:{type:'object',properties:{supported:{type:'boolean'},decision:{type:'string'},execution_authorized:{type:'boolean',const:false}},required:['supported','decision','execution_authorized'],additionalProperties:false},
  annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false},
};
const state='pcrc-dialog-preview-v1';
export function approvalPreview(call:any) {
  const result=(supported:boolean,decision:string,message:string)=>({jsonrpc:'2.0',id:call.id,result:{
    content:[{type:'text',text:message}],structuredContent:{supported,decision,execution_authorized:false},
  }});
  const args=call.params?.arguments??{};
  if(!args||Array.isArray(args)||typeof args!=='object'||Object.keys(args).length)
    return result(false,'invalid','This diagnostic accepts no tool arguments and cannot execute an action.');
  const meta=call.params?._meta,elicitation=meta?.['io.modelcontextprotocol/clientCapabilities']?.elicitation;
  const supported=meta?.['io.modelcontextprotocol/protocolVersion']==='2026-07-28'&&elicitation&&
    typeof elicitation==='object'&&!Array.isArray(elicitation)&&
    (Object.keys(elicitation).length===0||elicitation.form&&typeof elicitation.form==='object'&&!Array.isArray(elicitation.form));
  if(!supported)return result(false,'unsupported','MCP 2026-07-28 elicitation forms were not advertised. This does NOT mean ChatGPT or Claude built-in tool approvals are unsupported. Those are client confirmation settings, used automatically for recognized ChatGPT and Claude control connections. test_approval_card checks custom cards only. No action was executed.');
  if(call.params.requestState===state) {
    const response=call.params.inputResponses?.pcrc_dialog_preview;
    if(response?.action==='decline'||response?.action==='cancel')return result(true,response.action,'The approval test was dismissed. No action was executed or authorized.');
    if(response?.action==='accept'&&response.content?.test_dialog===true)
      return result(true,'accepted','The client returned the approval-test form response. This test did not execute or authorize any computer action.');
  }
  return {jsonrpc:'2.0',id:call.id,result:{resultType:'input_required',requestState:state,inputRequests:{pcrc_dialog_preview:{
    method:'elicitation/create',params:{mode:'form',message:'PC Remote Commander approval dialog test. Nothing will run and no files, permissions or payments will change.',
      requestedSchema:{type:'object',properties:{test_dialog:{type:'boolean',title:'Confirm this harmless dialog test',default:false}},required:['test_dialog']}}
  }}}};
}
export function includeApprovalPreview(reply:any,diagnostics=true) {
  if(!diagnostics&&Array.isArray(reply?.result?.tools))reply.result.tools=reply.result.tools.filter((tool:any)=>tool?.name!==approvalPreviewTool.name);
  if(diagnostics&&Array.isArray(reply?.result?.tools)&&!reply.result.tools.some((tool:any)=>tool?.name===approvalPreviewTool.name))reply.result.tools.push(approvalPreviewTool);
  if(Array.isArray(reply?.result?.tools)&&!reply.result.tools.some((tool:any)=>tool?.name===actionResultTool.name))reply.result.tools.push(actionResultTool);
  return reply;
}
