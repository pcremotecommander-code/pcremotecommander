# Resource-lock integration plan

Status: resource-lock recovery, Linux descendant cleanup, and Windows Job Object containment are implemented on `work/full-concurrency-upgrade`. The Windows Job Object and Linux escaped-grandchild tests passed in targeted Ubuntu and Windows CI. Linux parent-death escaped-descendant coverage has now been added and is awaiting CI. Production remains untouched.

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
- Implemented: task handoff refuses to release a lease with active or review-required operation records.
- Implemented: orphaned operations without a task can be released only through explicit `reconcile_operation` review after the same two-phase OS-lock probe.
- Implemented: development subprocess execution retains its workspace lock for the entire child-process lifetime; synchronous shell commands and browser teaching workflows are coordinated.
- Implemented: detached `operator_command` sessions receive a durable operation record covering `workspace`, plus separate supervisor and parent-owner lock resources.
- Implemented on Linux: subreaper mode is enabled before installing the parent-death signal handler. If the PCRC parent dies, the supervisor kills and reaps all descendants, including daemonized descendants that create a new session and close inherited descriptors, before exiting and releasing its reservation. Process identities are checked using `/proc` start times and pidfds where available. Regression coverage for both normal completion and abrupt parent death has been added; the parent-death test is awaiting CI.
- Other POSIX platforms still rely on process-group cleanup and do not receive the Linux subreaper guarantee; detached-command containment must be described as platform-dependent.
- Implemented and targeted CI passed: on Windows, PCRC creates an inheritable Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, passes only that handle to the supervisor, creates the command process suspended, assigns it to the Job Object before resuming its primary thread, and retains handles in both the PCRC parent and supervisor. No breakaway flags are enabled. The supervisor terminates remaining job members after the direct command exits; the parent also terminates the job if the supervisor exits unexpectedly. A Windows regression test launches a grandchild and verifies it is terminated before the workspace reservation is released.
- Implemented: a parent-owned lock remains held until supervisor cleanup and operation finalization complete. Recovery probes both lock resources and cannot mistake a helper crash for a completed command.
- Implemented: detached child and supervisor PIDs are stored in the operation record. Successful exit marks the operation completed; a stop, crash, or nonzero exit requires review and is never replayed.
- Implemented: stdin control remains available during the detached workspace reservation; ordinary workspace/file operations remain blocked.
- Implemented: task reconciliation first probes active operation locks, refuses while an operation is live, and only archives uncertain operation records after explicit review.
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


## Remaining work

- Complete Linux parent-death escaped-descendant CI verification and inspect the process-identity/pidfd cleanup behavior under repeated fork races.
- Complete Windows Job Object verification for parent/supervisor crash cleanup and nested-job compatibility on supported Windows versions. The Job Object is process-tree containment, not a general OS sandbox.
- Keep the operator-command feature explicitly documented as not being an OS sandbox; process containment does not replace filesystem, network, or privilege isolation.
- Complete the latest Windows and POSIX CI runs and resolve any platform-specific failures before declaring detached-command recovery complete.
- Expand the operation record schema to cover any future asynchronous mutator that can outlive its request thread.
