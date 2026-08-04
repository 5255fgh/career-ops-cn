---
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
title: "refactor: Harden BOSS current-page scanning"
created: 2026-08-04
product_contract_source: ce-plan-bootstrap
origin: user-provided-structured-data-observer-v2
---

# refactor: Harden BOSS current-page scanning

## Goal Capsule

Make search-result scanning safely read only the currently visible BOSS page without synthetic interaction, bind every round to one browser tab and query scope, require authoritative job identity before persistence or AI evaluation, and prevent volatile request locators from leaving the content-script session. Missing network fixtures deliberately defer passive network observation and template replay; they do not block this safety baseline.

## Product Contract

- **R1 — Current page only.** Search scans process the visible page once and never click job cards or pagination controls.
- **R2 — Strict search identity.** Search-derived detail succeeds only when an authoritative job identifier matches and no explicit title/company evidence conflicts. Title plus company alone is insufficient.
- **R3 — Session isolation.** A round stays bound to one `tabId`, `queryScope`, `sessionId`, and content generation. Scope or generation changes interrupt the round.
- **R4 — Account safety.** `login_required`, `challenge`, and `account_risk` are sticky fatal states that abort the round and prevent subsequent persistence, screening, or AI work.
- **R5 — Locator privacy.** Query-bearing detail locators remain in content-script memory. Cross-context contracts, diagnostics, Bridge payloads, and SQLite receive canonical query-free URLs only.
- **R6 — Request governance.** Every BOSS fetch attempt, including retry, observes concurrency 1, the shared throttle, cancellation, and the absolute round deadline.
- **R7 — Failure isolation.** Non-fatal timeout, parsing, identity, persistence, or AI failure skips one job and continues later jobs.
- **R8 — Evidence gate.** With no reviewed `fixtures/boss/network/` evidence, network observer, response classifier, learned templates, and replay are out of scope and must not be guessed.

### Key decisions

1. Search scanning uses direct fetch only; the live-panel fallback and all synthetic click paths are removed. Governs R1, R2.
2. `maxPages` remains as a compatibility field but accepts only `1`; values greater than one fail explicitly. Governs R1.
3. `JobCard.jobId` remains the shared-domain name; content-session messages call the same value `sourceJobId`. No repository-wide rename occurs. Governs R2, R5.
4. The raw request URL is resolved inside content from a session-local locator map. The Side Panel never receives it. Governs R3, R5.
5. Context compaction is not an interruption. Git commits and the external handoff record carry execution state; this plan remains an immutable decision artifact.

## Scope Boundaries

### In scope

- Current-page controller/content behavior and removal of automatic navigation.
- Strict identity for search-page direct fetch.
- Canonical URL enforcement and content-local raw locators.
- Fixed-tab scan sessions, context-change interruption, and fatal push/latching.
- Request-attempt throttle/deadline/cancellation behavior.
- Tests, Side Panel copy, README, and architecture updates.

### Deferred to follow-up work

- MAIN-world fetch/XHR observation, response classification, observed-detail caching, or endpoint-specific fixtures.
- GET template learning or replay.
- Real-site Chrome validation requiring a user-controlled logged-in BOSS session.

### Out of scope

- Automatic application, greeting, chat, contact access, mutation of BOSS data, or support for another platform.
- Push, pull request, deployment, or any external write.

## High-Level Technical Design

```mermaid
sequenceDiagram
    participant C as "ScanController"
    participant CC as "Bound ContentClient"
    participant CS as "Content session"
    participant B as "Local Bridge"

    C->>CC: beginSession()
    CC->>CS: fixed tab begin request
    CS-->>CC: sessionId + queryScope + generation
    C->>CS: extract visible canonical cards
    loop each selected job, concurrency 1
        C->>CS: read detail by stable identity + deadline
        CS->>CS: resolve raw locator in session map
        CS->>CS: request gate then strict identity
        alt verified
            CS-->>C: canonical JobDetail
            C->>B: save, screen, evaluate
        else ordinary job failure
            CS-->>C: isolated failure
        else fatal block
            CS-->>C: sticky fatal event
            C->>C: abort round; no later writes or AI
        end
    end
    C->>CS: endSession and clear locators
```

