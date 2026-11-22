---
name: code-execution
description: "Run a reviewed program inside an approved project workspace."
metadata:
  version: "1.0.0"
---

# Code execution

## When to use

Run a reviewed program inside an approved project workspace.

## Required PCRC tools

`get_capabilities`, `inspect_file`, `start_program`, `read_process_output`, `stop_process`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Confirm entry point, arguments, working directory and timeout. After approval, start one bounded session and read output until it completes. Report exit status.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Run an approved synthetic project script.
