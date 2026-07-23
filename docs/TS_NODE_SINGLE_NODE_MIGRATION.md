# TypeScript / Node.js Single-Node Migration

## Status

The Node migration foundation is implemented locally: Fastify serves the
OpenAI Models, Chat Completions, and Responses routes; SQLite owns imported
accounts, account-pool state, API-key hashes, device-login sessions, and
automation tasks. Token refresh, automatic SSO recovery, device-code fallback,
and a bounded Playwright task runner are active Node modules with regression
coverage. The current Go/Python deployment remains the production owner until
the data-import and live acceptance gates below have passed.

## Decision

Move the project to one TypeScript codebase and one single-node deployment
unit. The target has no Redis and no PostgreSQL:

- SQLite is the durable source of truth.
- Fastify API routing, account-pool selection, scheduled maintenance, and the
  SQLite-backed admin API run in Node.js.
- Short-lived routing state and buffered telemetry live in process memory.
- A bounded Node automation worker keeps SSO conversion, registration,
  device-code login, mailbox handling, and captcha automation recoverable.
- The Node implementation is the default browser executor. Python may remain
  as an on-demand captcha/Playwright fallback when live anti-automation evidence
  shows it is necessary, but it never owns API routing, SQLite, task state, or
  account lifecycle decisions.

This is a deliberate single-active-instance design. It must not be used with
HPA, more than one replica, or a shared SQLite file across nodes.

## Why This Is Safe for the Intended Deployment

The existing production shape solves distributed problems: Redis coordinates
sessions, affinity, inflight counters, leader locks, and browser/job state;
PostgreSQL holds durable account and control-plane state. The approved target
has exactly one active API/worker pair, so distributed coordination disappears.

SQLite is appropriate only because the following are hard deployment rules:

1. `replicas: 1`; HPA is disabled.
2. Rollout uses `Recreate` or a strategy with `maxSurge: 0`, so two writers
   never overlap.
3. The database and browser-profile directories are on one durable RWO PVC.
4. The application obtains a host-level database lock at startup and refuses
   to start if another owner is active.
5. The API process is the only writer. The browser worker sends commands and
   results through authenticated IPC; it never opens a competing SQLite write
   connection.

If any rule stops being true, the deployment must return to PostgreSQL plus a
distributed coordination store instead of attempting to scale SQLite.

## Target Runtime

```text
                         public HTTPS
                              |
                              v
                 +---------------------------+
                 | Node/Fastify process       |
                 | - OpenAI API routes         |
                 | - admin routes/static UI   |
                 | - pool and maintainer      |
                 | - in-memory hot state      |
                 +-----------+---------------+
                             |
                             v
        +------------------------------------------------+
        | /data/grok2api                                 |
        | - app.sqlite (durable state)                    |
        | - browser-profiles/ (protected persistent data) |
        | - traces/ and screenshots/ (retained evidence)  |
        +------------------------------------------------+
```

The API process starts exactly one durable task worker. A worker crash must
leave the API healthy and its lease recoverable. The public model surface is
restricted to OpenAI Models, Chat Completions, and Responses; browser, captcha,
registration, SSO, and device operations are available only through the
administrator-protected management surface.

## Technology Boundaries

### Node and TypeScript

Use Node 22.22.x and compile all application code with strict TypeScript
settings. Fastify is the HTTP boundary. Keep framework-specific code isolated;
the account pool, token lifecycle, task state machine, and automation contracts
must be framework-independent TypeScript modules.

SQLite access is behind a `SqliteStore` interface. Node provides `node:sqlite`,
but its feature status must be confirmed in the pinned runtime image during the
foundation POC. The domain layer must not depend directly on a particular
SQLite driver, allowing a replacement without changing account or task logic.

### Browser Automation

Playwright is the baseline Node automation engine. Browser launch is an
adapter, not a direct dependency of registration or SSO workflows:

```ts
interface BrowserLauncher {
  launch(input: BrowserLaunchInput): Promise<BrowserSession>;
}
```

The first adapter is standard Playwright. A Camoufox-compatible Node adapter is
a separate POC. It must pass the real SSO conversion, registration, and
device-code login suites before it becomes the default for anti-automation
paths. A package claiming API compatibility is not evidence of equivalent
fingerprint, proxy, cookie, or captcha behavior.

