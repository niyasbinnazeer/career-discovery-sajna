# Career Intelligence Analyzer (Sajna) — Project Handover

**Owner:** Niyas — building this for his sister, Sajna Saliyath
**Candidate:** Sajna Saliyath — Civil Engineer / Quantity Surveyor, Dubai-based on a
Spouse Visa (no employer sponsorship needed)
**Purpose:** Automated job discovery, AI fit-scoring, and application tracking for
Document Controller / Project Coordinator / Client Coordinator / Quantity Surveyor /
Junior Quantity Surveyor / Geotechnical Engineer / Admin Assistant roles in
Dubai and Sharjah, minimum AED 4,000/month.
**Status as of this handover:** **NOT WORKING END-TO-END YET.** The architecture is
fully built and matches Niyas's own (automated, no-extension) stack, but the Jooble
integration — currently the only real discovery source — is failing with an
unresolved `403` error. See §5 "Current blocking issue" — this is the very next
thing to fix, and the last message in this conversation is an open question to
Niyas that hasn't been answered yet.

This is a parallel build of the same architecture used for Niyas's own job search
and (originally) for Sudakshina's. Separate Cloudflare Workers, separate KV
namespace, separate GitHub repo intended, separate keys. Built to mirror Niyas's
own stack exactly, per his explicit instruction after sharing his own project's
handover document mid-conversation.

---

## 1. How this project evolved (read this before assuming anything about "the current design")

This was built in two distinct passes, and it matters which one is live:

1. **First pass (discarded):** A Chrome-extension-based version mirroring the
   *original* Sudakshina architecture — manual "Analyze current page" button,
   Anthropic Haiku only, no discovery automation. Full deploy steps were given
   for this version.
2. **Second pass (current):** Niyas then shared his own project's handover
   document and gave three explicit corrections:
   - No Chrome extension
   - Not using the Anthropic key as primary — using Gemini
   - Replicate his own (Niyas) stack's architecture exactly

   Everything was rebuilt from scratch around this: GitHub Actions discovery
   on a cron, Gemini 3.1 Flash-Lite primary with Anthropic Haiku 4.5 fallback
   on 429/503, paginated dashboard, direct-apply-link resolution, KV dedup via
   direct Cloudflare REST API writes from the discovery script.

**The current, intended architecture is the second pass. All Chrome extension
files from the first pass should be treated as dead/unused** — they were never
referenced again after Niyas's correction and are not part of the deploy
checklist below.

---

## 2. Architecture (current, intended)

```
GitHub Actions (career-discovery-sajna repo — NOT YET CONFIRMED CREATED, see §6)
  discovery_sajna.mjs
    → queries Jooble (ae.jooble.org, combined keywords, 2 calls/run)
      ⚠️ CURRENTLY BROKEN — see §5
    → Indeed scraper exists but is DISABLED (ENABLE_INDEED = false in the file)
      — confirmed blocked with HTTP 403 on every request from GitHub Actions'
      IP range on its one live test run
    → NaukriGulf: NOT built. Confirmed via direct fetch to be a fully
      client-rendered SPA — a plain fetch() gets zero job data, no way around
      this without a headless browser or a paid scraping service. Niyas chose
      to skip it for now rather than build either.
    → dedupes against KV directly via Cloudflare REST API
    → resolves the real off-aggregator apply link (HTML-body extraction)
    → POSTs each surviving job to the analyzer worker
    → writes dedup keys directly to KV via Cloudflare REST API
        ↓
Cloudflare Worker: career-intelligence-api-sajna (deploy status unconfirmed — see §6)
    → scores the job against Sajna's profile (Gemini 3.1 Flash-Lite primary,
      Anthropic Haiku 4.5 fallback on 429/503)
    → auto-saves the full record to KV, including directApplyUrl
        ↓
KV namespace: career_jobs_sajna (creation status unconfirmed — see §6)
        ↓
Cloudflare Worker: career-dashboard-sajna (deploy status unconfirmed — see §6)
    → serves the dashboard UI + REST API (paginated reads, updates, delete, export)
        ↓
Dashboard: https://career-dashboard-sajna.niyasbinnazeer.workers.dev/?key=sajna-2026
```

**Important — nothing in §6 (Cloudflare KV namespace, both Workers deployed with
their bindings/secrets, the GitHub repo with its 5 secrets) has been confirmed
done in this conversation.** All testing so far has been Niyas running
`discovery_sajna.mjs` directly (via a GitHub Actions run, based on the log
format — "Run node discovery_sajna.mjs" is GitHub Actions' own step-log prefix,
not a local terminal). Whether the analyzer/dashboard Workers actually exist and
work has never been verified in this conversation. Don't assume they're live.

