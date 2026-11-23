# Resource-lock integration plan

Status: design only. The existing coordination guard remains unchanged.

## Current behavior

`Coordination.guard()` acquires `PrivateStore.locked()`, loads and expires task state, validates the caller's lease and scope, checks all active and `needs_review` reservations, and holds the metadata lock across the decorated operation. This prevents task claims, renewals, finishes, and reconciliations from interleaving with an operation.

The new `PrivateStore.resource_locked()` primitive is independently tested on Linux and Windows, but it is not used by normal coordinated operations yet.

## Safety invariant

A resource must not become newly reservable while an operation that was authorized before that reservation is still running. A resource lock alone does not establish this invariant: a claim can otherwise be committed after the guard releases metadata but before the operation finishes.

Likewise, task reservations are durable leases, while resource locks are ephemeral OS locks. They solve different problems and must not be conflated.

## Required design

1. Keep metadata transitions serialized under the coordination store lock. Claims, queue promotion, expiry, renew, finish, and reconcile continue to use one authoritative encrypted task-state transaction.
2. Add explicit active-operation records to the same metadata state. Register the operation and its canonical resource set before releasing metadata; claims and queue promotion must treat these records as held reservations.
3. Acquire resource locks in one deterministic global order (sorted canonical resource identifiers). Revalidate the task lease, scope, and conflicting reservations after acquisition and before entering the protected method.
4. Release resource locks in reverse order. Remove the active-operation record in a metadata transaction in a `finally` path. Define crash recovery for abandoned operation records; never infer that an uncertain write did not happen merely because a process disappeared.
5. Preserve workspace-wide and UI-wide exclusivity. A workspace reservation overlaps every file resource; UI conflicts with UI. Parent/child file paths continue to overlap.
6. Preserve nested coordinated-call behavior without allowing a nested call to silently widen the outer operation's resource set.
7. Do not let operation bookkeeping turn an expired active task into a replayable task. Expired active tasks remain `needs_review` until explicit reconciliation.
8. Do not add fairness or queue behavior changes as part of the lock refactor.

## Required regression coverage before wiring

- Independent file operations overlap in time when their canonical resources do not overlap.
- Same-file and parent/child operations serialize.
- Workspace conflicts with every file operation; UI remains exclusive.
- A claim racing operation registration either wins before registration (and causes the operation to reject) or observes the active-operation reservation and waits.
- Lease expiry, renewal, finish, and reconciliation racing an operation cannot release its reservation early.
- A stale lease is rejected after waiting for resource locks.
- Multiple-resource operations acquire locks in canonical order and do not deadlock under reversed input order.
- Process crash while an operation is registered leads to review-required recovery, never automatic replay.
- Thread and separate-process tests run on Windows and POSIX.
- Existing coordination, privacy, command-permission, and workflow tests remain green.

## Rollout boundary

Implement and test only on `work/full-concurrency-upgrade`. Do not merge, deploy, publish, alter Cloudflare/Supabase production, or interact with a connected PC as part of this work.
