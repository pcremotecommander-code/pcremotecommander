# PC Remote Commander 0.7.0-beta.45

**Published on the PCRC website and npm.** This Windows keyboard update improves shortcut dispatch, adds printable Unicode typing, and verifies the focused control against the fresh screenshot before sending keys.

## What changed

- `interact_desktop` uses scan codes for supported Windows shortcuts and handles Unicode in the Windows text input path.
- A keyboard receipt shows `dispatched` and `application_verified: false`. Use a fresh screenshot, accessibility inspection, or saved-output readback to verify the result.
- Windows keyboard input stops when focus checks fail. An incomplete dispatch reports uncertainty and attempts key release where applicable. Check the app state before sending more input.
- The Windows and POSIX launchers now select the versioned beta.45 runtime with pinned checksums.

## Verified results

- Public Windows beta.45 via the authenticated relay. Home and Shift+End selected the previous synthetic value. PCRC typed a mixed-case replacement with an accented character and an emoji, then saved and reopened the exact value.
- Process cleanup passed and the reviewed expired QA reservation released its resource. Public file tests also verified edit preview and apply, readback, stale-hash rejection, and scoped search.
- CPU PyTorch 2.15.0+cpu and NumPy 2.5.4 worked together in a separate Python 3.14 test environment through PCRC. Both returned the expected dot product, 14.0. Dependencies are installed per project. GPU validation is pending.
- Source suite: 569 passed, 14 skipped. Packaged MCP checks: 33 passed. Launcher checks: 8 passed. Gateway checks: 291 passed, 3 skipped.
- All nine website downloads matched their staged checksums. The npm beta tag, archive integrity, and five package files matched the release.

The full fresh 80-tool audit on beta.45 is pending. The older combined beta.43 and beta.44 evidence is historical coverage. Minecraft and fresh Linux/macOS desktop acceptance were outside this release's live keyboard test.

## Get the update