If those live suites show that the Node adapter is less reliable, the same
durable task contract may invoke an isolated Python browser executor. That
executor receives one bounded task, returns only the normalized result, and
exits; it does not open SQLite, expose a service, or become a second scheduler.

Browser profiles, cookies, and local storage are secrets. Store them under the
protected data volume, never in the repository, task logs, traces, or admin
responses. Redact tokens, passwords, captcha answers, mailbox keys, and SSO
cookies from every structured log.

A successful Node registration browser workflow must finish with an
authenticated xAI browser context containing an `sso` or `sso-rw` cookie. The
registration runner extracts that cookie inside the browser context, exchanges
it for OIDC tokens, synchronously stores the resulting account in SQLite, and
returns only account metadata. It never writes the cookie or mailbox JWT into
an automation result. A workflow that never reaches an authenticated xAI
session is a failed registration, not a completed browser task.

For an account created by this runner, its Cloudflare address JWT is stored
only in that account's SQLite payload. The `POST /admin/api/accounts/:id/email-login`
task can then fill `{{account.email}}`, trigger a fresh email code, use
`fill_mail_code` to read that same inbox, and restore the target account from
the new SSO cookie. Legacy/imported accounts without that private mailbox
credential must use the durable device-login fallback instead.

### Node Runtime Configuration

The Node target reads only `GROK2API_XAI_UPSTREAM_BASE_URL` for direct xAI
completion traffic. The production template explicitly uses the first-party
CLI Responses endpoint `https://cli-chat-proxy.grok.com/v1` and deliberately
ignores the old CPA proxy variable. Set `GROK2API_CFMAIL_BASE_URL`,
`GROK2API_CFMAIL_API_KEY`, and optionally `GROK2API_CFMAIL_DOMAIN` for the
sole supported registration mailbox provider: Cloudflare Temp Mail.

`node/deploy/` contains a single-replica Kubernetes template plus deliberately
suspended exporter and importer Jobs. The exporter uses a separate
GitHub-Actions-built migration image inside the cluster, so it can resolve the
private PostgreSQL Service without exposing a database port. The Node PVC is
separate from the legacy data PVC so the PostgreSQL/Redis volumes remain a
rollback artifact until the acceptance window has closed. The runtime template
accepts no Redis, PostgreSQL, Python-sidecar, CPA, Sub2API, or Anthropic
configuration.

## State Ownership and Write Policy

| State | Owner | Storage | Write rule | Restart behavior |
|---|---|---|---|---|
| Accounts and fresh access/refresh tokens | API | SQLite | Commit before reporting success | Must survive |
| SSO recovery result and cooldown | API | SQLite | Commit immediately | Must survive |
| API keys, admin password, settings, models | API | SQLite | Commit immediately | Must survive |
| Automation task, lease, event, result | API | SQLite | State transition per event | Recover from lease |
| Account durable cooldown/quota/enable state | API | SQLite | Commit immediately | Must survive |
| Pool inflight count and round-robin cursor | API | Memory | No write-behind required | Rebuild/reset safely |
| Conversation affinity | API | Memory | TTL only | Safe to lose |
| Request telemetry and usage counters | API | Memory + SQLite | Batch every configured interval or count | Lose at most unflushed telemetry |
| Browser process state | Worker | Memory + SQLite task state | Persist milestones only | Reclaim task |

The token rule is non-negotiable: after a successful refresh, SSO recovery, or
device login, the new credential is synchronously committed to SQLite before
the operation returns success. Batching token writes would reintroduce the
current "renewed then lost on restart" failure mode.

Usage, request logs, and non-security counters may use a bounded write-behind
buffer. The buffer must flush on a timer, on a maximum event count, and during
graceful shutdown. It may never hold account credentials or account eligibility
changes.

The Node runtime implements this policy with `GROK2API_USAGE_FLUSH_INTERVAL`
and `GROK2API_USAGE_FLUSH_BATCH`. Each record has a request ID unique in
SQLite, so retrying a flush cannot double-count a request.

