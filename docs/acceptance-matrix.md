# Acceptance matrix

Record results per tool and scenario, with the tested version, transport, fixture, expected outcome, actual result and evidence. Keep public-gateway results separate from local MCP and source-only checks.

| Status | Required meaning |
| --- | --- |
| PASS | The specific operation completed and its result was verified. |
| PARTIAL | Execution succeeded but important outcome or coverage remains unverified. |
| FAIL | A valid, authorized scenario failed and needs investigation. |
| BLOCKED | Required authorization, fixture, runtime or safe environment was unavailable. |
| NOT TESTED | No applicable operation was executed. |

Dry-run validation does not prove a write. A process starting does not prove completion. Transcription execution does not prove accuracy. Malware scanning does not guarantee a safe file. A gateway receipt proves that call's route, not long-term uptime or complete account isolation.

Before promoting a batch to `main`, add its exact tool scenarios and evidence. Do not replace missing results with an aggregate “all tools passed” claim. The current repository is not a universal certification of every exposed tool, input format or platform.

Use synthetic data and disposable sessions. Desktop input and screenshots require a clear, private-window-free test desktop. An expired uncertain reservation stays fenced until actual state is reviewed; it is never automatically replayed to obtain a passing result.

## Owner-console batch — 15 November 2026

| Scenario | Evidence boundary |
| --- | --- |
| Owner GitHub sign-in, authenticator and dashboard access | Maintainer-reported production acceptance; synthetic isolation/replay tests |
| User search/details, complimentary access, support and analytics | Maintainer-reported acceptance; bounded synthetic provider/storage/browser tests |
| Password-reset email and completion for the operator's test account | Maintainer-reported receipt and completion; synthetic recipient-bound PKCE and SQLite callback tests |
| Real refunds and subscription cancellations | Explicitly deferred; no real financial action tested |
| Real customer deletion | Not tested |
| Delivery to every public email recipient/provider | Not established by the successful test recipient |

See [owner console](owner-console.md) for deployment prerequisites, recovery boundaries and the source test commands. These website results do not certify the entire runtime tool catalog.
