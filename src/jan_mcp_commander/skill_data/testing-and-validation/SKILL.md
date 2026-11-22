---
name: testing-and-validation
description: "Run and interpret the smallest relevant approved project test."
metadata:
  version: "1.0.0"
---

# Testing and validation

## When to use

Run and interpret the smallest relevant approved project test.

## Required PCRC tools

`read_file_excerpt`, `start_process`, `read_process_output`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Identify the test command from project configuration, review its scope and obtain approval, then run it with a deadline. Report pass, failure, skips and exit status.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Run the specific regression test after a patch.
