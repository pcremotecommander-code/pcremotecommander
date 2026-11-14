# PC Remote Commander task MCP

Beta.15 adds 13 shared-task and browser-teaching tools. See [usage, permissions and limits](../../docs/shared-ai-tasks-and-browser-teaching.md). PCRC coordinates user-connected assistants and does not supply model subscriptions.

## Earlier implementation notes

This TypeScript MCP server adds 30 task-oriented tools over the existing Python service. It is bundled in the published `0.7.0-beta.3` staging runtime; `@beta` resolves to the small launcher for that runtime. The Python CLI, website sign-in, and device onboarding stay unchanged.

The server uses `@modelcontextprotocol/server` / `@modelcontextprotocol/client` v2.3.1 and Zod v4.6.7. These are the current split packages of the official TypeScript MCP SDK. The server opens a private stdio connection to the installed `jan_mcp_commander` Python package; the Python service still enforces workspace paths, capability leases, backups, audit, and command limits.

## Local installation

From this folder run `npm ci` and `npm run build`. Set `JAN_MCP_WORKSPACE` to a folder you explicitly approve. Set `JAN_MCP_PYTHON` to the Python executable that has `jan_mcp_commander` installed. Start `node dist/main.js` for stdio. Standard output is reserved for MCP; metadata-only usage events go to standard error.

To enable local control, launch with `JAN_MCP_CONTROL=1` and `JAN_MCP_CAPABILITIES=files,commands,browser,desktop` only after the device owner chooses those capabilities. The Python backend independently enforces the local lease. Merely setting a field in a tool call does not grant an OS capability.

For an isolated loopback HTTP preview, set `JAN_MCP_TRANSPORT=http`, `JAN_MCP_LOCAL_KEY` to a random URL-safe secret of at least 43 characters, and optionally `JAN_MCP_PORT` (default 8866). The server binds only to `127.0.0.1`; requests must carry `Authorization: Bearer <key>`. The published beta.3 agent can relay this origin; a live public OAuth and paired-device test is still pending.

## Client configuration

Use the same command and environment in Claude Desktop, Claude Code, or Cursor's local stdio MCP configuration:

```json
{
  "mcpServers": {
    "pc-remote-commander-tasks": {
      "command": "node",
      "args": ["C:/path/to/JAN-MCP-Commander/deploy/mcp-task-server/dist/main.js"],
      "env": {
        "JAN_MCP_WORKSPACE": "C:/path/to/approved/workspace",
        "JAN_MCP_PYTHON": "C:/path/to/python.exe"
      }
    }
  }
}
```

Client settings screens vary by version. Point each client to the built script and supply the approved workspace/Python paths. Never place a local bearer key in a public project configuration.

For a remote connection, use `https://pc-remote-commander.pcremotecommander.workers.dev/mcp`. Sign into your PCRC account, approve and select your computer on the dashboard, then complete MCP OAuth. A read-only grant exposes read tools; a separate `pcrc:control` grant and local capability approval are required for file changes, commands, browser, and desktop actions. The operator website is not an MCP endpoint for customers.

- Claude Code: `claude mcp add --transport http pc-remote-commander https://pc-remote-commander.pcremotecommander.workers.dev/mcp`, then use `/mcp` to sign in. [Claude Code MCP guide](https://docs.anthropic.com/en/docs/claude-code/mcp).
- Claude.ai: add a custom remote connector in **Customize → Connectors** with the same `/mcp` URL, then connect your own account. [Claude custom connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).
- Cursor: add a remote Streamable HTTP server with that URL in `.cursor/mcp.json`, then authenticate that server. [Cursor MCP guide](https://docs.cursor.com/context/model-context-protocol).
- VS Code: use **MCP: Add Server** and choose HTTP with that URL, or place the server in user `.mcp.json` under `mcpServers`; use the separate `servers` key only for `.vscode/mcp.json`. [VS Code MCP configuration](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).
- OpenAI Responses API: pass the same public URL as `server_url` and supply the user's OAuth access token in `authorization` on each request. The application must obtain and refresh that token separately. [OpenAI MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp).

## Example conversations

1. “Is my computer connected, and which workspace can you see?” → `get_connection_status`, `get_capabilities`.
2. “Find the file mentioning the release number, then show only the relevant lines.” → `search_workspace` with `mode=text`, `inspect_file`, `read_file_excerpt`.
3. “Replace this sentence in the README.” → `inspect_file`, `read_file_excerpt`, `preview_file_edit`; show the diff and obtain approval before `apply_file_edit`.
4. “Run the project diagnostic and tell me whether it passed.” → `run_diagnostic`, or an explicitly approved `run_command` if a preset cannot answer it.
5. “Open the app in the isolated browser and tell me what is on the page.” → `list_browser_tabs`, approved `navigate_browser`, `inspect_browser_page`.
6. “Run this exact build command and tell me its exit code.” → `run_command` after approving the command and choosing the `commands` capability.
7. “Use the Windows Save button.” → `inspect_desktop_controls`, check the window/name/role, then approve `interact_desktop_control` with its one-use inspection/control IDs. Verify the returned state. If accessibility cannot identify the target, use `capture_desktop`, review the image, then approve `interact_desktop` with that fresh frame ID; never guess coordinates. See [Windows UI Automation](../../docs/windows-ui-automation.md).

## Safety and current boundaries

- Read-only sessions advertise only read-only tools. Control tools are shown only for the locally chosen capability set. The Python service checks every call again.
- Search scans at most 40 files and 20 directories; file reads are bounded by the Python service. Bulk move/delete stops after the first failure and reports completed items. A dry run makes no change.
- Tools ask for a `confirmed` flag on high-impact actions, but that flag is supplied by the MCP client and is **not independent proof of a human approval**. A public rollout must add an out-of-band or MCP elicitation confirmation flow. Do not use this preview for unattended destructive control.
- The loopback HTTP bearer is not a public OAuth implementation. The public staging gateway supplies OAuth and per-user routing and accepts task resource/prompt methods; the beta.3 agent is published, but a live public roundtrip is still pending.
- Browser and desktop screenshots include MCP image content; base64 is excluded from structured metadata. The relay currently buffers one final response, so long-lived subscriptions and intermediate progress are unavailable remotely.
- Live resource subscriptions, dynamic `list_changed`, server-side sampling, and per-tool destructive-action confirmation remain open. Inspector CLI passed locally over stdio and loopback HTTP; strict stdio tool listing also passed against a clean beta.3 npm registry install on 2026-10-22, finding all 30 task tools. The public OAuth endpoint has not been inspected with the new agent. Tests cover local stdio/HTTP handshake, permission filtering, file search, synthetic edits, and a synthetic command.
