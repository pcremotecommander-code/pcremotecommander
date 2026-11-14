# Project Python and dependency workflow

PCRC's bundled Python is an application runtime, not a general-purpose Python installation. Project packages belong in a separately managed project `.venv`. Existing system environments are never overwritten or used as package-install targets. Commands **and** files capabilities are required. Runtime tools use the same account, device, capability, task, privacy and action-approval paths as existing PCRC tools; `confirmed: true` is not evidence of user consent.

## Public tool flow

1. `inspect_development` with `action: runtime.list` discovers executable candidates, probes Python version/architecture, pip/venv/ensurepip/Tk/virtualenv availability, distinguishes PCRC's interpreter and reports bounded checks for installed development commands. Broken entries are marked invalid. Tool paths without a successful version probe are not called verified.
2. If a full Python is absent, `preview_development_change` with `action: runtime.install`, `options: {version: "3.12.12"}` prepares an exact-version runtime plan. This example is a compatibility fixture, not a recommendation to use an old patch release. Choose an appropriate maintained patch version. An existing uv can be used; otherwise preview pins the original uv 0.13.8 platform wheel from PyPI by SHA-256 and size. On apply, uv is ephemeral private staging code and provisions only inside the approved project, with config discovery, PATH-bin installation and Windows registration disabled. Bootstrapping supports x64/arm64; unsupported platforms fail before installation.
3. Inspect dependency files with `project.detect_dependencies`, or supply explicit package specifications. Bounded `requirements.txt` and static `[project].dependencies` in `pyproject.toml` are supported. URLs, indexes, editable requirements, recursive includes, dynamic dependencies and unsupported markers are rejected instead of being silently interpreted. No project build script runs.
4. Preview `environment.create` or `project.setup_environment`, providing a discovered full `runtime`, optional `project`, optional project-relative `environment` ending in `.venv`, and optionally `packages` and `imports`. A setup combines supported file dependencies with explicit packages. `environment.create` can make an empty environment. When pip is missing but venv/ensurepip exist, dependency resolution uses an ephemeral private resolver environment. Missing standard-library prerequisites require a different/provisioned full runtime.
5. Poll `get_development_change` every **2 seconds**, respecting `poll_after_seconds`. A `previewed` result shows the exact resolved binary-wheel versions, original PyPI sources, hashes, available license metadata, target and limits. Resolution itself can download metadata/artifacts; it is a control operation and does not install project packages.
6. After genuine user/host approval, call `apply_development_change` with `plan_id`, the exact `review_sha256`, and `confirmed: true`. Preview expiry is 15 minutes. Source dependency hashes, runtime hash, signed environment marker and existing package inventory are rechecked. Apply is consumed once. Poll its receipt; owned session IDs support `read_process_output` and `stop_process`. Process cancellation or interruption yields failed/unknown evidence and **never** an automatic replay.
7. Inspect/reopen the environment, run `package.check`, and inspect installed metadata. `project.verify_environment` checks module availability without importing project code; actual package imports execute only when listed in the approved change's `imports`. Use existing `start_program`/process tools for an explicitly approved project launch. A launched viewer is not proof that frames were captured.

Additional inspection actions: `runtime.inspect`, `runtime.verify`, `environment.list` (one selected project), `environment.inspect`, `package.list`, `package.audit`. Audit accepts up to 10 package names and sends only those names and installed versions to PyPI's release JSON API. Lookup failures are unverified, not clean; absence of reported advisories is not proof of safety. Optional GUI/capture/compiler/AI packages are not installed wholesale.

Additional change actions: `package.install`, `package.uninstall`, `environment.remove`. Existing `.venv` directories without a valid workspace/path-bound HMAC marker are not adopted. Removal renames a managed environment to a new `.venv.removed-<plan ID>` recovery directory; it does not erase the recovered files. For interrupted creation: first inspect actual process/environment state, stop owned processes, then review removal and create a fresh environment. Never delete LocalAppData to repair a project environment.

## Scope and limits

- No new library dependency was added to PCRC. The optional uv and project wheels are fetched as original upstream artifacts when approved, not repackaged in PCRC.
- 40 requested specifications, 80 resolved wheels, 24 KiB review, 20 retained plans. Older completed/failed receipts are evicted first at capacity; ordinary receipts expire from the index after seven days; unresolved receipts and provisioned-runtime registrations remain bounded by that capacity.
- Each background preparation/application has a 600-second process budget. Private temporary/download storage is monitored against 256 MiB; target files against 1 GiB and 30,000 entries. Monitoring runs every 0.5 seconds and permits transient overshoot. Wheels are preflighted before ZIP central-directory allocation (4 MiB directory limit), with a combined 512 MiB expanded/20,000-entry bound, rejecting unsafe paths, duplicate entries, links and ZIP64.
- Per-environment OS locks serialize mutations across clients. Separate worker locks keep one client's running work from being mistaken for another client's interrupted job. Task leases are not revived or extended implicitly.
- Binary-only pip plans are resolved before review and installed from exact SHA-256 requirements with `--no-index`, `--no-deps` and `--require-hashes`. Global/user/site pip configuration is disabled. The pip wrapper limits file/network destinations and build subprocesses as defense in depth.
- **This is not an OS sandbox.** Approved installed Python/native package code, including Python startup `.pth` files before the wrapper hook, can execute with the OS user's rights. Hash checks establish artifact integrity, not that package code is malware-free. Do not approve untrusted packages or execute private credentials through the tools.
- Terminal staging is removed after success/failure; recovered project environments are retained. After a hard process/PC stop, uncertain artifacts may remain for explicit operator review. Public installer signatures, upstream licensing certification, native macOS/Linux execution and real AI Gaming Engine frame/FPS acceptance are separate checks.

## CLI

Use the existing launcher, for example:

```text
pcremotecommander cli --workspace PATH development inspect --action runtime.list
pcremotecommander cli --workspace PATH development preview --action environment.create --options JSON
pcremotecommander cli --workspace PATH development receipt --plan-id ID
pcremotecommander cli --workspace PATH development apply --plan-id ID --review-sha256 HASH --allow-changes
```

Quote JSON for your shell. Preview/apply CLI commands wait for their background result; MCP returns immediately. CLI changes require the explicit `--allow-changes` flag. This feature is not in public beta.40; availability must be verified after publishing the next runtime.

## Workflow reservation recovery

Workflow run/step replies include a lease deadline and instructions to renew at least every 60 seconds and before each replay step. Expired leases still stop input. Review the actual run, browser, files and processes, reconcile the reservation, claim a fresh token and continue only a run known to be ready at its recorded step. Unknown or already-advanced writes must never be replayed. The new regression covers expiry at step zero, rejection of the old lease, reviewed reconciliation, renewal and verified completion.