The Node administrative API reads safe account summaries only; raw account
payloads, OAuth tokens, SSO cookies, device codes, mailbox JWTs, and API-key
hashes are never returned. New API-key secrets are returned only by their
create or regenerate response and are persisted as SHA-256 hashes.

## SQLite Model

The new schema is not a mechanical PostgreSQL dump. It preserves externally
observable behavior while using SQLite-native types:

| Current logical data | SQLite target | Notes |
|---|---|---|
| `accounts` | `accounts` | Preserve ID, email, identity fields, payload JSON, expiry, version, timestamps. |
| `account_pool` | `account_pool` | Preserve enable, quota, cooldown, model blocks, counters, last failure/probe, and SSO recovery fields. |
| `api_keys` | `api_keys` | Preserve key IDs/prefixes/hashes and usage totals; never export plaintext keys in audit data. |
| `app_settings` | `app_settings` | JSON values as validated text. |
| `models` | `models` | Preserve visibility, sort order, metadata, and fetched timestamps. |
| `usage_events`, `usage_daily` | same names | Keep event detail and daily aggregates; retain event ID ordering. |
| `task_logs`, `admin_audit_logs` | same names | Preserve admin history and operational diagnostics. |
| Python/Redis registration and SSO session maps | `automation_tasks`, `automation_task_events`, `device_login_sessions` | Replace process/Redis-only job state with recoverable durable tasks and restart-safe device-code polling. |
| `registration_config` and browser metadata | `automation_config`, `browser_profiles` | Store on the protected single-node PVC; profile records contain metadata only. |

Use integer epoch milliseconds for timestamps, `INTEGER` for booleans, `TEXT`
with JSON validation for JSON payloads, and `INTEGER PRIMARY KEY` for local
event IDs. Enable `foreign_keys`, WAL journaling, and a bounded `busy_timeout`.
Begin with durable synchronous settings for credential mutations; only relax
settings after power-loss and restart tests demonstrate an acceptable tradeoff.

Schema migrations are forward-only, checksummed, and run before the API accepts
traffic. A database backup is taken before every schema migration and before
every production import.

### Canonical Snapshot Export and Import

The one-shot migration tool reads the legacy PostgreSQL database through
`GROK2API_DATABASE_URL` (or `DATABASE_URL`) and writes a private, versioned
snapshot with `npm run export:legacy-snapshot -- <snapshot.json>`. It writes
the file atomically with owner-only permissions and prints only output path,
record counts, and an inventory checksum. It contains account payloads and
therefore must remain on the protected migration host and data volume.
Legacy `sub2api`, `cliproxyapi`, and CPA integration settings are deliberately
excluded by both tools and reported only as a skipped-setting count.

The Node importer accepts that `schema_version: 1` JSON snapshot through
`npm run import:legacy-snapshot -- <snapshot.json>`. A full snapshot contains
`accounts`, optional `account_pool`, `api_keys` (hashes only), `models`,
`settings`, and operational history. Historical usage events and daily
aggregates are restored into the live SQLite usage tables without changing
imported API-key totals; task and admin audit records are retained in a
protected legacy-history table. It is validated before any write and committed
in one SQLite transaction. The import report contains only counts plus
inventory and credential checksums; it never prints credential values, API key
material, SSO cookies, mailbox credentials, or passwords.

The source export must preserve account payloads, pool references, API-key
SHA-256 hashes, model visibility, settings values, usage history, and task/audit
records. A pool reference to an account missing from the same snapshot is a
hard failure. Import rehearsal must compare the report counts and checksums
with the legacy export before cutover.

## Automation Task State Machine

All long-running browser work uses the same durable task state machine:

```text
queued -> leased -> running -> waiting_input -> running
   |        |          |             |              |
   +--------+----------+-------------+--------------+
                            |              |
                        succeeded        failed
                            |
                        consumed
```

- Every submission carries an idempotency key.
- A lease has an expiry and worker identity; an expired lease is reclaimed on
  API startup. Device-code values are stored only in protected SQLite and are
  never returned by management APIs, task results, or logs.
- `waiting_input` is for a device-code scan, manual captcha, or operator
  confirmation. It is durable and visible to the admin UI.
