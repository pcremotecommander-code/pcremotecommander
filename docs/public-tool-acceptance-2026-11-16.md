# PCRC public tool acceptance — 16 November 2026

Runtime: published 0.7.0-beta.43 on Windows. Tests used the authenticated public gateway and secure device relay, with disposable synthetic files only.

## Result

79 PASS, 1 PARTIAL, 0 NOT TESTED across the 80 exposed tools. PASS means the representative operation and its relevant readback/receipt succeeded; it does not certify every sub-action, platform or security scenario.

The remaining partial result is screenshot-based desktop interaction: click and literal typing execute, but the published Windows hotkey path failed the synthetic selection-and-replacement check. The corrected private source and embedded-Python bundle both saved exactly PCRC_Ab9Z! in the same fresh-frame guarded test. The runtime fix is not published. Shutdown passed: control became disabled and a subsequent synthetic write was rejected with CAPABILITY_DISABLED. A local PCRC restart is required.

## Fixes and verification

- Gateway document reviews: generic privacy depth counted the MCP wrappers twice. The fix scans all structured data, text, non-text blocks and metadata while retaining semantic-depth, node, size and secret checks. Production Worker version 66631286-fb80-4d1d-8ea6-b88383f73fb5 is deployed. A fresh public combined review/apply completed five jobs; all six DOCX/PDF/CSV outputs were reopened and verified. No uncertain application was replayed.
- Windows keyboard: navigation virtual keys were sent without their extended-key flags. On this host MapVirtualKeyW(End,4) returns 0x4F, so relying on an E0 prefix alone was insufficient. The candidate explicitly marks extended navigation keys, retains fail-safe/fresh-frame/foreground checks, and releases keys after a partial SendInput without replay. Independent review found no blocker.
- Focused Windows tests: 37 passed, exit 0. Full Python suite: 569 passed, 13 skipped, exit 0; four pypdf deprecation warnings. An initial missing-vendor-binary failure was corrected by restoring existing release artifacts; the integrity/provenance suite then passed 17 tests without skipping that check.
- Gateway suite: 291 passed, 5 skipped, 0 failed; TypeScript check exit 0. Both gateway and keyboard changes received independent review.
- Private candidate build: 2,376 manifest files verified; install/doctor passed. Packaged client catalog/search/development checks: 33 passed, 0 skipped, exit 0. Packaged MCP smoke passed task conflicts, exact edits, stale-hash rejection, recovery, identity, resources and prompts. This is private bundle evidence, not a newly published runtime.
- Public Python development tools created a separate project .venv using full Python 3.14.7, verified pip/venv/ensurepip and imports, and returned pip check exit 0. PCRC's embedded runtime was unchanged.
- Browser recording: observed click → reviewed two-step draft → published → replayed once → final URL and expected text passed. Synthetic workflow deleted and UI lease released.
- Website approval: OAuth/PKCE passed; exact synthetic PowerShell marker waited for approval, then returned exit 0. Repeated receipt lookup matched. Evidence: work/beta43-website-approval-qa.json.
- Spoken-audio fixture: offline transcription returned all three expected English sentences and language confidence 0.99828. This does not certify general transcription accuracy.
- File/document/media checks included readback hashes, split-run Word edits, template fill, table CSV extraction, XLSX formula preservation, PDF page reordering and rendering, image dimensions/format, WAV trimming and MP4 frames/audio.
- Notepad launch was acknowledged; separate process/window metadata verified a visible Notepad window. No existing document contents were read or windows closed.

## Tool matrix

Median seconds includes public round-trip overhead among successful calls in this run; tools with different inputs are not directly comparable. Approval receipt timing is recorded by its separate OAuth QA client.

