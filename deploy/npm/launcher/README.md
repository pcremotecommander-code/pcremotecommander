<p align="center">
  <img src="https://pc-remote-commander.pcremotecommander.workers.dev/brand/pcrc-logo.png" width="88" alt="PC Remote Commander logo">
</p>

<h1 align="center">PC Remote Commander · PCRC</h1>
<p align="center"><strong>Connect your AI assistant to the computer you approve.</strong></p>
<p align="center">
  <a href="https://www.npmjs.com/package/pcremotecommander"><img src="https://img.shields.io/npm/v/pcremotecommander/beta?label=npm%20beta" alt="npm beta version"></a>
  <a href="https://github.com/pcremotecommander-code/pcremotecommander"><img src="https://img.shields.io/github/stars/pcremotecommander-code/pcremotecommander?style=flat" alt="GitHub stars"></a>
  <a href="https://github.com/pcremotecommander-code/pcremotecommander/actions/workflows/source-checks.yml"><img src="https://img.shields.io/github/actions/workflow/status/pcremotecommander-code/pcremotecommander/source-checks.yml?branch=next&label=source%20checks" alt="Source checks"></a>
</p>

PCRC is a computer-access layer for compatible AI clients. It connects your assistant to the files, commands, isolated browser and desktop actions on a computer you pair and approve. Your AI provider supplies the model; PCRC supplies the approved computer connection.

**This package is a beta launcher.** It does not include an AI model or an AI-provider subscription.

## Quick start

Requires **Windows 10/11, Linux or macOS** and **Node.js 20+**. Windows includes its managed Python runtime. Linux/macOS require Python 3.11+ with `venv` unless the installer prepares the supported runtime.

```bash
npx --yes pcremotecommander@beta setup
```

You can also use the short command:

```bash
npx --yes pcrc setup
```

Keep the terminal open while your computer is connected. To stop the local agent, press `Ctrl+C`. Run the same setup command to reconnect.

For Linux/macOS, the launcher retrieves the version-matched installer from:
[install-posix-beta49.sh](https://pc-remote-commander.pcremotecommander.workers.dev/install-posix-beta49.sh).
The launcher verifies its SHA-256 before executing it.

## What PCRC connects

- **Files and documents** — inspect approved workspace files and perform reviewed changes.
- **Terminal and processes** — run supported commands with your operating-system account permissions.
- **Isolated browser** — work with a separate browser context; your normal browser profile and cookies are not reused.
- **Desktop controls** — inspect and interact with supported desktop applications when enabled.
- **AI clients** — connect compatible ChatGPT, Claude, Cursor and other MCP clients through the PCRC endpoint.

## Pair your computer

1. Run the setup command on the computer you want to connect.
2. Open the pairing page shown by the terminal and sign in to your PCRC account.
3. Compare the terminal and browser codes.
4. Review the requested computer capabilities and approve only the request you started.
5. Select the computer for AI tools in the dashboard.
6. Connect your AI client using the remote MCP endpoint and OAuth.

Remote MCP endpoint:

```text
https://pc-remote-commander.pcremotecommander.workers.dev/mcp
```

See the [complete installation and client setup guide](https://github.com/pcremotecommander-code/pcremotecommander/blob/main/docs/install.md).

## Security and permissions

- Use only a computer and data you own or are authorized to access.
- Review pairing codes, local capabilities and OAuth scopes before granting control.
- Commands run with your operating-system account privileges; they are not automatically confined to one project folder.
- Screenshots and tool results may contain private information and pass through the PCRC service and your AI provider.
- Use an isolated workspace for beta testing and keep backups of important files.
- Revoke a device in the dashboard when you no longer want it connected.

## Help and project links

- [PCRC website](https://pc-remote-commander.pcremotecommander.workers.dev/)
- [Device dashboard](https://pc-remote-commander.pcremotecommander.workers.dev/devices)
- [GitHub repository and full documentation](https://github.com/pcremotecommander-code/pcremotecommander)
- [Report a bug or request a feature](https://github.com/pcremotecommander-code/pcremotecommander/issues)
- [Security notes](https://github.com/pcremotecommander-code/pcremotecommander/blob/main/docs/security.md)

## License

PC Remote Commander is distributed under its **proprietary software license**. The package includes `LICENSE.txt`; third-party components remain under their respective licenses. Installing this package does not grant permission to modify, redistribute or resell PCRC.

---

Made independently by the PC Remote Commander developer. Thank you for trying the beta and reporting issues.
