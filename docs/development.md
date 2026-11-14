# Development setup

PCRC source is available under the proprietary license in `LICENSE.txt`. Public source does not grant permission to redistribute or relicense the product or its branding.

Use a supported full Python installation and Node.js 20 or newer. Create a project virtual environment and install the development dependencies from `pyproject.toml`. PCRC's downloaded application interpreter is deliberately separate from a developer's Python environment.

```powershell
python -m venv .venv
.venv\Scripts\python -m pip install -e ".[dev,browser,desktop]"
$env:PCRC_SOURCE_ONLY_TESTS = "1"
.venv\Scripts\python -m pytest -q
```

MCP client checks:

```text
cd deploy/mcp-task-server
npm ci
npm test
```

Gateway checks:

From the repository root in PowerShell:

```powershell
npm ci --prefix deploy/npm/jan-commander
cd deploy/cloudflare/worker
npm ci
npm run check
npm run build
$env:PCRC_SOURCE_ONLY_TESTS = "1"
npm test
```

The repository does not contain paired-device state, credentials, installed dependencies, media models, large demo recordings or cloudflared executables. `PCRC_SOURCE_ONLY_TESTS=1` explicitly skips the release-binary digest and private demo-recording existence checks; remove that flag and provision the pinned third-party binaries for a distribution gate. Opt-in integration tests need the documented fixture/runtime prerequisites. A source checkout alone is not a verified release package. Do not mark skipped checks as passes.

The source namespace `jan_mcp_commander` and legacy command aliases are retained for import compatibility. New documentation and user-facing commands use PC Remote Commander/PCRC. Renaming compatibility entry points requires its own migration tests.

Cloudflare configuration files are examples. Replace their placeholder origins, account IDs and resource IDs with resources in your own account. Keep credentials in Wrangler secrets or private `.dev.vars` files. Live billing and email providers are disabled in the public examples until configured. Nothing in these setup instructions authorizes a production deployment.

See [release process](release-process.md), [security model](security-model.md), [device pairing](device-pairing.md) and [acceptance matrix](acceptance-matrix.md).

The Worker dry-run build explicitly uses the sanitized `wrangler.staging.json` development example. Actual deployment requires an explicitly reviewed configuration; `npm run deploy` alone has no default production configuration in this source checkout.