---

## 3. Candidate profile (hardcoded in `career-intelligence-api-sajna.js`'s system prompt)

- **Sajna Saliyath** — Civil Engineer & Quantity Surveyor, Dubai, UAE
- **Visa:** Spouse Visa — already UAE-resident, no sponsorship needed (flagged
  as a candidate strength throughout scoring)
- **Education:** M.Tech Civil Engineering (2017) + B.Tech Civil Engineering
  (2014), both Kerala; Quantity Surveying Certification, Carbon Blue Global
  (Entri), 2026
- **Experience (4+ years):**
  - Project & Client Coordinator, Technopoint Technical Services LLC, Dubai
    (2021–2024) — subcontractor/vendor coordination (10+), budget monitoring,
    AutoCAD, client/PM liaison, progress reporting
  - Junior Quantity Surveyor (Post-Contract, Trainee), Armada Contracting LLC,
    Dubai (Jan–Apr 2019) — BOQ, quantity takeoffs, variations, payment certs
  - Design Engineer, ECI Renewable Energy Consultants, Kerala (2014–2015)
- **Tools:** AutoCAD, Primavera P6, PlanSwift, MS Excel
- **Languages:** English, Malayalam, Hindi, Tamil

**Search parameters:**
- Locations: Dubai, Sharjah only
- Roles: Document Controller, Project Coordinator, Client Coordinator,
  Quantity Surveyor, Junior Quantity Surveyor, Geotechnical Engineer,
  Admin Assistant
- Minimum salary: AED 4,000/month (analyzer flags/penalizes anything
  disclosed below this; discovery pre-filters obvious cases)

