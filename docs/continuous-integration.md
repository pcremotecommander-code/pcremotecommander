# Source verification

The `Source checks` workflow runs on pushes and pull requests to `main` and `next`, and on manual dispatch. Linux and Windows runners install the pinned project dependencies, scan Git-visible source for private-state paths and common credential formats, run Python tests, check gateway types and tests, and test the public launcher. Python browser fixtures use headless Playwright Chromium. Windows additionally runs the full MCP integration suite against synthetic fixtures; Linux runs MCP bridge and catalog unit tests because the media/document release preflight requires Windows AMSI/Defender. Windows-specific packager, scanner and UIA tests are explicitly skipped on other systems, not counted as passes.

The workflow has read-only repository permission, checks out without persisted credentials, and pins official GitHub actions to full commit IDs. It contains no production secrets, deployment, npm publication, email delivery or financial actions. It does not change branch protection or promote `next` to `main`.

The Linux runner is Ubuntu 22.04: newer hosted Ubuntu images restrict Chromium's unprivileged user namespaces. PCRC continues to require Chromium sandboxing; CI does not add a `--no-sandbox` workaround or change the runner's security policy.

Windows installs Chromium without Playwright's optional Windows Server media-feature installation; the synthetic browser fixtures do not play video. Native media workers are tested using the pinned PyAV and NumPy development dependencies.

The disposable Windows runner enables Defender real-time protection and verifies it before native tests, then warms the same restricted PowerShell environment used by PCRC. It fails if the runner cannot provide protection; it never disables tamper protection or bypasses PCRC scanning. These runner-only steps do not configure a paired computer or production. See [Microsoft's real-time protection configuration](https://learn.microsoft.com/en-us/defender-endpoint/configure-real-time-protection-microsoft-defender-antivirus).

`PCRC_SOURCE_ONLY_TESTS=1` labels unavailable private recordings and release-binary checks as skipped. Native desktop, media, packaged-release and live public acceptance checks retain their existing opt-in prerequisites. A green source workflow does not certify all exposed tools, account isolation in production, installed release signatures, or long-running relay stability. Read the test summaries and skips before release.

Run the credential check locally with `python scripts/check_source_credentials.py`. It scans tracked and unignored source, including force-added private files, without printing matched values. This pattern scan cannot recognize every secret: maintain GitHub secret scanning and rotate any credential actually exposed. Never put credentials in fixtures or workflow logs.
