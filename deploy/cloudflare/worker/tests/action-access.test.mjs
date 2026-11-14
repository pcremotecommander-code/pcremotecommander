import test from 'node:test';
import assert from 'node:assert/strict';
import {requiresActionReview,actionAccess} from '../src/action_access.ts';
import {controlRequired} from '../src/policy.ts';
import {CONTROL_CATALOG_READ_TOOLS} from '../src/relay_protocol.ts';

test('development inspection and receipts use read routing; environment changes still need approval',()=>{
 for(const name of ['inspect_development','get_development_change']){
  assert.equal(CONTROL_CATALOG_READ_TOOLS.has(name),true,name);
  assert.equal(actionAccess(name),'read',name);
  assert.equal(requiresActionReview(name),false,name);
 }
 for(const name of ['preview_development_change','apply_development_change']){
  assert.equal(CONTROL_CATALOG_READ_TOOLS.has(name),false,name);
  assert.equal(actionAccess(name),'write',name);
  assert.equal(requiresActionReview(name),true,name);
 }
});

test('accessibility labels and actions keep desktop control scope and correct dashboard access',()=>{
 for(const name of ['inspect_desktop_controls','interact_desktop_control','jan_inspect_desktop_controls','jan_interact_desktop_control'])
  assert.equal(controlRequired(new TextEncoder().encode(JSON.stringify({jsonrpc:'2.0',method:'tools/call',params:{name,arguments:{confirmed:true}}}))),true);
 assert.equal(actionAccess('inspect_desktop_controls'),'read');
 assert.equal(actionAccess('interact_desktop_control'),'write');
 assert.equal(requiresActionReview('inspect_desktop_controls'),false);
 assert.equal(requiresActionReview('interact_desktop_control'),false);
});

test('routine workspace, document and UI tools avoid high-risk dashboard warnings',()=>{
  for(const name of ['edit_media','apply_file_edit','apply_spreadsheet_edit','rewrite_pdf','restore_file_backup','move_files_bulk','capture_browser','capture_desktop','inspect_browser_page','navigate_browser','interact_browser','manage_browser_tab','interact_desktop','open_application','create_task','claim_task','renew_task','finish_task','reconcile_task','read_process_output','stop_process'])
    assert.equal(requiresActionReview(name),false,name);
});

test('arbitrary execution, bulk deletion, settings and unknown tools show high-risk dashboard warnings',()=>{
  for(const name of ['run_command','start_process','start_program','send_process_input','force_terminate','delete_files_bulk','set_config_value','shutdown','unknown_new_tool'])
    assert.equal(requiresActionReview(name),true,name);
});
