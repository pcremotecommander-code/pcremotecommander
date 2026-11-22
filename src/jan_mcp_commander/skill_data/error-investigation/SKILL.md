---
name: error-investigation
description: "Explain a PCRC error using sanitized activity and bounded results."
metadata:
  version: "1.0.0"
---

# Error investigation

## When to use

Explain a PCRC error using sanitized activity and bounded results.

## Required PCRC tools

`get_recent_activity`, `get_connection_status`, `read_process_output`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Correlate the exact error and time with relevant metadata. Read only the matching owned output and redact sensitive details. Inspect state before retrying uncertain operations.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Explain a timed-out test process without replaying it.
