# Owner console

The owner console runs on a separate Worker from the public site. It provides bounded account analytics, user search and details, complimentary Pro grants, reviewed device revocation, website prompt management, private support replies and existing billing actions. A name grid shows at most 20 users per page; details load on demand.

## Identity and storage

Configure a separate GitHub OAuth app for the owner host, with exactly `<OWNER_ORIGIN>/callback`. Keep its client secret in that Worker's secret manager. Both Workers must use the same `PCRC_OWNER_GITHUB_ID`: the numeric GitHub account ID permitted to administer the service. An email address or display name does not grant access.

`ALLOWED_GITHUB_ID` remains the internal storage-hub identity. Do not replace it to change the dashboard owner: doing so would select another namespace for existing account/device data. The public examples use storage ID `1234` and owner sign-in ID `5678`; replace these placeholders deliberately and consistently. If `PCRC_OWNER_GITHUB_ID` is absent, legacy configurations use `ALLOWED_GITHUB_ID` for owner sign-in. Removing the separate setting is therefore an access-policy change, not a safe UI-only rollback.

After verifying the provider ID, the owner callback creates an owner-host session with the actual GitHub principal sealed into it. Previous-owner sessions are rejected before MFA. Administrative cookies are rejected by the public site; ordinary public sign-ins retain their own account identities. Administrative login does not overwrite a customer directory profile.

The public host denies owner routes. The owner host denies public MCP and device routes. POST actions retain exact Origin and CSRF validation. Owner form pages use `Referrer-Policy: same-origin` so native form POSTs retain the Origin header; wrong-account callback pages retain their explicit no-referrer policy. Owner login requests GitHub's account picker.

## Authenticator enrollment

First enrollment requires an owner GitHub sign-in from the last ten minutes. Add the displayed key privately to a time-based authenticator app, verify a current code and save the single-use recovery codes privately. Setup expires after five minutes; five failed codes trigger a ten-minute cooldown. Verified MFA lasts one hour and owner-host login at most 24 hours.

MFA secrets are encrypted. Recovery codes are hashed. Secrets, pending enrollment, throttling and MFA grants are isolated by owner principal, so changing the configured GitHub owner does not reuse an earlier owner's authenticator. There is no public MFA-reset endpoint. Losing both the authenticator and recovery codes requires a separately reviewed operator recovery procedure.

For rollout, deploy shared/public handlers and the owner-ID setting first, then the owner Worker with the matching setting. Old callers fail closed while the settings differ. Preserve shared bindings and proxy secrets. Source publication does not authorize a production deployment.

## Password recovery

Set the existing project's `SUPABASE_URL`, its modern publishable key as `SUPABASE_PUBLISHABLE_KEY`, and the public site's origin as `PCRC_PUBLIC_SITE_ORIGIN` on the owner Worker. Allow the public `/devices/email/callback` redirect in Supabase. Never use a service-role key or disable email confirmation to make recovery tests pass. Production mail delivery needs an appropriately configured provider; a key-health check does not prove inbox receipt.

Owner reset requests use the stored verified address, not an arbitrary form recipient. The request creates encrypted 15-minute PKCE state bound to the selected account, provider subject and unchanged email. Handles are hashed for lookup, single-use and bounded to 128 pending flows. A recipient can finish recovery without the owner's browser cookies. The existing password form still requires its own CSRF token and recovery cookie; completing a password change invalidates previous sessions/grants. Requesting an email alone does not change a password or grant computer access.

The five-minute cooldown prevents duplicate emails. A limited follow-up request does not mean the earlier email failed: use the existing link if it arrived. The UI distinguishes cooldown, provider rate limiting, sender restrictions and interrupted delivery, without displaying raw provider errors. An uncertain email request is never replayed automatically. Expiry, supersession and account deletion clean up pending recovery state.

## Financial and account actions

Complimentary Pro grants are separate from paid subscriptions. On expiry/removal, the existing Free-plan policy retains one selected/first computer and revokes extra connections; an effective paid subscription remains honored. Account deletion retains existing cancellation requirements and confirmation safeguards.

Monthly reports keep currencies separate and include only completed transactions wholly for the configured PCRC price. Mixed/unrelated products are excluded and counted. Earnings reflect available fees/adjustments; estimated profit additionally requires entered monthly costs. Billing-month reports, including later adjustments, are not cash-flow statements or accounting certification. Partial scans are labelled.

Real refunds and subscription cancellations are explicitly deferred for this acceptance batch. Tests use synthetic provider responses; do not infer that money was moved or that live provider permissions were verified.

## Verification

Run the gateway checks from `deploy/cloudflare/worker` using its pinned dependencies:

```text
npm run check
npm test
```

Set `PCRC_SOURCE_ONLY_TESTS=1` for a public source checkout that excludes private release recordings. The suite reports those exclusions as skips. Optional browser tests require an already installed Playwright module and Edge; set `PCRC_OWNER_BROWSER_QA=1` and `PCRC_PLAYWRIGHT_MODULE` to that module's absolute ESM path, then run `node --test tests/owner-console-browser.test.mjs`. No browser dependency is installed by the test.

Evidence includes owner/public account isolation, MFA expiry/replay/throttling, old-owner rejection, stored reset recipients, PKCE binding, one-time consumption, changed-email rejection, separate-browser password recovery, stale-session invalidation, privacy-safe errors and expiry/deletion retention. A SQLite runtime test exercises the public recovery callback. Native browser tests exercise actual form headers and two Reset-button submissions with one mocked email request.

The maintainer reported successful dashboard acceptance and password-reset completion for their test recipient on 15 November 2026. This is user acceptance for the tested workflows, not independent certification of all accounts, all email providers or every PCRC tool. Real refunds, cancellations, customer deletion and universal SMTP delivery remain outside that acceptance.

### Source snapshot checks — 15 November 2026

The curated public source passed TypeScript checking and its Worker suite: **290 passed, zero failed, five skipped** out of 295 tests. The five skips are three opt-in browser tests and two private-recording checks; they are not counted as passes. The three browser tests then passed separately against this source copy, including genuine native form headers and duplicate-reset prevention. No real financial operation or email was submitted by these checks.

Independent source-publication review found no new blocker and passed 22 focused tests. A scan of 440 Git-visible files found no matches for the checked credential patterns, known local private values or owner filesystem paths. This is a bounded source scan, not proof that every possible secret encoding or historic artifact is safe. Public examples retain placeholder identities, disabled live providers and no credential values.

This batch stays on `next`; it does not promote `main`, create another branch, issue a new computer-runtime version, or convert deferred financial tests into accepted results.
