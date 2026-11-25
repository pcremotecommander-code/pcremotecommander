# PCRC Hybrid Multi-Cloud Reliability Architecture

Status: design baseline only; no production traffic or resources changed.

## Goal

Keep the existing Cloudflare gateway as primary while preparing an independently operated secondary gateway. A Cloudflare-wide outage must not require users to reinstall PCRC or manually edit their MCP configuration after the stable public endpoint is introduced.

The initial operating mode is active-passive. Do not enable active-active command execution until shared-state consistency, fencing, and idempotency are proven.

## Current verified constraints

- The current public MCP endpoint is a Cloudflare `workers.dev` hostname. It is not an independent routing layer.
- The current client transport validates and pins a `workers.dev` origin and registers device origins against that one Worker.
- Per-account device registry and related account state are held in Cloudflare Durable Objects.
- Live relay sessions and pending requests are in-memory WebSocket state. A provider outage necessarily breaks existing sockets.
- The prepared Oracle plan is not launched or account-verified. It is not a live secondary gateway.
- Supabase bindings exist in the Worker environment, but this is not evidence that Supabase currently owns all authoritative device, replay, billing, and relay state.

## Non-negotiable safety rules

1. Cloudflare remains primary until the secondary passes the complete acceptance suite.
2. No production DNS, Worker, Durable Object, database, OAuth, or billing changes during development.
3. Never copy production secrets into source control or a test environment.
4. Never allow both gateways to accept writes for the same account concurrently without a proven lease/fencing mechanism.
5. Existing in-flight commands are not blindly replayed after reconnect. Every mutating operation needs a stable operation ID and deduplication record.
6. A live WebSocket cannot be transparently moved between providers. The client must reconnect and resume from durable state.
7. Do not describe failover as zero-interruption. The target is automatic reconnection with bounded interruption and safe command reconciliation.

## Target architecture

### 1. Stable ingress

Introduce one stable PCRC MCP hostname backed by routing that remains available when Cloudflare Workers or Cloudflare DNS is unavailable. The routing layer must support HTTPS, WebSocket upgrades, OAuth redirects/callbacks, correct Host and Origin validation, health-based active-passive routing, and independent failure domains.

A DNS CNAME alone is not accepted as a design until Host-header, TLS, OAuth, and WebSocket behavior are proven end-to-end. The public hostname/domain dependency is an external prerequisite; implementation can be staged without changing the current endpoint.

### 2. Primary and secondary gateways

- Primary: existing Cloudflare Worker and Durable Objects.
- Secondary: separately deployed gateway on an independent provider.
- Both implement the same versioned gateway contract and security checks.
- Secondary starts in shadow/read-only validation mode. It must not accept production mutations until state authority and fencing are enabled.

### 3. Durable shared state

Define a provider-neutral persistence contract for:
- account and device registrations;
- device revocation and access grants;
- subscription/entitlement state;
- OAuth/session metadata and replay protection;
- gateway ownership lease and fencing token;
- command ledger, idempotency keys, and terminal results;
- session-resume checkpoints.

Supabase may be evaluated as the shared authority, but only after schema, RLS, transaction, latency, backup, and outage behavior are audited. Existing bindings alone do not qualify it as the source of truth. Do not dual-write without a consistency and reconciliation design.

### 4. Client recovery

Refactor the client transport to consume a configured stable endpoint and a gateway discovery/health contract rather than hard-coding a single `workers.dev` origin. On transport loss it should:
- stop sending new mutations;
- reconnect with bounded exponential backoff and jitter;
- discover the active gateway;
- re-authenticate using the existing secure device identity;
- resume only from a server-issued checkpoint;
- query command IDs for uncertain operations instead of blindly retrying;
- report degraded/recovered state without exposing secrets.

### 5. Health and failover controller

Health checks must cover both gateway readiness and critical dependencies, not merely HTTP reachability. Failover requires a quorum/lease or a single authoritative controller with fencing. Failback is controlled and must not cause split brain. Health signals and routing must live outside the Cloudflare failure domain.

## Delivery gates

### Gate A — contract and threat model
- Define gateway API/version contract.
- Define authoritative state and migration/rollback plan.
- Threat-model replay, stale leases, split brain, OAuth, and command duplication.

### Gate B — isolated secondary
- Deploy a non-production secondary with synthetic accounts only.
- Run contract tests against both providers.
- Verify WebSocket, OAuth, device enrollment, revocation, and reconnect.
- Confirm no production secrets or user data are present.

### Gate C — state and command safety
- Add durable command ledger and idempotency semantics.
- Test duplicate, delayed, reordered, and uncertain command outcomes.
- Test lease expiry and fencing under network partitions.

### Gate D — client resilience
- Add endpoint discovery, health-aware reconnect, bounded backoff, and resume.
- Test primary loss, secondary loss, routing loss, and recovery.
- Ensure no automatic replay of uncertain writes.

### Gate E — controlled canary
- Migrate only after a stable ingress is available and all previous gates pass.
- Keep Cloudflare primary and retain a tested rollback.
- Canary synthetic traffic first, then explicitly approved low-risk production traffic.
- Monitor error rate, reconnect time, command reconciliation, latency, and saturation.

## Acceptance tests (must pass before production)

- Kill primary gateway while clients are connected: clients reconnect without reinstall or manual endpoint edits.
- Existing WebSockets close cleanly and clients establish new sessions through the secondary.
- A mutation interrupted at every boundary is either confirmed once or reported as unknown; never executed twice.
- Revoked devices remain revoked on both gateways.
- OAuth login and refresh work through both gateways with correct redirect and origin checks.
- Partition the gateways: fencing prevents simultaneous mutation authority.
- Restore primary: failback does not drop valid sessions or duplicate commands.
- Load test expected concurrency and burst behavior on the secondary.
- Verify backup/restore and recovery objectives for all authoritative state.

## Current completion status

- Read-only source and infrastructure audit: completed.
- Isolated feature branch: created.
- This architecture baseline: documented.
- Secondary provider account/resource: not connected or provisioned.
- Shared-state contract and implementation: not implemented.
- Client failover/reconnect: not implemented.
- Stable independent ingress: not configured.
- End-to-end failover tests: not run.
- Production deployment: intentionally untouched.

Do not mark Hybrid Multi-Cloud as complete until every delivery gate and acceptance test is evidenced.