| Tool | Result | Median seconds |
| --- | --- | --- |
| apply_development_change | PASS | 4.94 |
| apply_document_workflow | PASS | 5.39 |
| apply_file_edit | PASS | 4.92 |
| apply_spreadsheet_edit | PASS | 6.29 |
| capture_browser | PASS | 5.16 |
| capture_desktop | PASS | 5.15 |
| claim_task | PASS | 4.87 |
| compare_files | PASS | 5.02 |
| create_directory | PASS | 5.02 |
| create_pdf | PASS | 7.52 |
| create_task | PASS | 4.98 |
| create_text_file | PASS | 5.53 |
| delete_files_bulk | PASS | 4.81 |
| delete_workflow | PASS | 4.87 |
| diagnose_connection | PASS | 8.95 |
| edit_media | PASS | 7.92 |
| finish_task | PASS | 5.05 |
| force_terminate | PASS | 5.19 |
| get_action_result | PASS | — |
| get_capabilities | PASS | 5.36 |
| get_config | PASS | 4.99 |
| get_connection_status | PASS | 5.03 |
| get_development_change | PASS | 5.91 |
| get_document_workflow | PASS | 5.09 |
| get_more_search_results | PASS | 5.15 |
| get_privacy_policy | PASS | 4.44 |
| get_recent_activity | PASS | 4.83 |
| inspect_browser_page | PASS | 4.92 |
| inspect_desktop_controls | PASS | 5.51 |
| inspect_development | PASS | 5.91 |
| inspect_document_pdf | PASS | 6.64 |
| inspect_file | PASS | 4.80 |
| inspect_media | PASS | 8.43 |
| inspect_office_document | PASS | 6.21 |
| inspect_workflow | PASS | 5.03 |
| interact_browser | PASS | 5.58 |
| interact_desktop | PARTIAL | 5.11 |
| interact_desktop_control | PASS | 5.75 |
| list_applications | PASS | 9.12 |
| list_browser_tabs | PASS | 4.83 |
| list_processes | PASS | 4.99 |
| list_searches | PASS | 4.49 |
| list_skill_packs | PASS | 5.23 |
| list_tasks | PASS | 5.23 |
| list_workflows | PASS | 4.59 |
| list_workspace_entries | PASS | 4.92 |
| manage_browser_tab | PASS | 5.02 |
| move_files_bulk | PASS | 5.07 |
| navigate_browser | PASS | 5.02 |
| open_application | PASS | 8.40 |
| prepare_media | PASS | 9.06 |
| preview_development_change | PASS | 5.05 |
| preview_document_workflow | PASS | 4.96 |
| preview_file_edit | PASS | 5.34 |
| preview_spreadsheet_edit | PASS | 6.34 |
| publish_workflow | PASS | 4.63 |
| read_file_excerpt | PASS | 4.83 |
| read_multiple_files | PASS | 4.77 |
| read_pdf | PASS | 10.05 |
| read_process_output | PASS | 4.96 |
| reconcile_task | PASS | 6.01 |
| renew_task | PASS | 4.96 |
| restore_file_backup | PASS | 4.84 |
| rewrite_pdf | PASS | 7.85 |
| run_command | PASS | 5.71 |
| run_diagnostic | PASS | 4.97 |
| run_workflow_step | PASS | 5.88 |
| search_workspace | PASS | 4.81 |
| send_process_input | PASS | 4.54 |
| set_config_value | PASS | 4.97 |
| shutdown | PASS | 4.92 |
| start_process | PASS | 5.02 |
| start_program | PASS | 4.93 |
| start_workflow_run | PASS | 9.25 |
| stop_process | PASS | 4.98 |
| stop_search | PASS | 5.03 |
| suggest_workflow | PASS | 10.84 |
| teach_browser_workflow | PASS | 4.83 |
| transcribe_audio | PASS | 8.90 |
| who_am_i | PASS | 5.07 |

## Limits and remaining risks

- Transient connector Internal error / selected-device-offline responses occurred. Safe status retries recovered without reauthentication; long-duration stability and root cause remain unverified. One uncertain process launch was not retried until both the owned-session list and synthetic output state showed no execution.
- No performance improvement or regression percentage is claimed: there is no equivalent prior-build benchmark. Typical public call overhead is several seconds; per-tool medians above are observations only.
- Commands run as the OS account; os_sandbox is false. Privacy checks and AMSI are not universal secret or malware detection. Screenshots can contain visible private information.
- Spreadsheet formulas are preserved, not calculated. Native Linux/macOS clean installs, sustained load/reconnect, broad concurrent-assistant stress, live cross-account security acceptance and installer publisher signing were not verified by this run.
- Skill discovery/suggestion passed; every workflow pack was not executed end to end. Real billing, refund, account deletion, password-reset delivery and OS shutdown were excluded.
- Original and private packaged keyboard candidates passed, but published beta.43 still contains the older hotkey implementation. A versioned runtime release and public-client retest are needed before marking interact_desktop PASS.

## Evidence and data minimization

Synthetic files are retained under pcrc-public-acceptance-20261116-7d3a for review; remove them only when no longer needed. Tool payloads, account identifiers, OAuth tokens and lease tokens are omitted from this report. Local acceptance records use only tool names, statuses, timings and synthetic verification outcomes. The OAuth helper keeps credentials in process memory and writes a sanitized result, then expires its listener after 15 minutes. No new durable product data store was added.

## Changed source files

- deploy/cloudflare/worker/src/policy.ts
- deploy/cloudflare/worker/tests/privacy-gateway.test.mjs
- src/jan_mcp_commander/control.py
- src/jan_mcp_commander/windows_input.py
- tests/test_control.py
- tests/test_windows_input.py
- docs/public-tool-acceptance-2026-11-16.md

Public-source main has not been promoted. The gateway hotfix is deployed; the Windows runtime candidate is private.

Final report note: the checkpoint was saved and reopened through public PCRC before shutdown. This final source report includes the subsequent shutdown result; its updated copy has not been read back through the now-disabled agent.

