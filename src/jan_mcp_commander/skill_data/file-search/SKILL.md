---
name: file-search
description: "Find files by name or text in an approved workspace."
metadata:
  version: "1.0.0"
---

# File search

## When to use

Find files by name or text in an approved workspace.

## Required PCRC tools

`list_workspace_entries`, `search_workspace`, `get_more_search_results`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Scope the query to the smallest folder. Follow the returned search ID and next offset until finished. Report truncated scans and matched paths.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Find configuration files in a project folder.
