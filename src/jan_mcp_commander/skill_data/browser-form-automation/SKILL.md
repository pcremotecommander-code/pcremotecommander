---
name: browser-form-automation
description: "Review and fill an approved browser form."
metadata:
  version: "1.0.0"
---

# Browser form automation

## When to use

Review and fill an approved browser form.

## Required PCRC tools

`inspect_browser_page`, `interact_browser`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Inspect the page and identify the exact fields. Confirm the proposed values and requested action. Treat submission as a separate approval, then verify the resulting page.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Fill a disposable test form without submitting it.
