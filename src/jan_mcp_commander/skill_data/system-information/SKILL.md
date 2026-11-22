---
name: system-information
description: "Collect OS, runtime and available workspace information."
metadata:
  version: "1.0.0"
---

# System information

## When to use

Collect OS, runtime and available workspace information.

## Required PCRC tools

`get_connection_status`, `run_diagnostic`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Request only the needed facts; use uname, python_version or disk_usage for the matching question. Report what came from each check.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Report the OS and managed Python version.
