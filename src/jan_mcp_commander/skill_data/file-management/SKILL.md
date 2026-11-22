---
name: file-management
description: "Inspect, move, or remove workspace files with recovery."
metadata:
  version: "1.0.0"
---

# File management

## When to use

Inspect, move, or remove workspace files with recovery.

## Required PCRC tools

`inspect_file`, `move_files_bulk`, `delete_files_bulk`, `restore_file_backup`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

List exact targets and inspect their hashes. Preview the file operation where available and request approval before applying it. Verify final paths and retain backup IDs.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Move reviewed reports into an archive folder.
