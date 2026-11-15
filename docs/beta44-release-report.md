# PCRC beta.44 Windows keyboard release

Date: 16 November 2026 (Asia/Calcutta).

## Change

Windows hotkeys now use bounded native SendInput with the extended-key flag for navigation keys. Home, then Shift+End, then mixed-case literal typing replaces the selected text in the synthetic WinForms fixture. Existing desktop capability, approval, task reservations, fresh one-use frames, foreground validation and PyAutoGUI fail-safe checks remain. Partial input attempts only key release and raises an uncertain-outcome error; it does not replay the chord. No dependency was added.

Implementation: src/jan_mcp_commander/windows_input.py and control.py; regression tests: tests/test_windows_input.py and test_control.py. Release layers: scripts/build_npm_beta.py; thin launcher metadata, pins and integrity test; Windows/POSIX public installers; public download allowlist and portal link/tests. The previously deployed gateway document-review privacy fix is retained. Beta.43 archives and versioned installers remain available.

## Checks

- Focused source/control/build/POSIX tests: 50 passed, exit 0.
- Prior full Python run against the same keyboard implementation: 569 passed, 13 skipped, exit 0. This was before the version/pin-only release edits.
- Beta.44 packaged MCP catalog, scoped search and managed Python environment: 33 passed, 0 skipped, exit 0.
- Installed beta.44 packaged client smoke: task conflicts, exact edits, stale hashes, backup recovery, resources and prompts passed.
- Installed beta.44 native desktop: fresh-frame Home -> Shift+End -> type -> UIA Save -> reopened exact PCRC_Ab9Z!, exit 0. Only the synthetic owned window was targeted and closed.
- Thin launcher: 8 passed, no skips, exit 0; includes real archive unpack/reuse and repair.
- Gateway: 291 passed, 3 skipped, 0 failed; TypeScript check and production deployment dry run exit 0.
- Independent review: no blocker; archive content, all pins and five owner publishing files verified. Separate reviewer launcher check: 7 passed, exit 0.
- Source credential scan: 0 findings. Whitespace validation exit 0.

## Artifacts

- version: `0.7.0-beta.44`
- archive_sha256: `0aff1a1f5bdc1a7e27fac3b42a9c1a47215ef144bb6f39d624e35f7d0d28ce19`
- archive_bytes: `95154655`
- manifest_files_verified: `2376`
- posix_archive_sha256: `676bd168f0d612115a54fd47990555775814926dff513c5420b4e14754685047`
- installer_sha256: `bef8e5f9cb0cdfc4cca0b76b3aca8fce2e6dbd1a8a704d0a6e89e9643d19c9f0`
- launcher_sha256: `a7f44e8bfd24ed3392b13bd413effed5ca2fc8d64bfeda71450cdd3d267a8440`
- release: `C:\Users\wwwcr\PCRC-Release\0.7.0-beta.44`

## Publication

Public Worker deployment completed: 4efb7b52-fa40-467d-9843-8a3e417cc182. Both versioned R2 artifacts uploaded. All nine public downloads were fetched and matched their local SHA-256 checksums (work/beta44-public-downloads.json). The owner completed npm publication. Independent registry verification confirms beta points to 0.7.0-beta.44; SHA-512 and SHA-1 integrity match and all five published package files match the tested owner release (work/beta44-npm-verification.json). The normal daily command npx --yes pcremotecommander@beta setup now resolves this version.

## Boundaries

The preceding 80-tool public beta.43 run recorded 79 representative passes and one partial Windows hotkey path. Beta.44 fixes and verifies that path in its installed packaged candidate; that public beta.44 agent retest subsequently passed on 16 November; see beta44-public-acceptance-report.md for the combined 80-tool evidence matrix and its version labels. Native Linux/macOS clean-machine testing, sustained reconnect/load, OS-level command sandboxing, publisher signing, universal screenshot/secret redaction and all-operation certification remain unverified. Real billing actions were excluded. The previous controlled shutdown requires a local PCRC restart.

## Published Windows retest — 16 November 2026

Actual public PCRC beta.44 calls verified fresh-frame Home then Shift+End selection, exact mixed-case replacement, fresh UI Automation Save, and reopened saved contents PCRC_Ab9Z!. Fixture exit code 0; no owned processes or held reservations remained. The final status still verified beta.44 and public relay. The 80-row follow-up report was saved and read back through public PCRC. The combined matrix is 80 representative passes across the earlier beta.43 baseline and this beta.44 follow-up; all 80 tools were not rerun on beta.44. Evidence: work/beta44-public-keyboard-acceptance-20261116.json and docs/beta44-public-acceptance-report.md.
