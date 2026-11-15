# PCRC public acceptance follow-up — beta.44

Date: 16 November 2026 (Asia/Calcutta).

## Result and scope

The 80-tool representative acceptance matrix now has successful public execution evidence for every tool: 80 PASS, 0 remaining PARTIAL, 0 FAIL, 0 BLOCKED, 0 NOT TESTED.

This is a combined evidence matrix, not a fresh execution of all 80 tools on beta.44. The earlier published beta.43 run provided 79 representative passes. Its partial Windows desktop hotkey path was fixed and passed this actual published beta.44 retest. The table explicitly identifies retained beta.43 evidence. A representative pass does not certify every sub-action, input, platform, permission mode or deployment.

## Published beta.44 keyboard proof

- get_connection_status confirmed version 0.7.0-beta.44, desktop control enabled and the authenticated public gateway/device relay verified for the call.
- Started only a disposable synthetic PowerShell WinForms fixture through public start_program.
- Accessibility inspection verified its foreground window PID matched the owned process, and identified exactly one Message field and Save draft button. Password/PIN fields were omitted; duplicate controls remained distinct and the disabled button remained disabled.
- Set the synthetic initial value PCRC_BEFORE through a fresh UI Automation inspection.
- Read fixture-generated physical coordinates, captured and visually inspected its fresh foreground-bound frame, then clicked inside the identified field.
- Sent Home, then Shift+End with a new one-use screenshot frame before each action. A subsequent screenshot visibly showed the complete old value selected.
- Typed PCRC_Ab9Z! using that fresh frame, invoked Save draft from a new foreground/PID-checked UI Automation inspection, then reopened saved.txt through public read_file_excerpt.
- Saved contents matched exactly PCRC_Ab9Z! with SHA-256 0d983004dcacc5d0274b05ec2f7356f08ef38e80293fd91607efa13bd583d639.
- Fixture path: pcrc-public-acceptance-20261116-7d3a/beta44-public-keyboard-1794781745236/saved.txt. No old text was appended.
- Closed only the owned fixture using its synthetic command file; process exited normally with code 0. Removed its retained process session. Final checks found zero owned processes and zero held task reservations.
- A final public status check still confirmed beta.44, control enabled and verified relay.

No installed runtime was patched and no private candidate or local helper was substituted for these public tool calls. The existing user approval, capability, task, privacy, fresh-frame and foreground checks stayed active.

## Matrix

PASS means a representative executed operation and its relevant readback or receipt succeeded. “43 baseline” is retained earlier public evidence; “44 follow-up” identifies tools called successfully in this public follow-up. Website approval receipt was verified through the separate authorized public OAuth QA client.

