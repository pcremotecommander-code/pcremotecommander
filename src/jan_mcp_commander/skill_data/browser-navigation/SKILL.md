---
name: browser-navigation
description: "Navigate and verify a page in the PCRC browser."
metadata:
  version: "1.0.0"
---

# Browser navigation

## When to use

Navigate and verify a page in the PCRC browser.

## Required PCRC tools

`list_browser_tabs`, `navigate_browser`, `inspect_browser_page`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Confirm the target tab and intended URL. Use approved navigation, then verify the final URL and page state. Stop on an unexpected redirect.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Open an approved project documentation URL.