## Key Technical Decisions

1. **KTD1 — Bound content API.** `beginSession` queries the active tab once and returns a session containing `{sessionId, tabId, queryScope, generation}`. Every subsequent content operation requires that session and uses its fixed tab.
2. **KTD2 — Stable detail request.** The detail-scan request carries session/generation, `sourceJobId`, canonical URL, expected title/company, timeout, and absolute deadline; it never carries the raw locator.
3. **KTD3 — Strict verifier.** Add a dedicated strict identity path rather than changing the compatibility verifier used by standalone details. An exact source/path job-ID match is required, and explicit title/company conflicts veto it.
4. **KTD4 — Fatal event.** A content-originated event contains only session, generation, and account-fatal reason. Both content and controller latch it until session end.
5. **KTD5 — Content request gate.** Throttle state lives where each actual fetch attempt is made so retry cannot bypass it. Time and randomness remain injectable for deterministic tests.

## Implementation Units

### U0. Establish evidence and characterization

**Goal:** Record the evidence NO-GO and protect the old risk surfaces with tests before changing behavior.

**Requirements:** R8 and the existing behavior portions of R1, R2, R5.

**Dependencies:** None.

**Files:** This plan, existing tests under `apps/extension/lib/`, `packages/boss-adapter/test/`, `packages/shared/test/`, and `apps/bridge/test/` as applicable.

**Approach:** Confirm `fixtures/boss/network/` is absent, keep observer/template code out of the diff, and strengthen the smallest existing tests that expose page navigation, live-panel fallback, weak identity, and query-bearing persistence.

**Execution note:** Characterize or create failing proof before production changes where the seam is practical.

**Test scenarios:** Existing three-page defaults and navigation tests identify the behavior to remove; existing live-panel and `securityId` fixtures identify privacy/fallback boundaries.

**Verification:** Evidence gate is explicitly NO-GO, the plan is implementation-ready, and no observer/template production entrypoint exists.

### U1. Enforce current-page, no-click scanning

**Goal:** Remove all automatic navigation and search-page live-panel fallback.

**Requirements:** R1, R7.

**Dependencies:** U0.

**Files:** `packages/shared/src/index.ts`, `packages/boss-adapter/src/selectors.ts`, `apps/extension/entrypoints/content.ts`, `apps/extension/lib/content-client.ts`, `apps/extension/lib/scan-controller.ts`, and their existing tests.

**Approach:** Keep `maxPages` but validate literal `1`; remove advance-page schemas/methods/handlers/controller branches and pagination selectors; make successful search discovery finish with `current_page_complete`; remove live-panel fallback imports, code, and dead helpers.

**Test scenarios:** A page with a next link is processed once without an interaction; `maxPages: 2` fails before creating a run; a first-job detail failure still permits the second job.

**Verification:** Shared, boss-adapter, and extension tests pass; scoped search finds no navigation message or synthetic BOSS click path.

### U2. Add strict identity and locator privacy

**Goal:** Prevent weakly identified or query-bearing detail data from crossing the content boundary.

**Requirements:** R2, R5, R7.

**Dependencies:** U1.

**Files:** `packages/boss-adapter/src/adapter.ts`, `packages/shared/src/index.ts`, `apps/extension/lib/boss-detail-fetch.ts`, `apps/extension/entrypoints/content.ts`, `apps/extension/lib/bridge-client.ts`, Bridge persistence boundaries, and corresponding tests.

**Approach:** Add a strict verifier used only by search scanning; canonicalize outbound detail URLs; build the raw locator map while parsing visible cards; replace the full-card detail message with stable expected identity plus session data; defensively canonicalize Bridge input and sanitize diagnostics.

**Test scenarios:** Title/company-only evidence fails; ID match plus explicit conflict fails; matching authoritative ID succeeds; `securityId` is usable only for content fetch and absent from all outbound/persisted values; missing locator isolates one job.

**Verification:** Adapter, extension, shared, and Bridge tests prove identity and privacy invariants.