| Tool | Result | Public evidence |
| --- | --- | --- |
| apply_development_change | PASS | 43 baseline |
| apply_document_workflow | PASS | 43 baseline |
| apply_file_edit | PASS | 43 baseline |
| apply_spreadsheet_edit | PASS | 43 baseline |
| capture_browser | PASS | 43 baseline |
| capture_desktop | PASS | 44 follow-up |
| claim_task | PASS | 43 baseline |
| compare_files | PASS | 43 baseline |
| create_directory | PASS | 44 follow-up |
| create_pdf | PASS | 43 baseline |
| create_task | PASS | 43 baseline |
| create_text_file | PASS | 44 follow-up |
| delete_files_bulk | PASS | 43 baseline |
| delete_workflow | PASS | 43 baseline |
| diagnose_connection | PASS | 43 baseline |
| edit_media | PASS | 43 baseline |
| finish_task | PASS | 43 baseline |
| force_terminate | PASS | 43 baseline |
| get_action_result | PASS | 43 baseline |
| get_capabilities | PASS | 43 baseline |
| get_config | PASS | 43 baseline |
| get_connection_status | PASS | 44 follow-up |
| get_development_change | PASS | 43 baseline |
| get_document_workflow | PASS | 43 baseline |
| get_more_search_results | PASS | 43 baseline |
| get_privacy_policy | PASS | 43 baseline |
| get_recent_activity | PASS | 43 baseline |
| inspect_browser_page | PASS | 43 baseline |
| inspect_desktop_controls | PASS | 44 follow-up |
| inspect_development | PASS | 43 baseline |
| inspect_document_pdf | PASS | 43 baseline |
| inspect_file | PASS | 43 baseline |
| inspect_media | PASS | 43 baseline |
| inspect_office_document | PASS | 43 baseline |
| inspect_workflow | PASS | 43 baseline |
| interact_browser | PASS | 43 baseline |
| interact_desktop | PASS | 44 follow-up |
| interact_desktop_control | PASS | 44 follow-up |
| list_applications | PASS | 43 baseline |
| list_browser_tabs | PASS | 43 baseline |
| list_processes | PASS | 44 follow-up |
| list_searches | PASS | 43 baseline |
| list_skill_packs | PASS | 43 baseline |
| list_tasks | PASS | 44 follow-up |
| list_workflows | PASS | 43 baseline |
| list_workspace_entries | PASS | 43 baseline |
| manage_browser_tab | PASS | 43 baseline |
| move_files_bulk | PASS | 43 baseline |
| navigate_browser | PASS | 43 baseline |
| open_application | PASS | 43 baseline |
| prepare_media | PASS | 43 baseline |
| preview_development_change | PASS | 43 baseline |
| preview_document_workflow | PASS | 43 baseline |
| preview_file_edit | PASS | 43 baseline |
| preview_spreadsheet_edit | PASS | 43 baseline |
| publish_workflow | PASS | 43 baseline |
| read_file_excerpt | PASS | 44 follow-up |
| read_multiple_files | PASS | 43 baseline |
| read_pdf | PASS | 43 baseline |
| read_process_output | PASS | 44 follow-up |
| reconcile_task | PASS | 43 baseline |
| renew_task | PASS | 43 baseline |
| restore_file_backup | PASS | 43 baseline |
| rewrite_pdf | PASS | 43 baseline |
| run_command | PASS | 43 baseline |
| run_diagnostic | PASS | 43 baseline |
| run_workflow_step | PASS | 43 baseline |
| search_workspace | PASS | 43 baseline |
| send_process_input | PASS | 43 baseline |
| set_config_value | PASS | 43 baseline |
| shutdown | PASS | 43 baseline |
| start_process | PASS | 43 baseline |
| start_program | PASS | 44 follow-up |
| start_workflow_run | PASS | 43 baseline |
| stop_process | PASS | 44 follow-up |
| stop_search | PASS | 43 baseline |
| suggest_workflow | PASS | 43 baseline |
| teach_browser_workflow | PASS | 43 baseline |
| transcribe_audio | PASS | 43 baseline |
| who_am_i | PASS | 43 baseline |

## Release and regression checks

Beta.44 is independently verified on npm: beta tag, SHA-512 and SHA-1 integrity, and all five package files match the tested staged release. Nine public download checksums match.

Source/control/build/POSIX focused suite: 50 passed, exit 0. Packaged MCP catalog/search/development suite: 33 passed, no skips, exit 0. Thin launcher: 8 passed, no skips, exit 0. Gateway: 291 passed, 3 skipped, 0 failed; TypeScript and production dry run exit 0. Prior full Python run against the same keyboard implementation: 569 passed, 13 skipped, exit 0, before version/pin-only edits. Independent source and release-pin reviews found no blocker. Source credential scan found zero findings.

Changed runtime files: src/jan_mcp_commander/windows_input.py and control.py, with regression tests in tests/test_windows_input.py and test_control.py. Release and gateway changes are listed in beta44-release-report.md. This follow-up changes documentation/evidence only.

## Timing and limits

The two public hotkey calls took about 4.7 and 4.9 seconds; literal typing about 4.9 seconds; exact saved-file readback about 5.1 seconds. These include network/gateway overhead. There is no equivalent earlier-build benchmark, so no improvement or regression percentage is claimed.

This does not establish sustained connection reliability, exhaustive 80-tool coverage, native Linux/macOS acceptance, concurrent multi-assistant load capacity, full live two-account isolation, publisher signing or OS-level command sandboxing. os_sandbox remains false; commands run as the OS account. Spreadsheet formulas are preserved, not recalculated. Screenshot/privacy and malware scanning are not universal protection guarantees. Billing/refunds/cancellations and real account deletion were excluded.

Synthetic QA files are retained for review; existing personal documents were preserved. The report omits account identifiers, lease tokens, authorization URLs and credentials. No new durable product data store was introduced.

Evidence: work/beta44-public-keyboard-acceptance-20261116.json; work/public-tool-acceptance-2026-11-16-final.json; work/beta44-npm-verification.json; work/beta44-public-downloads.json. The earlier baseline report remains a historical checkpoint.

