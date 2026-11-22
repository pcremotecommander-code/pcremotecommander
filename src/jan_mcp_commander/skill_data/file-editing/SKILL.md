---
name: file-editing
description: "Preview and verify a hash-checked text edit."
metadata:
  version: "1.0.0"
---

# File editing

## When to use

Preview and verify a hash-checked text edit.

## Required PCRC tools

`read_file_excerpt`, `inspect_file`, `preview_file_edit`, `apply_file_edit`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Read the exact affected text and hash. Show the proposed patch, apply the exact approved edit once, and reopen to verify its content. Refresh the preview if the hash changes.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Replace one test setting in an approved workspace file.
