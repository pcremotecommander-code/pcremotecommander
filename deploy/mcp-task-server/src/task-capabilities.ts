export const developmentTools=new Set(['inspect_development', 'preview_development_change', 'apply_development_change', 'get_development_change', 'jan_inspect_development', 'jan_preview_development_change', 'jan_apply_development_change', 'jan_get_development_change']);
export type Capability = 'files' | 'commands' | 'browser' | 'desktop';
export const required: Record<string, Capability> = {
  jan_inspect_development:'commands',jan_preview_development_change:'commands',jan_apply_development_change:'commands',jan_get_development_change:'commands',
  inspect_development:'commands',preview_development_change:'commands',apply_development_change:'commands',get_development_change:'commands',
  jan_list_applications:'commands',jan_open_application:'commands',jan_run_command:'commands',jan_start_process:'commands',jan_start_program:'commands',jan_process_input:'commands',jan_process_output:'commands',jan_session_output:'commands',jan_stop_session:'commands',jan_list_sessions:'commands',jan_start_session:'commands',
  jan_write_text:'files',jan_edit_text:'files',jan_move_text:'files',jan_delete_text:'files',jan_restore_backup:'files',jan_skill_feedback:'files',jan_browser:'browser',jan_desktop:'desktop',
  jan_inspect_document_pdf:'files',jan_preview_document_workflow:'files',jan_apply_document_workflow:'files',jan_get_document_workflow:'files',jan_inspect_office:'files',jan_preview_spreadsheet:'files',jan_edit_spreadsheet:'files',
  inspect_document_pdf:'files',preview_document_workflow:'files',apply_document_workflow:'files',get_document_workflow:'files',
  inspect_office_document: 'files', preview_spreadsheet_edit: 'files', apply_spreadsheet_edit: 'files', read_pdf: 'files', rewrite_pdf: 'files', create_pdf: 'files', create_directory: 'files', set_config_value: 'files',
  list_processes: 'commands', force_terminate: 'commands', shutdown: 'commands',
  inspect_media:'files',edit_media:'files',transcribe_audio:'files',prepare_media:'commands',
  preview_file_edit: 'files', apply_file_edit: 'files', create_text_file: 'files', move_files_bulk: 'files',
  delete_files_bulk: 'files', restore_file_backup: 'files', run_command: 'commands', start_process: 'commands',
  list_applications: 'commands', open_application: 'commands', start_program: 'commands', read_process_output: 'commands', send_process_input: 'commands', stop_process: 'commands',
  list_browser_tabs: 'browser', inspect_browser_page: 'browser', capture_browser: 'browser', navigate_browser: 'browser', interact_browser: 'browser', manage_browser_tab: 'browser',
  capture_desktop: 'desktop', interact_desktop: 'desktop', inspect_desktop_controls:'desktop', interact_desktop_control:'desktop',
  jan_inspect_desktop_controls:'desktop',jan_interact_desktop_control:'desktop',
  create_task: 'files', claim_task: 'files', renew_task: 'files', finish_task: 'files', reconcile_task: 'files',
  teach_browser_workflow: 'browser', publish_workflow: 'browser', delete_workflow: 'browser', start_workflow_run: 'browser', run_workflow_step: 'browser',
};
