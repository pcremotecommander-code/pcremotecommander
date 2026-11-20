# Source verification

The `Source checks` workflow runs on pushes and pull requests to `main` and `next`, and on manual dispatch where the workflow is present. Both runners check source credentials, gateway types, launchers, and the MCP bridge and catalog. Ubuntu runs the gateway integration suite and the full Linux source suite with headless Chromium. Hosted Windows runs a named subset of Python tests, including native keyboard ABI tests, UI Automation contracts, mocked scanner behavior, privacy, and command environments.

The workflow has read-only repository permission, checks out without persisted credentials, and pins official GitHub actions to full commit IDs. It contains no production secrets, deployment, npm publication, email delivery or financial actions. It does not change branch protection or promote `next` to `main`.

The Linux runner is Ubuntu 22.04: newer hosted Ubuntu images restrict Chromium's unprivileged user namespaces. PCRC continues to require Chromium sandboxing; CI does not add a `--no-sandbox` workaround or change the runner's security policy.

Hosted Windows tests use the Windows 2022 image. The workflow does not change antivirus settings. The hosted Windows suite leaves real Defender scanning and the full Windows MCP integration suite to the separate acceptance gate.

Before release sign-off, run Windows acceptance on a dedicated, isolated Windows environment with Defender enabled and no production or personal credentials. Use a reviewed checkout and a normal user shell. With Python 3.14 and Node.js 24 available, install the test dependencies, then run the acceptance gate:

```powershell
python -m pip install -e ".[dev,browser]"
python -m playwright install chromium
npm ci --prefix deploy/mcp-task-server
powershell -NoProfile -File scripts/check_windows_acceptance.ps1
```

The script checks real-time protection, exercises PCRC's real scanner on synthetic bytes, and runs the Windows source and MCP integration suites. Any failure returns a nonzero exit. Record the tested commit and results separately from hosted CI. Keep this environment off public pull-request jobs. See [Microsoft's real-time protection configuration](https://learn.microsoft.com/en-us/defender-endpoint/configure-real-time-protection-microsoft-defender-antivirus).

`PCRC_SOURCE_ONLY_TESTS=1` labels unavailable private recordings and release-binary checks as skipped. Native desktop, media, packaged-release and live public acceptance checks retain their existing opt-in prerequisites. A green source workflow does not certify all exposed tools, account isolation in production, installed release signatures, or long-running relay stability. Read the test summaries and skips before release.

Run the credential check locally with `python scripts/check_source_credentials.py`. It scans tracked and unignored source, including force-added private files, without printing matched values. This pattern scan cannot recognize every secret: maintain GitHub secret scanning and rotate any credential actually exposed. Never put credentials in fixtures or workflow logs.
