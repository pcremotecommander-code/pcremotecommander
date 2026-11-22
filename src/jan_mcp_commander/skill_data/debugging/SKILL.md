---
name: debugging
description: "Investigate a reproducible project error using code and logs."
metadata:
  version: "1.0.0"
---

# Debugging

## When to use

Investigate a reproducible project error using code and logs.

## Required PCRC tools

`read_process_output`, `search_workspace`, `read_file_excerpt`, `preview_file_edit`, `apply_file_edit`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Capture the smallest failing case, inspect the affected code, preview the minimal fix and wait for edit approval. Reopen the modified file and verify with the failing check.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Fix a regression in a disposable test project.
