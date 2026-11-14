# Release process

Use only two long-lived branches:

- `main`: accepted release code and its documented limits.
- `next`: unfinished fixes and upcoming test batches.

Every batch must have a bounded purpose, named tool coverage, a reproduction or acceptance test, and recorded results. A tool discovered in the catalog is not a passing test. A tool blocked by an approval or missing prerequisite is not automatically defective.

When a batch passes review and regression checks, move only its verified commits from `next` into `main`. Do not merge unrelated unfinished changes just because one part of `next` passed. Keep remaining work on `next` and reuse that branch for the following batch. Use version tags such as `v0.7.0-beta.43` to identify releases; do not create a new branch for every version or tool group.

Before publication:

1. Check the exact commit for credentials, device state, logs, private configuration and unintended artifacts.
2. Run relevant Python, MCP catalog/client, gateway and installer checks. Record skips and limits.
3. Test packaged artifacts, not only the source implementation. Verify pinned archive/installer checksums.
4. Publish only the accepted batch. Record the source commit, package version and artifact digests.
5. Verify public downloads and npm contents, then test the installed public version through the gateway.

Publishing credentials and production approvals stay outside Git. A successful upload alone is not public acceptance. Keep recovery instructions and never automatically replay an uncertain user action.

The two-branch structure is a workflow, not a security certification. GitHub rulesets, required status checks and deployment permissions must be configured and verified separately; this document does not claim they are enforced. Existing published functionality is not removed solely because a new audit lacked permission to test it.
