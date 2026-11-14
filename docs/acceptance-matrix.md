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