**Scoring tiers** (full detail in the worker's system prompt):
- Tier 1 (80–100): direct QS/coordination/document-control match in Dubai/Sharjah
- Tier 2 (65–79): contracts admin, estimator, procurement coordinator, or
  strong-function-match roles elsewhere in UAE
- Tier 3 (45–64): generic admin, facilities coordination, junior/graduate
  geotechnical roles (she has civil engineering education but no hands-on
  geotechnical field experience — deliberately capped here, not Tier 1)
- Tier 4 (20–44): hands-on geotechnical/site-supervision roles she lacks
  experience for, roles outside UAE
- Tier 5 (0–19): unrelated fields entirely

`resumeVersion` enum: `Quantity Surveying` / `Project Coordination` /
`General Admin` / `""`

Schema also includes `country`, `directApplyUrl` (populated by discovery's
link-resolution step).

---

## 4. Where each secret/credential lives (intended — not yet confirmed set up)

**GitHub repo secrets** (`career-discovery-sajna` repo → Settings → Secrets and
variables → Actions):

| Secret | Purpose | Status |
|---|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account ID | Not confirmed set |
| `CF_API_TOKEN` | Cloudflare token, Workers KV Edit permission | Not confirmed set |
| `CF_KV_NAMESPACE_ID` | ID of `career_jobs_sajna` namespace | Not confirmed set — namespace itself not confirmed created |
| `CAREER_ANALYZER_URL` | `https://career-intelligence-api-sajna.niyasbinnazeer.workers.dev` | Worker not confirmed deployed |
| `JOOBLE_API_KEY` | **Separate key from Niyas's own**, per original instructions — **but see §5, this may be the actual bug** | Set, but currently failing with 403 |

**Cloudflare Worker secrets** (`career-intelligence-api-sajna` → Settings → Variables):

| Secret | Purpose | Status |
|---|---|---|
| `GEMINI_API_KEY` | Separate Google AI Studio key from Niyas's own stack | Not confirmed set |
| `ANTHROPIC_API_KEY` | Fallback only, on Gemini 429/503 | Not confirmed set |

---

## 5. Current blocking issue — Jooble 403 (UNRESOLVED, read carefully)

This is the most important thing to hand over. Here's the full sequence,
in order, so nothing gets re-litigated from scratch:

### 5.1 What happened, in order

1. **First live run:** Jooble returned `found: 0` with **zero errors** across
   every keyword/location combo — the HTTP call succeeded, parsed as valid
   JSON, but the `jobs` array was empty every time.
2. **Diagnosis (via Jooble's own official docs, confirmed by direct fetch of
   their help center):** Jooble runs a separate API domain per country, each
   with its own domain-locked key. A key registered on the default
   `jooble.org` is scoped to **US listings only** — querying it with a UAE
   location silently returns `200 OK` with an empty array, not an error. Fix
   applied: switched the endpoint to `https://ae.jooble.org/api/{key}`, with
   an instruction that Niyas needed a **new key registered specifically at
   `ae.jooble.org/api/about`** (the old key would not work at the new URL).
3. **Same pass, second finding:** Jooble's free tier is a **lifetime total of
   500 requests, not daily** (also confirmed via their docs — this corrects
   what Niyas's own Niyas-stack handover had assumed was an ambiguous
   daily/monthly cap). Fixed by combining all 7 role keywords into a single
   comma-separated call per location (Jooble's own docs support this format),
   cutting Jooble calls from 14/run to 2/run, and changing the cron from
   every 3 hours to once daily — ~250 days of runway on the budget.
4. **Second live run (after the domain + key fix):** Jooble now returns
   `403`, but as a **full styled HTML error page** (page title "Error 403",
   `<link rel="apple-touch-icon">`, `robots noindex` meta tag, references to
   `/css/images/logos/logo2.svg`) — **not** the clean JSON error Jooble's own
   docs describe for an invalid key. This mismatch is the whole reason this
   became a deeper investigation rather than a one-line fix.
5. **Hypothesis at this point:** a styled HTML 403 looks more like an
   edge/WAF-level block on the request itself (e.g. because Node's `fetch()`
   sends no `User-Agent` header by default) than an application-level "bad
   key" rejection. Added a browser-like `User-Agent` and `Accept:
   application/json` header to `queryJooble()`.
6. **Third live run (after the User-Agent fix):** **Identical HTML 403,**
   byte-for-byte the same error page. The User-Agent theory did not hold.
7. Niyas was asked to run the isolated `curl` command from the README's §0.1
   directly (bypassing the script and GitHub Actions entirely) to determine
   whether this is a bad/inactive key or an IP-level block. **That curl test
   was not run** — instead Niyas reported: **"It is working in other job
   analyzers"** — i.e., Jooble apparently works fine in a different stack
   (almost certainly his own Niyas stack, but this was not confirmed).

### 5.2 Why that last message changes everything

If Jooble genuinely works in Niyas's own stack for UAE/Dubai results, **the
entire `ae.jooble.org` domain-lock diagnosis in step 2 above may be wrong**,
or at minimum doesn't apply the way Jooble's docs suggest it should. That
would mean:
- The correct fix might be to **revert `queryJooble()` back to the plain
  `https://jooble.org/api/{key}` endpoint** and just use whatever key
  already works in Niyas's own stack for Dubai/UAE — not a new
  `ae.jooble.org`-specific key at all.
- The `403` HTML error page might simply be `ae.jooble.org` rejecting a key
  that was never registered there (i.e., an account-mismatch error, not a
  WAF block) — which would explain why the User-Agent header fix did
  nothing, since that was never the actual problem.

**This was left as an open question to Niyas, unanswered as of this
handover:**
1. Does "the other job analyzer" mean the Niyas stack specifically?
2. What URL does that stack's Jooble integration actually call — plain
   `jooble.org`, or a country-specific subdomain?
3. Does that stack's Jooble integration actually return real Dubai/UAE
   results, or does it only search elsewhere (which would mean it isn't
   actually proof against the domain-lock theory)?
4. If possible, share the exact fetch call/base URL (key redacted) so it can
   be compared directly against what's failing here.

### 5.3 What to do next on this specific issue

- **Get the answer to the four questions above before changing the code
  again.** Two theories have already been tried and failed (domain switch,
  User-Agent header) — a third blind guess isn't a good use of the
  remaining Jooble request budget or Niyas's time.
- **Most likely correct next step, pending confirmation:** if Niyas's own
  stack uses plain `jooble.org` and genuinely gets Dubai/UAE results back,
  revert `queryJooble()`'s endpoint to `https://jooble.org/api/${JOOBLE_API_KEY}`
  and have Niyas either reuse his own working key (contradicts the earlier
  "register a separate key" guidance, but only if a shared key turns out to
  be how Jooble's regional access actually works) or register a fresh
  `jooble.org` (not `ae.jooble.org`) key for Sajna specifically.
- **Still worth running once, regardless of the above:** the isolated `curl`
  command from README §0.1, against whichever URL turns out to be correct.
  It removes Node/script/GitHub-Actions as variables entirely and gives an
  unambiguous yes/no on whether the key itself works.
- **Do not trigger more full GitHub Actions runs to test this.** Each run —
  including failed ones — has been going through as real requests against
  the 500-lifetime budget on whatever key is configured. Use the curl
  command for iteration; only run the full workflow once there's real reason
  to expect success.

---

## 6. Deployment status — what to verify before assuming anything works

None of the following has been confirmed done in this conversation. Before
debugging anything further, confirm:

- [ ] Cloudflare KV namespace `career_jobs_sajna` — created?
- [ ] Worker `career-intelligence-api-sajna` — deployed, with `GEMINI_API_KEY`
      + `ANTHROPIC_API_KEY` secrets and `JOBS_KV` binding set?
- [ ] Worker `career-dashboard-sajna` — deployed, with `JOBS_KV` binding set?
- [ ] `/debug` endpoint on the analyzer worker — returns `"ok": true`?
- [ ] Dashboard URL — loads without a 401?
- [ ] GitHub repo `career-discovery-sajna` — created, with `discovery_sajna.mjs`
      at root and `discovery_sajna.yml` under `.github/workflows/`?
- [ ] All 5 GitHub Actions secrets set (see §4 table)?

Given the Jooble 403 is blocking any real end-to-end test, it's possible some
of the above genuinely hasn't been done yet, or has been done but never
verified working. Don't assume — check each one.

---

## 7. Current file inventory

All in `/mnt/user-data/outputs/sajna-career-stack/` as of this handover:

| File | Deploys to | Status |
|---|---|---|
| `career-intelligence-api-sajna.js` | Cloudflare Worker `career-intelligence-api-sajna` | Built, `node --check` passes. Deploy status unconfirmed. |
| `career-dashboard-sajna.js` | Cloudflare Worker `career-dashboard-sajna` | Built, `node --check` passes. Deploy status unconfirmed. |
| `discovery_sajna.mjs` | GitHub repo `career-discovery-sajna`, root | Built, `node --check` passes. **Jooble integration currently non-functional — see §5.** Indeed disabled via `ENABLE_INDEED = false`. NaukriGulf not implemented. |
| `discovery_sajna.yml` | GitHub repo, `.github/workflows/discovery_sajna.yml` | Cron once daily (06:00 UTC) + manual dispatch. |
| `README-sajna.md` | Reference doc | Contains full deploy steps, the Jooble troubleshooting section (§0/§0.1), and source-by-source rationale for what's included/excluded. |
| `HANDOVER-sajna.md` | This document | — |

**Not part of the current design** (built in the first pass, superseded):
`manifest.json`, `panel.html`, `panel.js`, `background.js`, `content.js` — a
full Chrome extension was built and then explicitly dropped per Niyas's
instruction. If these still exist anywhere in outputs from earlier in the
conversation, they're dead files.

---

## 8. Key learnings for future reference

- **Jooble's documented behavior and Niyas's own working stack may be in
  tension — this is unresolved, not confirmed either way.** Don't trust the
  domain-lock theory as settled fact until Niyas's answer comes back. This
  handover exists partly because two code changes were made based on
  Jooble's docs before that contradiction surfaced, and both failed to fix
  the actual problem.
- **A styled HTML error page vs. a clean JSON error is a meaningful
  diagnostic signal**, not a cosmetic detail — it's what triggered the
  (ultimately unconfirmed) WAF/edge-block hypothesis here. Worth paying
  attention to response *shape*, not just status code, when a documented API
  behaves unexpectedly.
- **Free-tier API limits are worth verifying directly against the provider's
  own docs, not assumed from a working stack's prior handover.** The
  "500/day" assumption in Niyas's own stack's handover turned out to be
  wrong (it's 500 lifetime) once actually checked — the same handover
  chain-of-assumption risk could easily repeat itself if this document's
  claims aren't re-verified when they start to matter.
- **Every GitHub Actions run — including failed ones — spends real request
  budget on whatever key is live.** Isolate problems with a direct `curl`
  call before re-running the full workflow, especially against a
  lifetime-capped free tier.
- **Confirming infrastructure exists is separate from confirming code is
  correct.** This entire conversation debugged `discovery_sajna.mjs` in
  isolation; the Cloudflare Workers and KV namespace it depends on were
  never verified as actually deployed. Don't assume deploy steps that were
  *described* were also *completed*.
- **When a person says "it's working elsewhere," get the specifics before
  changing code again.** It's tempting to immediately revert to whatever
  the working version does, but without confirming *what* the working
  version actually does (which URL, which key, does it even test the same
  scenario), a third guess is exactly as risky as the two that already
  failed.
