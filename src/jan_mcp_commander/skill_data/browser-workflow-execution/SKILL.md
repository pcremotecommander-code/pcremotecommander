---
name: browser-workflow-execution
description: "Replay an approved browser workflow with fresh state checks."
metadata:
  version: "1.0.0"
---

# Browser workflow execution

## When to use

Replay an approved browser workflow with fresh state checks.

## Required PCRC tools

`inspect_workflow`, `start_workflow_run`, `run_workflow_step`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Review the workflow, inputs and permissions. Obtain the active reservation, initialize the run and execute one approved step at a time. Inspect failures and state before retries.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Replay a reviewed browser smoke workflow.
