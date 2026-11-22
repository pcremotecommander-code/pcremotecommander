---
name: desktop-automation
description: "Inspect and operate a supported desktop control on the active window."
metadata:
  version: "1.0.0"
---

# Desktop automation

## When to use

Inspect and operate a supported desktop control on the active window.

## Required PCRC tools

`inspect_desktop_controls`, `interact_desktop_control`, `capture_desktop`, `interact_desktop`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Identify the exact foreground window and control, obtain approval for the input, and use the fresh identifier. If unavailable, obtain a fresh frame and explicit target. Verify with new readback; stop on focus changes or protected controls.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Activate a named button in a disposable document window.
