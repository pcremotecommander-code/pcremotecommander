import {CONTROL_CATALOG_READ_TOOLS} from './relay_protocol.ts';

// Unknown tools and commands always require control, regardless of their arguments or name.
export function actionAccess(name:string):'read'|'write' {
  return CONTROL_CATALOG_READ_TOOLS.has(name)||['inspect_desktop_controls','capture_desktop','capture_browser','inspect_browser_page','list_browser_tabs','read_file_excerpt','read_multiple_files','get_file_info','list_workspace_entries','search_workspace'].includes(name)?'read':'write';
}
export function requiresActionReview(name:string):boolean {
  // Dashboard warning severity only; verified-host confirmation routing is enforced separately.
  return !CONTROL_CATALOG_READ_TOOLS.has(name)&&![
    'create_directory','create_text_file','create_pdf','read_file_excerpt','read_multiple_files','get_file_info','list_workspace_entries','search_workspace',
    'apply_document_workflow','apply_file_edit','apply_spreadsheet_edit','edit_media','rewrite_pdf','restore_file_backup','move_files_bulk',
    'list_browser_tabs','inspect_browser_page','capture_browser','navigate_browser','interact_browser','manage_browser_tab','capture_desktop','interact_desktop','inspect_desktop_controls','interact_desktop_control','open_application',
    'create_task','claim_task','renew_task','finish_task','reconcile_task','read_process_output','stop_process',
    'teach_browser_workflow','publish_workflow','start_workflow_run','delete_workflow','run_workflow_step','stop_search',
  ].includes(name);
}
export function actionPurpose(name:string):string {
  if(name==='run_command'||name==='start_process')return 'Run the exact command on this computer. Commands can affect files and applications beyond the workspace.';
  if(name.includes('desktop')||name.includes('application'))return 'Inspect or control the selected computer’s desktop or application as described below.';
  if(name.includes('browser'))return 'Inspect or interact with the browser using the exact target and action below.';
  if(name.includes('delete'))return 'Delete the listed files. Review the exact paths and recovery options.';
  if(name.includes('move'))return 'Move the listed files to the specified destinations.';
  if(actionAccess(name)==='read')return 'Read or inspect the requested content without approving file changes.';
  return 'Create or change content using the exact arguments below.';
}

export type PendingAction={id:string;name:string;args:unknown;deviceName:string;expires:number;access:'read'|'write'};