Run `npx --yes pcremotecommander@beta setup` on your PC, or use [Start-PCRC.cmd](https://pc-remote-commander.pcremotecommander.workers.dev/install/Start-PCRC.cmd). Restart the old PCRC session first. [Setup and connector instructions](install.md).

## Tool-by-tool reference

This list covers the full 80-tool public catalog. Availability depends on the permissions and runtime of the selected device. The release changes one tool. An unchanged entry describes its current purpose and makes no new beta.45 test claim.

| Tool | What it does | Beta.45 change |
| --- | --- | --- |
| `apply_development_change` | Apply the exact reviewed development plan once. | Unchanged. |
| `apply_document_workflow` | Start exactly one reviewed document plan once and return applying; poll get_document_workflow without resubmitting. | Unchanged. |
| `apply_file_edit` | Apply one previously reviewed exact replacement to a workspace file. | Unchanged. |
| `apply_spreadsheet_edit` | Apply the exact reviewed XLSX cell changes after approval. | Unchanged. |
| `capture_browser` | Capture the isolated browser page as an image. | Unchanged. |
| `capture_desktop` | Capture the current Windows desktop frame under the local desktop capability. | Unchanged. |
| `claim_task` | Reserve or queue a task for up to 120 seconds. | Unchanged. |
| `compare_files` | Compare two small UTF-8 workspace files for a quick review. | Unchanged. |
| `create_directory` | Create a single directory under an existing approved workspace parent. | Unchanged. |
| `create_pdf` | Create a searchable plain-text PDF from reviewed text. | Unchanged. |
| `create_task` | Create a shared task for one assistant. | Unchanged. |
| `create_text_file` | Create one bounded UTF-8 file inside the approved workspace. | Unchanged. |
| `delete_files_bulk` | Delete up to ten reviewed workspace text files with recovery backups. | Unchanged. |
| `delete_workflow` | Delete a saved workflow definition after user approval. | Unchanged. |
| `diagnose_connection` | Check PCRC device and authorization status through the gateway. | Unchanged. |
| `edit_media` | Save a resized/rotated JPG, trimmed mono WAV or MP4 clip. | Unchanged. |
| `finish_task` | Finish a verified assignment or return it to queued for handoff. | Unchanged. |
| `force_terminate` | Force-stop one PCRC-owned process tree by session ID after approval. | Unchanged. |
| `get_action_result` | Check the result of a previously submitted website approval. | Unchanged. |
| `get_capabilities` | Check the current local capability lease before trying file edits, commands, browser, or desktop control. | Unchanged. |
| `get_config` | Read the PCRC search page size. | Unchanged. |
| `get_connection_status` | Inspect this computer, approved workspace and backend status. | Unchanged. |
| `get_development_change` | Read development review/receipt. | Unchanged. |
| `get_document_workflow` | Read the durable receipt of a previewed/applied document plan, including partial failures. | Unchanged. |
| `get_more_search_results` | Read another result page. | Unchanged. |
| `get_privacy_policy` | Read PCRC privacy protections and their limits. | Unchanged. |
| `get_recent_activity` | Show recent tool names, outcomes and latency for troubleshooting. | Unchanged. |
| `inspect_browser_page` | Inspect the active controlled browser page before clicking or typing. | Unchanged. |
| `inspect_desktop_controls` | Inspect at most 128 nodes and return up to 40 actionable controls in the active Windows window. | Unchanged. |
| `inspect_development` | Discover full Python separately from PCRC; inspect managed project environments, dependency files, installed packages and imports. | Unchanged. |
| `inspect_document_pdf` | Read bounded PDF text and render every page in an isolated process. | Unchanged. |
| `inspect_file` | Get metadata for a workspace file before reading, editing, moving, or deleting it. | Unchanged. |
| `inspect_media` | Inspect an image, audio metrics or two video frames. | Unchanged. |
| `inspect_office_document` | Inspect bounded local DOCX paragraphs or XLSX cells without starting Office. | Unchanged. |
| `inspect_workflow` | Read recorded steps before publishing, or inspect a run after each step. | Unchanged. |
| `interact_browser` | Click, fill, press, select, or check one selector in the isolated browser after inspecting the page and obtaining user approval. | Unchanged. |
| `interact_desktop` | Click, move, drag, scroll, type, or send shortcuts in the foreground with a fresh frame and approval. | Windows Unicode typing, shortcut scan codes, focus checks, and dispatch receipts. |
| `interact_desktop_control` | Invoke a button or set a non-protected field value by control_id from a fresh inspection, after user approval. | Unchanged. |
| `list_applications` | Find registered apps by name and return bounded app IDs. | Unchanged. |
| `list_browser_tabs` | List tabs in the locally controlled browser session. | Unchanged. |
| `list_processes` | List PCRC-owned command sessions and their state. | Unchanged. |
| `list_searches` | List active search snapshots on this PCRC instance. | Unchanged. |
| `list_skill_packs` | List PCRC workflow packs and their included skills. | Unchanged. |
| `list_tasks` | Inspect shared assignments, reserved resources, handoff notes and uncertain outcomes. | Unchanged. |
| `list_workflows` | List saved local browser workflow drafts and published workflows. | Unchanged. |
| `list_workspace_entries` | List one approved workspace folder. | Unchanged. |
| `manage_browser_tab` | Go back, forward, reload, open a new tab, select or close a tab, or close the isolated browser. | Unchanged. |
| `move_files_bulk` | Move up to ten reviewed workspace text files. | Unchanged. |
| `navigate_browser` | Navigate the controlled browser to an HTTP(S) URL after user approval. | Unchanged. |
| `open_application` | Open a registered app by exact app ID or unambiguous name after approval. | Unchanged. |
| `prepare_media` | Install original pinned third-party PyPI packages (~88 MB), retaining their licenses, and optionally the MIT speech model (~70 MB). | Unchanged. |
| `preview_development_change` | Prepare a reviewed project Python change. | Unchanged. |
| `preview_document_workflow` | Prepare a combined review of 1..5 DOCX edits, template fills, Word-to-PDF exports, formatted Markdown PDFs, exact PDF page sequences or table-to-CSV extractions. | Unchanged. |
| `preview_file_edit` | Preview one exact text replacement without saving. | Unchanged. |
| `preview_spreadsheet_edit` | Preview exact before/after cells and supported formulas in an XLSX sheet. | Unchanged. |
| `publish_workflow` | Publish a reviewed browser draft and its expected visible completion text. | Unchanged. |
| `read_file_excerpt` | Read a bounded UTF-8 workspace file. | Unchanged. |
| `read_multiple_files` | Read up to ten bounded UTF-8 workspace files. | Unchanged. |
| `read_pdf` | Read workspace PDF text without Word. | Unchanged. |
| `read_process_output` | Read bounded output and state from an owned process. | Unchanged. |
| `reconcile_task` | Release an expired/uncertain reservation only after the user reviews actual file/process/UI state. | Unchanged. |
| `renew_task` | Renew an active or waiting assignment before its 120-second expiry; check the returned status. | Unchanged. |
| `restore_file_backup` | Restore one workspace backup by backup ID after reviewing the intended recovery target. | Unchanged. |
| `rewrite_pdf` | Save selected one-based pages, optionally rotated. | Unchanged. |
| `run_command` | Run one approved OS-account command, at most 4096 characters, with a short timeout. | Unchanged. |
| `run_diagnostic` | Run a named read-only diagnostic or allowlisted profile. | Unchanged. |
| `run_workflow_step` | Execute exactly the next reviewed browser step after user approval. | Unchanged. |
| `search_workspace` | Find filenames or matching text in the approved workspace. | Unchanged. |
| `send_process_input` | Send text to an owned process after user approval; avoid passwords and secrets. | Unchanged. |
| `set_config_value` | Change the search page size for new snapshots until this runtime restarts. | Unchanged. |
| `shutdown` | Shut down PCRC computer control, stop its owned processes and close its controlled browser. | Unchanged. |
| `start_process` | Start a command session after user approval, at most 4096 characters. | Unchanged. |
| `start_program` | Start an absolute executable with exact arguments, without a shell. | Unchanged. |
| `start_workflow_run` | Create a run from a reviewed published browser workflow, under an assigned ui reservation. | Unchanged. |
| `stop_process` | Stop an owned command session by ID. | Unchanged. |
| `stop_search` | Stop a paginated search and discard its snapshot. | Unchanged. |
| `suggest_workflow` | Get a read-only workflow suggestion for a user goal. | Unchanged. |
| `teach_browser_workflow` | Start, finish into a draft, or cancel a user demonstration in the isolated browser. | Unchanged. |
| `transcribe_audio` | Transcribe up to 30 seconds locally using the optional tiny speech model. | Unchanged. |
| `who_am_i` | Show the authenticated PCRC account on the public gateway, or the local connection type. | Unchanged. |
