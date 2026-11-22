---
name: system-troubleshooting
description: "Investigate a local resource or runtime problem with bounded diagnostics."
metadata:
  version: "1.0.0"
---

# System troubleshooting

## When to use

Investigate a local resource or runtime problem with bounded diagnostics.

## Required PCRC tools

`get_connection_status`, `run_diagnostic`, `list_processes`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Check the affected workspace, named diagnostics and owned processes. Report evidence before proposing a change. Stop if the fault cannot be isolated.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Investigate a local test run that stalled.
