---
name: directory-organization
description: "Organize files into approved workspace folders."
metadata:
  version: "1.0.0"
---

# Directory organization

## When to use

Organize files into approved workspace folders.

## Required PCRC tools

`list_workspace_entries`, `create_directory`, `inspect_file`, `move_files_bulk`.

## Inputs and procedure

Get the user's goal, approved computer or workspace, and any exact targets before proceeding. Check that the requested tools are available in the current client.

Inspect the source and proposed destination, check for collisions, and review a path-by-path move plan before any write. Verify the final directory listing.

## Output and recovery

Summarize the observed state, exact operation if approved, and verification evidence. If a tool returns an error or the result is uncertain, inspect the current state before retrying. Report the blocker if a safe check cannot resolve it.

## Permissions

Use only the approved scope. A skill never grants control. Obtain genuine approval where required and follow PCRC's capability, reservation and review rules. Keep secrets and unrelated data out of requests and reports.

## Example

Organize reviewed sample files by project.