- Task attempts use capped exponential backoff with a classified reason.
- Success writes the resulting account/token state in the same SQLite
  transaction as the terminal task event.
- Cancellation is cooperative; an operator action stops the browser context and
  records a terminal event.

This replaces Redis sessions, registration batches, device sessions, and SSO
import job keys. It also gives SSO token recovery a safe retry cooldown instead
of repeated automated login attempts.

## Compatibility Contract

The public route surface remains stable throughout the migration:

- OpenAI-compatible `/v1/models`, `/v1/chat/completions`, and `/v1/responses`.
- No Anthropic Messages compatibility route is a migration target.
- No Sub2API or CPA client/protocol integration is a migration target. The
  direct first-party xAI upstream is explicitly configured before Chat or
  Responses requests are enabled.
- Health, readiness, metrics, static admin pages, and every existing
  `/admin/api/*` route.
- Account import/export, registration, SSO import, device login, maintainer,
  model health, logs, usage, and settings behavior.

Before an endpoint moves, capture contract fixtures from the current server:
request body, headers, status, response JSON, SSE frame order, content type,
and meaningful error code. Fixtures must redact credentials. New Node handlers
must pass the same fixture suite before receiving live traffic.

Browser workflows use a separate black-box contract: input configuration,
observable milestones, normalized output bundle, error class, and a post-run
account usability probe. The legacy Python paths are the oracle during the
transition, not a source of implementation-level coupling.

## Migration Phases

### Phase 0: Freeze Contracts and Establish Evidence

1. Add a route inventory and redacted golden fixtures for API/admin/SSE paths.
2. Capture current account, model, key, pool, and settings counts plus
   deterministic checksums for non-secret canonical fields.
3. Record live baseline evidence for one registration, one SSO conversion, one
   device login, one refresh/SSO recovery, and one streamed completion.
4. Back up PostgreSQL and the current persistent data volume.

Exit gate: fixture coverage exists for every public route family and all three
browser workflows have a recorded success/failure vocabulary.

### Phase 1: TypeScript Foundation Without Production Ownership

1. Create the TypeScript workspace with `api`, `browser-worker`, `domain`,
   `automation`, `storage`, and `contracts` modules.
2. Implement configuration validation, structured redacting logger, health
   endpoints, IPC authentication, and the SQLite migration runner.
3. Add a SQLite driver POC for WAL, restart recovery, backup/restore, and
   concurrent API/worker command patterns.
4. Add browser-launch POCs for standard Playwright and the candidate Camoufox
   adapter. No production route moves in this phase.

Exit gate: no secrets appear in logs; database survives forced restart; the
worker cannot create a second active writer; browser trace artifacts are
generated and redacted correctly.

### Phase 2: Data Import and Read-Only Parity

1. Build a versioned PostgreSQL-to-canonical-JSON export tool.
2. Build a canonical-JSON-to-SQLite importer that validates IDs, JSON, foreign
   references, timestamps, and per-table counts before committing.
3. Import a sanitized production-shaped snapshot into SQLite.
4. Move model, account, status, usage-read, and admin read-only routes to Node
   in a local/shadow environment; compare responses against Go fixtures.

Exit gate: account IDs, pool state, enabled/quota counts, model IDs, settings,
and API-key hashes match the source snapshot exactly. No credentials are
printed by either tool.

### Phase 3: Core Request Path and Account Pool

1. Implement authentication, account candidate selection, affinity, cooldown,
   upstream request execution, error classification, and SSE forwarding.
2. Keep affinity/inflight counters in memory and rebuild durable eligibility
   from SQLite at startup.
3. Implement immediate durable writes for pool failures, quota changes, and
   token replacement; use buffered writes only for telemetry.
4. Move OpenAI Chat Completions and Responses routes one family at a time through
   fixture tests and a non-production canary.

Exit gate: ordinary and streaming completions preserve response semantics;
restart during a stream does not corrupt durable account state; pool selection
never chooses a disabled or durable-cooldown account.

### Phase 4: Maintenance and Recovery

1. Implement a single in-process scheduler for refresh, SSO fallback recovery,
   model health, cleanup, and telemetry flush.
