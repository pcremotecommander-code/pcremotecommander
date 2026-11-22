---
name: application-management
description: "Find and open an installed application on the selected PC."
metadata:
  version: "1.0.0"
---

# Application management

## When to use

Find and open an installed application on the selected PC.

## Required PCRC tools

`list_applications`, `open_application`, `inspect_desktop_controls`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Match its registered ID. Ask before opening the app, then inspect the active window or report that its appearance is unverified.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Open the installed calculator and check its window.
