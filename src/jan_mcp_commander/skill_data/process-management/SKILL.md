---
name: process-management
description: "Inspect or manage PCRC-owned process sessions."
metadata:
  version: "1.0.0"
---

# Process management

## When to use

Inspect or manage PCRC-owned process sessions.

## Required PCRC tools

`list_processes`, `read_process_output`, `stop_process`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Match the owned process ID and read bounded output. After approval, stop only that session and inspect the exit state.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Stop a PCRC test session that exceeded its deadline.
