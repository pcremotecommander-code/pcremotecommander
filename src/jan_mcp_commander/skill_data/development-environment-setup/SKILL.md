---
name: development-environment-setup
description: "Inspect and prepare a project Python environment."
metadata:
  version: "1.0.0"
---

# Development environment setup

## When to use

Inspect and prepare a project Python environment.

## Required PCRC tools

`inspect_development`, `preview_development_change`, `apply_development_change`, `get_development_change`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Identify the project runtime and preview the exact environment operation. Request approval before applying and read back the resulting environment and receipt.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Create an approved project-local Python environment.
