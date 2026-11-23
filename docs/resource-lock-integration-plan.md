# Resource-lock integration plan

Status: first implementation committed on `work/full-concurrency-upgrade`; cross-platform full-suite verification is in progress. Production remains untouched.

## Current behavior

`Coordination.guard()` acquires `PrivateStore.locked()`, loads and expires task state, validates the caller's lease and scope, checks all active and `needs_review` reservations, and holds the metadata lock across the decorated operation. This prevents task claims, renewals, finishes, and reconciliations from interleaving with an operation.

`PrivateStore.resource_locked()` is now used by coordinated operations in sorted canonical order. Each operation publishes a durable `active` record under the metadata lock after acquiring its resource locks and revalidating task scope/reservations. Successful calls become `completed`; exceptions become `needs_review`; crashes leave `active` records. Nested calls may use only resources covered by the outer operation.

## Safety invariant

A resource must not become newly reservable while an operation that was authorized before that reservation is still running. A resource lock alone does not establish this invariant: a claim can otherwise be committed after the guard releases metadata but before the operation finishes.

Likewise, task reservations are durable leases, while resource locks are ephemeral OS locks. They solve different problems and must not be conflated.

## Required design

1. Keep metadata transitions serialized under the coordination store lock. Claims, queue promotion, expiry, renew, finish, and reconcile continue to use one authoritative encrypted task-state transaction.
2. Implemented: acquire sorted resource locks first, then publish an active-operation record in a short metadata transaction. Claims and queue promotion treat active and review-required operation records as reservations.
3. Implemented: revalidate task lease, scope, and conflicting reservations after resource acquisition and before entering the protected method.
4. Implemented partially: successful calls become completed; exceptions become needs_review; crashed active records are recovered through snapshot, nonblocking lock probes, and metadata identity revalidation. Recovery never replays or deletes an uncertain operation.
5. Preserve workspace-wide and UI-wide exclusivity. A workspace reservation overlaps every file resource; UI conflicts with UI. Parent/child file paths continue to overlap.
6. Implemented: nested coordinated calls cannot widen the outer operation's resource set.
7. Do not let operation bookkeeping turn an expired active task into a replayable task. Expired active tasks remain `needs_review` until explicit reconciliation.
8. Do not add fairness or queue behavior changes as part of the lock refactor.

## Required regression coverage before wiring

- Implemented/tested: independent file operations overlap in time when their canonical resources do not overlap.
- Implemented/tested: operation registration blocks a conflicting task claim until the operation releases its reservation.
- Implemented/tested: nested calls cannot widen their outer resource scope.
- Implemented/tested: live operations remain active during recovery probes; abandoned records become needs_review; changed or malformed records fail closed.
- Same-file and parent/child operations serialize.
- Workspace conflicts with every file operation; UI remains exclusive.
- A claim racing operation registration either wins before registration (and causes the operation to reject) or observes the active-operation reservation and waits.
- Lease expiry, renewal, finish, and reconciliation racing an operation cannot release its reservation early.
- A stale lease is rejected after waiting for resource locks.
- Multiple-resource operations acquire locks in canonical order and do not deadlock under reversed input order.
- Process crash while an operation is registered leads to review-required recovery, never automatic replay.
- Thread and separate-process resource-lock tests pass on Windows and POSIX. The expanded coordination suite is awaiting the latest CI run.
- Existing coordination, privacy, command-permission, and workflow tests remain green.

## Rollout boundary

Implement and test only on `work/full-concurrency-upgrade`. Do not merge, deploy, publish, alter Cloudflare/Supabase production, or interact with a connected PC as part of this work.