2. Port the current SSO recovery policy: refresh first, SSO reauthentication
   for permanently invalid refresh tokens, cooldown on SSO failure, and manual
   device-code login when automated SSO cannot recover.
3. Persist every recovery outcome, but restrict the scheduler to bounded
   concurrency and one active task per account.

Exit gate: a forced expired-refresh fixture follows the expected refresh -> SSO
recovery -> cooldown/manual-login path without repeated login storms.

### Phase 5: Browser Automation Port

1. Port mailbox provider adapters and registration orchestration behind the
   durable task state machine.
2. Port SSO cookie conversion and device-code login, preserving current error
   classes and credential output schema.
3. Validate standard Playwright on all three live workflows.
4. Validate the Camoufox adapter separately on anti-automation-sensitive
   variants. Route by workflow only after evidence supports it.
5. Keep Python available as an on-demand browser fallback until all success,
   failure, cancellation, and restart-recovery cases meet the acceptance
   window; retain it afterward only if live evidence still justifies it.

Exit gate: registration, SSO conversion, and device login each pass repeated
live tests and result in accounts that pass an authenticated upstream probe.

### Phase 6: Production Cutover and Decommission

1. Stop automated registration and maintenance on the old stack.
2. Take final PostgreSQL/data-volume backups and create a canonical export.
3. Import to SQLite, validate counts/checksums, and run read-only smoke tests.
4. Start the Node target as the only active writer with the browser worker
   disabled initially; verify public read paths and a safe completion canary.
5. Enable maintenance, then browser automation in small bounded batches.
6. Keep the old image, PostgreSQL volume, and Redis volume for the agreed
   rollback window. A Python browser fallback may remain after that window only
   as a stateless, on-demand executor. Remove the old API/database runtime only
   after the evidence review is complete.

## Rollback

An instant dual-write rollback is intentionally excluded because it risks
divergent token state. Rollback is an explicit, short maintenance operation:

1. Stop Node maintenance and browser tasks.
2. Export the latest canonical account/pool/settings state from SQLite.
3. Restore/start the preserved Go/Python/PostgreSQL deployment.
4. Import the canonical account state into PostgreSQL, validate account IDs and
   credential checksums, then re-enable its scheduler.

Before any Node credential mutation, the unchanged PostgreSQL backup permits a
faster emergency restore. After mutation, the canonical reverse export prevents
silently discarding newly refreshed credentials. Every cutover rehearsal must
exercise this path before production approval.

## Acceptance Criteria

The project is not considered migrated until all of the following are true:

1. The deployment has one active API/worker owner and rejects a second owner.
2. There is no runtime Redis or PostgreSQL dependency.
3. A clean restart preserves accounts, fresh tokens, account status, API keys,
   settings, and recoverable browser tasks.
4. API/admin fixtures, including streaming SSE fixtures, pass against Node.
5. The latest account inventory and metadata checksum match after import and
   after a migration rehearsal.
6. Refresh, SSO recovery, manual device login, registration, and captcha paths
   work in live evidence tests; each created/recovered account completes a
   subsequent authenticated upstream probe.
7. Browser failures are bounded, observable, redacted, cancellable, and do not
   block API traffic.
8. Usage batching loses at most the configured telemetry window, while no token
   or account eligibility mutation is delayed.
9. A full cutover and reverse-import rollback rehearsal have passed.

## Explicit Non-Goals

- Scaling the SQLite deployment beyond one active node.
- Publishing browser worker, captcha, registration, SSO, or device-login ports.
- Treating a Node Camoufox package as proof of browser-fingerprint equivalence.
- Forcing captcha or Playwright execution into Node when repeated live evidence
  shows the isolated Python executor is more reliable.
- Delaying writes of newly issued credentials to reduce I/O.

## References

- Current Go/Python ownership: `docs/ARCHITECTURE_GO_PYTHON_BOUNDARY.md`
- Current Python sidecar surface: `docs/PYTHON_SIDECAR.md`
- Registration contract: `contracts/registration-v1.openapi.json`
- Node SQLite API: <https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html>
- Playwright language support: <https://playwright.dev/docs/languages>
- Playwright browser deployment: <https://playwright.dev/docs/browsers>
