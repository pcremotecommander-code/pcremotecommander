# PC Remote Commander beta

Run `npx --yes pcremotecommander@beta setup` to install or reconnect. Beta.33 supports Windows x64 and Linux/macOS x64 or ARM64. Windows includes Python. Linux/macOS prepare a checksum-pinned user-scoped Python runtime if Python 3.11+ with venv is missing. Clean native Linux/macOS acceptance is still pending.

Without Node.js, Linux/macOS users can start with `curl -fsSL https://pc-remote-commander.pcremotecommander.workers.dev/install-posix-beta45.sh | bash`. It prepares pinned user-scoped Node.js and Python if needed, verifies the versioned source download and opens computer approval. Standard Linux/macOS setup enables files, commands and browser. Desktop control needs additional OS permissions; Linux requires X11.

The launcher verifies downloads before execution and caches them under your user profile. Reuse the same setup command each day and keep its terminal open. `npx --yes pcremotecommander@beta doctor` checks runtime, saved pairing, local-agent health and public reachability. Use dashboard **Check connection** for selected-device relay discovery. A CLI public-health pass alone is not an authenticated assistant test.

On Linux/macOS, `npx --yes pcremotecommander@beta uninstall` removes only this release and preserves workspace files and pairing. Removal refuses a workspace nested in the installation. Revoke the device in the dashboard to remove its access.

Setup requests full computer control and opens a matching-code approval page on the public production site. Review the computer name and requested permissions before approving. Keep the agent terminal running while an MCP client or the local CLI uses the computer. The agent runs with your operating-system account privileges.

This is a beta. It has not completed a production security or reliability review. Use an isolated workspace for testing.

Beta.16 rejects Windows short-name/tilde paths so they cannot bypass protected filename checks or shared-assistant reservations. Use full filenames without a tilde. Existing approval and capability checks remain enforced.

Beta.30 returns a non-executed LOCAL_BUSY response instead of disconnecting concurrent calls. It also documents search batch limits and clarifies saved pairing-version metadata.
