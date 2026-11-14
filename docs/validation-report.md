# Source baseline validation — 14 November 2026

This source snapshot belongs on `next`. It is not a certification of all 80 public tools or a promotion to `main`.

| Check | Outcome |
| --- | --- |
| Python source suite, explicit source-only mode | 552 passed, 13 skipped, 4 warnings; exit 0 |
| Gateway synthetic/runtime suite | 268 passed, 2 private-recording checks skipped; exit 0 |
| Worker TypeScript check and sanitized-config dry-run build | Both exited 0 |
| MCP focused bridge/catalog suite | 43 passed; exit 0 |
| Complete MCP suite | 54 passed, 1 failed, 3 opt-in checks skipped; exit 1 |
| Isolated rerun of failing browser workflow/shutdown case | 1 passed; exit 0 |
| Sanitized public configuration check | Passed, including independent review |
| Credential/private-state scan | No known local credential values or high-confidence credential patterns found |

The complete MCP run timed out in isolated browser shutdown after workflow replay. The same test passed when rerun alone. Treat this as unresolved concurrency/reliability evidence, not a clean full-suite pass. Do not silently retry uncertain writes.

Checks reused existing locked development dependencies; this was not a fresh dependency installation or a clean-machine test. Source-only mode excludes release-binary digest and private-recording existence checks. Other opt-in checks require native desktop/media fixtures. The Python suite emitted four existing PDF deprecation warnings.

Deployment examples contain placeholder identifiers and disabled live providers. The release gate status is deliberately all blocked and includes no private operational history. The proprietary PCRC license does not replace third-party licenses.

Published beta.43 website/runtime downloads were separately checksum-verified. npm publication and installed public beta.43 acceptance remain pending. Tests on the previous active public runtime are not evidence for the new source baseline. Native Linux/macOS clean-machine checks, sustained reconnect/load, OS sandboxing and the complete public tool-by-tool matrix remain unverified.
