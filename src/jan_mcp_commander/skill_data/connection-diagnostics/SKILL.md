---
name: connection-diagnostics
description: "Diagnose PCRC authorization, device selection and relay state."
metadata:
  version: "1.0.0"
---

# Connection diagnostics

## When to use

Diagnose PCRC authorization, device selection and relay state.

## Required PCRC tools

`diagnose_connection`, `get_connection_status`, `get_capabilities`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Check account and selected computer status. Distinguish offline, expired authorization and missing capabilities using PCRC evidence. Verify the successful relay call after recovery.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Check why an assistant reports the computer is offline.
