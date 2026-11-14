# Security model

PCRC combines account-authenticated gateway routing with a locally approved device agent. Requests must retain account/device ownership, OAuth scope, capability, workspace, privacy and action-approval checks. An assistant-supplied `confirmed: true` does not establish genuine user consent.

File operations use approved-workspace path checks, reject traversal and unsafe links, and use current hashes/recovery backups where supported. Task reservations coordinate participating assistants; they do not lock out unrelated software or manual edits. Unknown outcomes require inspection before another write.

Approved commands run as the local operating-system account and are not an OS sandbox. Desktop screenshots can contain private information; automated secret detection is high-confidence only and does not inspect every pixel or encoded value. Users should enter credentials privately and use disposable test data for acceptance runs.

Never commit access/refresh tokens, device keys, pairing URLs, local service credentials, `.env`/`.dev.vars`, session state, raw user captures or logs. Store production credentials in the service's secret manager. Public examples contain placeholders and must not point at an owner's production resources.

Report a suspected vulnerability privately using the contact in `SECURITY.md`. Do not post private credentials, personal documents or exploitable account details in a public issue.
