# PCRC workflow reference

## Connection and permissions

Call `jan_status` then `jan_diagnostic(name="python_version")`. Read `transport`, workspace and `control_seconds_remaining`. An HTTP listener or connector readiness is not an end-to-end ChatGPT health assertion. Desktop/browser/commands/files require corresponding local grants; mutation tools also require the remote control scope. Skills never grant either.

## MCP examples

- Catalog: `jan_skills()`; guide: `jan_skill_guide()`.
- Suggest only: `jan_route_skill(request="inspect disk space")`.
- Explicit override: `jan_route_skill(request="edit and run", skill="file-editing")`.
- Files: `jan_list_files(path=".")`, `jan_read_text(path="notes.txt")`, `jan_file_info(path="notes.txt")`.
- Edit: use `jan_edit_text` with the current SHA256, literal old/new text and `dry_run=true`; apply an authorized preview with `dry_run=false`, then read back. Use returned backup ID for recovery.
- Storage: `jan_run_profile(name="disk_usage")`. This does not delete files.
- Harmless command check: `jan_run_command(command="echo PCRC_OK")`, with an active commands grant. Prefer `jan_start_program` with an absolute executable and argv for quoting-sensitive work.
- Processes: `jan_start_process`, `jan_process_input`, `jan_process_output`, `jan_session_output`, `jan_list_sessions`, `jan_stop_session`. Input is piped; inspect actual output before claiming delivery.
- Browser: `jan_browser(action="open", target="http://127.0.0.1:8867/")`, snapshot, then fill/click/check with unique CSS selectors. The local preview must already be running. Browser context is separate from normal login profiles.
- Desktop: `jan_desktop(action="screenshot")` returns resized image/native dimensions and a `frame_id`. After visual target verification, pass it to one input call, such as `jan_desktop(action="click", x=..., y=..., frame_id="...")`. Token lifetime is 30 seconds; changed Windows foreground or screen dimensions deny input. This is a best-effort guard, not window or OS isolation. X11 focus tracking remains unverified; Wayland is unsupported.

## Local CLI examples

Use the installed venv executables; replace WORKSPACE with the approved existing directory. On Windows use `.venv\Scripts\jan-mcp.exe`; on Linux use `.venv/bin/jan-mcp`.

```text
jan-mcp --workspace WORKSPACE --json --command "list files"
jan-mcp --workspace WORKSPACE --json --command "read file notes.txt"
jan-mcp --workspace WORKSPACE --json --command "disk usage"
jan-mcp --workspace WORKSPACE --allow-writes --json --command "write file notes.txt" --content "hello"
jan-mcp skills list
jan-mcp skills guide
jan-mcp skills route "inspect disk space"
jan-mcp skills route "edit and run" --skill file-editing
jan-mcp --workspace WORKSPACE skills feedback status
jan-mcp --workspace WORKSPACE skills feedback enable
jan-mcp --workspace WORKSPACE skills feedback record --category file-editing --skill file-editing --method rules --outcome success
jan-mcp --workspace WORKSPACE skills feedback clear
```

For control CLI use `jan-mcp-control --workspace WORKSPACE --capabilities files,commands --duration-minutes 10`; submit JSON lines like `{"tool":"jan_status","arguments":{}}` and `{"tool":"jan_run_command","arguments":{"command":"echo PCRC_OK"}}`. `exit` closes owned sessions. For one shot add `--tool jan_run_command --arguments JSON` with platform-appropriate quoting. Normal-user execution is required. Shell/profile names are fixed enums; do not infer unsupported tools from these examples.

Logging is disabled until enabled locally. `disable` stops collection; `clear` empties the log and disables it. Optional `--correction` accepts only a catalog skill ID. Use `--reviewed` only for an actual local human review. MCP feedback recording requires a files grant and local opt-in; it cannot mark a record reviewed or enable logging. Logs live in existing private state, not the workspace.

## Installation and discovery

The PCRC Python wheel/source release includes this skill. `jan-mcp skills export --destination PATH` copies it to a new explicit folder and refuses existing destinations. For a Codex project, use an appropriate `.agents/skills/pcrc-commander` destination. For a different host, follow that host's supported skill/plugin installation mechanism. A ChatGPT custom MCP connection exposes tools; returning SKILL.md through `jan_skill_guide` does not install the skill. This environment's separately saved Skills-page copy is independent of the user's Windows/Ubuntu installation. Do not claim all assistant hosts discover local files automatically.

## Troubleshooting and limits

- Browser unavailable: confirm the selected browser is installed, Windows ProgramFiles variables are present in the normal-user launcher, and the control grant is active. Restart the launcher after upgrading code; a running Python process retains the old implementation.
- Session capacity: stop an active owned job; completed history is bounded separately. No PTY/ConPTY, hard CPU/memory sandbox or detached-process containment is provided.
- Desktop frame denied: inspect a new screenshot, intended application, focus, native dimensions and lease. Never disable the failsafe to make a test pass.
- HTTP/tunnel unavailable: keep the normal-user launcher open, inspect current route/connector status, and update the rotating Quick Tunnel origin only after a restart. Never expose the private service key or weaken consent checks.
- Limits: text 64 KiB; command output 1 MiB with 16 KiB pages; at most four running jobs; local grant expiry terminates owned work. Desktop typing is printable ASCII/primary-screen only.
- Optional classifier: trusted code may supply the selector interface; malformed/unavailable predictions fall back to rules. Ambiguous requests still need clarification. No default model, training pipeline, downloaded weights or permissions integration exists.
