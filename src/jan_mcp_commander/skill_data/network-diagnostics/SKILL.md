---
name: network-diagnostics
description: "Troubleshoot connectivity to the PCRC gateway or paired device."
metadata:
  version: "1.0.0"
---

# Network diagnostics

## When to use

Troubleshoot connectivity to the PCRC gateway or paired device.

## Required PCRC tools

`diagnose_connection`, `get_connection_status`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Compare saved pairing, gateway response and live relay verification. Report the first failing stage. Keep checks limited to the authorized PCRC connection.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Determine whether a PCRC failure is before or after device selection.
