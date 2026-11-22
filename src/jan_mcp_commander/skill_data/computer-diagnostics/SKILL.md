---
name: computer-diagnostics
description: "Diagnose a reported problem on the selected PCRC computer."
metadata:
  version: "1.0.0"
---

# Computer diagnostics

## When to use

Diagnose a reported problem on the selected PCRC computer.

## Required PCRC tools

`get_connection_status`, `get_capabilities`, `run_diagnostic`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Confirm the selected computer; choose only the applicable named diagnostic and compare its output with the reported symptom.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Check disk usage when a local build reports insufficient space.