### U3. Bind sessions and push fatal state

**Goal:** Keep a round on one tab/scope and stop immediately on account safety blocks.

**Requirements:** R3, R4, R5.

**Dependencies:** U2.

**Files:** Shared message contracts, `apps/extension/lib/content-client.ts`, content-session support under `apps/extension/lib/`, `apps/extension/entrypoints/content.ts`, `apps/extension/lib/scan-controller.ts`, and tests.

**Approach:** Add begin/end session contracts; bind requests to one tab; compare query scope and generation in content; surface context change distinctly; add runtime fatal event subscription and sticky latches; clear locator/session state on end, context change, or fatal.

**Test scenarios:** Switching the browser's active tab does not retarget calls; query change and content reload interrupt; each account-fatal reason aborts waiting/in-flight work and prevents later save/screen/AI; unsupported/empty layouts do not masquerade as account-fatal events.

**Verification:** ContentClient and ScanController tests prove fixed routing, interruption, and zero post-fatal side effects.

### U4. Govern every request attempt

**Goal:** Apply throttle, cancellation, and deadline checks to each direct-fetch attempt and retry.

**Requirements:** R4, R6, R7.

**Dependencies:** U3.

**Files:** Direct-fetch/request-gate implementation under `apps/extension/lib/`, its tests, and controller integration.

**Approach:** Use a session-local single-concurrency gate with 1,800 ms base interval and at most ±20% jitter; acquire it before the first fetch and the sole transient retry; reject waits that exceed the absolute deadline; propagate abort reasons without retrying fatal/context failures.

**Test scenarios:** First attempt and retry both acquire the gate; abort interrupts a delay; a deadline prevents a late retry; an ordinary exhausted retry skips one job and continues; `cacheHits` retains Bridge/evaluator meaning.

**Verification:** Deterministic clock/random tests and controller integration tests pass.

### U5. Synchronize surfaces and run final gates

**Goal:** Make user-facing behavior, documentation, verification, and final review agree with the implementation.

**Requirements:** R1–R8.

**Dependencies:** U1–U4.

**Files:** `README.md`, `docs/architecture.md`, Side Panel view/tests, and only behavior-relevant fixtures/tests.

**Approach:** Replace three-page/automatic-navigation/live-panel language with current-page/direct-fetch behavior; distinguish normal current-page completion from budget stops; run scoped and full checks; inspect WXT manifest for absence of an observer entrypoint; simplify and review the complete diff, then fix eligible findings.

**Test scenarios:** Side Panel renders current-page copy; restored/current runs preserve correct completion reasons; no observer failure is counted per job.

**Verification:** Targeted package tests and `pnpm check` pass; no synthetic interaction or observer entrypoint remains; final Git diff is scoped.

## Verification Contract

- Run focused tests after every implementation unit and keep the tree green before the next unit.
- Required final commands: package tests for shared, boss-adapter, extension, and bridge, followed by `pnpm check`.
- Inspect the built extension manifest/output; an unused MAIN-world observer entrypoint is forbidden.
- Search the BOSS scan path for advance-page contracts, pagination dispatch, `MouseEvent`, and live-panel fallback references.
- Inspect Bridge payload/database tests to prove query-bearing locators cannot persist.
- Run simplification and code review gates on the final non-mechanical diff and apply eligible fixes.

## Definition of Done

- U0–U5 are implemented and represented by meaningful local commits on `codex/boss-safe-scan-v3`.
- Search scans are current-page, direct-fetch-only, no-click, and strictly identified.
- A scan remains on its initial tab and scope; account-fatal state actively aborts the round with no later writes or AI.
- `securityId` and other volatile query data never cross the content-session memory boundary.
- Every fetch attempt and retry obeys concurrency, throttle, cancellation, and deadline rules.
- Ordinary single-job failures remain isolated.
- README, architecture, Side Panel, contracts, tests, and fixtures agree.
- All required checks pass, the branch is not pushed, and the worktree is clean.
- Observer and template replay are accurately reported as evidence-gated follow-up work, never as completed behavior.
