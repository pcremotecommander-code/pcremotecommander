# PCRC Agent Skills

MCP tools carry out authorized actions on a PCRC computer. Agent Skills are portable instructions that help Codex, Claude Code, and other compatible agents choose those tools, review the action and verify the result. Reading or installing a skill grants no device access. Connect PCRC separately and keep using its normal approval and reservation rules.

## Find and install skills

With a PCRC runtime that bundles this catalog, use the existing launcher and CLI. On an npm installation, the short command is `pcrc skills`. The following examples also work through the established `cli skills` entry point.

```powershell
npx --yes pcremotecommander@beta cli skills list
npx --yes pcremotecommander@beta cli skills search "browser"
npx --yes pcremotecommander@beta cli skills info browser-navigation
npx --yes pcremotecommander@beta cli skills install computer-diagnostics --agent codex --dry-run
npx --yes pcremotecommander@beta cli skills install computer-diagnostics --agent codex
npx --yes pcremotecommander@beta cli skills install browser-navigation --agent claude
npx --yes pcremotecommander@beta cli skills install --all --agent codex
```

Codex reads user skills from `~/.agents/skills/`. Claude Code reads personal skills from `~/.claude/skills/`. Run the install command on the computer where the agent loads its skills. Open a new session and ask it to use the installed skill, such as “Use computer-diagnostics to check the selected PC.”

```powershell
npx --yes pcremotecommander@beta cli skills installed
npx --yes pcremotecommander@beta cli skills update --dry-run
npx --yes pcremotecommander@beta cli skills update
npx --yes pcremotecommander@beta cli skills uninstall browser-navigation --agent claude
```

The `skills suggest` and `skills route` commands accept a task description and return the same advisory workflow. The installer works from the bundled files and leaves unrelated or locally edited skills alone. If a name already exists, review that folder yourself. If the CLI does not recognize the command, check the installed PCRC version. Skill installation does not start the relay.

## Discover skills over MCP

Call `list_skill_packs` with no input to see the advisory catalog and portable skills. Pass `{"skill":"browser-navigation"}` to read that skill's full instructions and required tool names. Existing `guide`, `route`, `export` and feedback commands are still available.

For a multi-step task, ask PCRC to call `suggest_workflow` with “Find a Python project, inspect its dependencies, fix the error, and run its tests.” The recommendation starts with project inspection, then dependency review, debugging, execution and validation. Inspect the environment first and stop at any approval boundary. Tool availability depends on the client, runtime and device permissions.

The portable collection covers computer operations, workspace files, browser work, Python development and troubleshooting. Network diagnostics cover PCRC connectivity.

## Transfer files between your PCs

With a compatible CLI and gateway, the `file-transfer` skill walks you through copying one file on a trusted local network. Both devices must appear Online on the same PCRC Devices dashboard and have approved file access. Your account must support two enrolled computers. Open **Device details & access** on each device to find its ID. Connect both to the same trusted router over Wi-Fi or Ethernet and use their private IPv4 addresses.

Open a terminal on the receiving PC while its launcher stays running. Replace the example workspace, addresses and device ID with yours. If you use npx, start each command with `npx --yes pcremotecommander@beta`. For a test pinned to this release, use `npx --yes pcremotecommander@0.7.0-beta.49.1`.

```text
pcremotecommander cli --workspace "C:/PCRC-Workspace" transfer receive --bind-ip 192.168.1.20 --peer-ip 192.168.1.10 --peer-device 11000000-0000-4000-8000-000000000001 --destination incoming.zip
```

Approve the destination. In a terminal on the source PC, use the port shown by the receiver in place of 53001.

```text
pcremotecommander cli --workspace "C:/PCRC-Workspace" transfer send --bind-ip 192.168.1.10 --peer-ip 192.168.1.20 --peer-device 11000000-0000-4000-8000-000000000002 --port 53001 --source project.zip
```

Approve the file and enter the receiver's one-time code privately. On Linux, use the local workspace path, such as `/home/user/PCRC-Workspace`. The receiver accepts up to 120 MB by default. Use `--max-mb 500` on the receiver to allow up to 500 MB for that transfer. The output uses the full uncompressed file size. PCRC compresses portions that would be smaller and reports the received byte count and SHA-256. It preserves the original and refuses to overwrite an existing file.

The gateway checks device enrollment and presence. File contents travel over the direct encrypted connection. This feature requires a reachable private network path and does not provide cloud uploads or an Internet relay for files.

## Write a custom skill

Create a directory named for the skill and include a `SKILL.md` with `name` and `description` front matter. Name the exact PCRC tools, inputs, expected evidence and recovery steps. Describe where to stop for approvals and what to verify after the action. Review third-party instructions as untrusted content. Keep credentials and unrelated data out of skills.

See the [Agent Skills specification](https://agentskills.io/specification) for supported metadata.
