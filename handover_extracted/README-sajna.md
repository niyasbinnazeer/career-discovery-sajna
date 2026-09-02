# Career Intelligence Analyzer — Sajna instance (automated, no extension)

Rebuilt to match your own (Niyas) stack exactly: GitHub Actions discovery on a
cron, Gemini 3.1 Flash-Lite as the primary scoring model with Anthropic Haiku
4.5 as a 429/503 fallback, a paginated dashboard, and direct-apply-link
resolution. No Chrome extension — everything runs automatically.

Built for **Sajna Saliyath** — Civil Engineer / Quantity Surveyor, Dubai-based
on a Spouse Visa (no sponsorship needed).

Search parameters (baked into the discovery script and the analyzer's system prompt):
- **Locations:** Dubai, Sharjah
- **Roles:** Document Controller, Project Coordinator, Client Coordinator,
  Quantity Surveyor, Junior Quantity Surveyor, Geotechnical Engineer, Admin Assistant
- **Min salary:** AED 4,000/month (jobs with an explicit lower salary are
  pre-filtered by discovery to save API calls; anything else is scored and
  flagged by the analyzer if it falls short)

---

## 0. Fixes from the first live runs — action required

The first runs showed 0 jobs discovered from either source. Three separate
problems, now fixed in this version of `discovery_sajna.mjs`:

1. **Jooble was silently returning zero results.** Jooble runs a separate
   API domain per country (`ae.jooble.org` for the UAE, distinct from the
   default `jooble.org`), each with its own domain-locked key — confirmed
   directly against Jooble's own REST API docs. A key from any domain other
   than `ae.jooble.org` returns `HTTP 200` with an empty `jobs` array for
   UAE searches — not an error, just silently nothing. The script now calls
   `ae.jooble.org` — **but you need a new key registered at
   https://ae.jooble.org/api/about specifically.** Your existing key (if it
   came from `jooble.org`) will not start working just because the endpoint
   changed; update the `JOOBLE_API_KEY` GitHub secret with the new one.
2. **Jooble's free tier is a lifetime cap, not a daily one.** Also confirmed
   directly against their docs: *"a total lifetime limit of 500 requests per
   key — this is an absolute lifetime quota, not a monthly limit."* The
   original design (7 keywords × 2 locations = 14 calls/run) would have
   burned the entire quota in about 35 runs, i.e. roughly a month even at
   once/day. Fixed two ways: all 7 role keywords are now combined into a
   single comma-separated call per location (Jooble's own documented format
   supports this) — 2 calls/run instead of 14 — and the cron cadence in
   `discovery_sajna.yml` was changed from every 3 hours to **once daily**,
   giving ~250 days of runway on the free tier. See the comment at the top
   of `discovery_sajna.yml` for the exact math.
3. **Indeed was getting blocked outright.** Every search request came back
   `HTTP 403` — Indeed rejected the GitHub Actions runner's IP before even
   reaching a detail page. This is now **disabled** via an `ENABLE_INDEED =
   false` flag at the top of the script, rather than left running and
   quietly burning Action minutes on requests that can't succeed. See the
   comment above that flag, and §7, for what would be involved in revisiting
   this later.

**To apply the fix:** register a new key at **https://ae.jooble.org/api/about**
(not the default jooble.org page), update the `JOOBLE_API_KEY` secret in the
`career-discovery-sajna` repo with it, push the updated `discovery_sajna.mjs`
and `discovery_sajna.yml`, then trigger one manual run (Actions → Career
Discovery (Sajna) → Run workflow) to confirm — check the log's JSON summary,
`perSource.jooble.found` should be non-zero. **After that first confirmation
run, avoid extra manual triggers** — every run, manual or scheduled, spends
2 of the key's 500 lifetime requests.

### 0.1 If you're still getting a 403 after the domain fix

A second live run still returned `403`, but as a full styled HTML error page
(logo, apple-touch-icon, `robots noindex` meta tag) rather than the clean
JSON error Jooble's own docs describe (`{"error": "Invalid or missing API
key"}`-style). That mismatch matters — a styled HTML page is more typical of
an edge/WAF block on the request itself than the API layer rejecting a bad
key. Two possible causes, and this version fixes one of them:

1. **No `User-Agent` header.** Node's `fetch()` sends none by default, which
   some WAFs block outright regardless of the key. **Fixed** — `queryJooble()`
   now sends a browser-like `User-Agent` and `Accept: application/json`.
   Push this update and re-run before doing anything else.
2. **The key itself isn't active yet, or was mistyped.** Jooble's own docs
   say registration is reviewed manually and the key arrives by email — if
   you tried it immediately after submitting the form, it may not be live
   yet. Or the value in the `JOOBLE_API_KEY` secret has a typo, stray
   whitespace, or is missing.

**To isolate which one it is**, run this from your own machine (not GitHub
Actions) with your real key filled in — this bypasses the GitHub Actions IP
range entirely, so if it succeeds here but still fails in Actions, the
problem is IP-based, not the key:

```bash
curl -s -X POST "https://ae.jooble.org/api/YOUR_KEY_HERE" \
  -H "Content-Type: application/json" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" \
  -d '{"keywords":"quantity surveyor","location":"Dubai"}'
```

- **Returns real JSON with a `jobs` array** → the key is fine, and the
  User-Agent fix above should resolve it in Actions too. If Actions still
  403s after that fix, GitHub's IP range is being blocked the same way
  Indeed blocked it — a much harder problem, with no clean fix short of a
  paid residential proxy.
- **Still returns the same HTML 403 from your own machine** → the key
  itself isn't working. Double-check the secret value for typos/whitespace,
  confirm the approval email from Jooble actually arrived, and if it looks
  correct, contact Jooble support (support link on their help center) with
  this exact curl output — that's a Jooble-side account issue, not a bug in
  this script.

---

## 1. Architecture

```
GitHub Actions (career-discovery-sajna repo, cron every 3 hrs)
  discovery_sajna.mjs
    → queries Jooble (ae.jooble.org, UAE domain) —
      Dubai + Sharjah × 7 role keywords
      [Indeed scraper built but disabled — confirmed 403-blocked, see §0/§7]
    → dedupes against KV directly via Cloudflare REST API
    → resolves the real off-aggregator apply link (HTML-body extraction)
    → POSTs each surviving job to the analyzer worker
    → writes dedup keys directly to KV via Cloudflare REST API
        ↓
Cloudflare Worker: career-intelligence-api-sajna
    → scores the job against Sajna's profile (Gemini 3.1 Flash-Lite primary,
      Anthropic Haiku 4.5 fallback on 429/503)
    → auto-saves the full record to KV, including directApplyUrl
        ↓
KV namespace: career_jobs_sajna  (bound as JOBS_KV on both workers)
        ↓
Cloudflare Worker: career-dashboard-sajna
    → serves the dashboard UI + REST API (paginated reads, updates, delete, export)
        ↓
Dashboard: https://career-dashboard-sajna.niyasbinnazeer.workers.dev/?key=sajna-2026
```

**Source differences from your own stack, and why:**

- **Adzuna** has no UAE coverage at all (its country list is
  AU/AT/BE/BR/CA/FR/DE/IN/IT/MX/NL/NZ/PL/SG/ZA/ES/CH/GB/US — confirmed, not
  an oversight) — not queried.
- **Jobicy and Himalayas** are remote-only boards, wouldn't return on-site
  Dubai/Sharjah construction roles — not queried.
- **Jooble** — official free API, but requires a UAE-domain key from
  `ae.jooble.org/api/about` specifically (see §0 — this is what broke the
  first runs).
- **Indeed** — a DIY scraper was built (search-page → job-key harvest →
  JSON-LD detail parse) but is **currently disabled**: the first live run
  got HTTP 403 on every request, meaning Indeed blocked the GitHub Actions
  IP range outright. The code is still in the file behind an `ENABLE_INDEED`
  flag if you want to re-test later, but it's not running by default. This
  was always flagged as outside Indeed's terms of service and a real
  blocking risk — see §7.
- **NaukriGulf** — deliberately **not** included. It's a fully
  client-rendered app; a plain `fetch()` (all Node/GitHub Actions can do)
  returns zero job data, confirmed by direct fetch — the raw HTML is
  nothing but a "JavaScript is disabled" shell. Real coverage would need
  either a headless browser (Puppeteer/Playwright, a materially bigger
  build) or a paid scraping service (~$1/1,000 results on Apify). Revisit
  if/when that tradeoff is worth it.

If you find another job API with genuine UAE coverage later, it slots in as
its own `querySOURCE()` function in `discovery_sajna.mjs` alongside
`queryJooble()` and `harvestIndeedJobKeys()`/`fetchIndeedJobDetail()`.

---

## 2. Where each secret/credential lives

**GitHub repo secrets** (`career-discovery-sajna` → Settings → Secrets and
variables → Actions) — used only by `discovery_sajna.mjs`, which runs in
GitHub Actions:

| Secret | Purpose |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account ID (same account as your other stacks) |
| `CF_API_TOKEN` | Cloudflare token, Workers KV **Edit** permission |
| `CF_KV_NAMESPACE_ID` | ID of the `career_jobs_sajna` namespace |
| `CAREER_ANALYZER_URL` | `https://career-intelligence-api-sajna.niyasbinnazeer.workers.dev` |
| `JOOBLE_API_KEY` | **Must be registered at `ae.jooble.org/api/about` — the UAE domain, not the default `jooble.org`.** Jooble runs separate per-country domains, each with its own domain-locked key (this bit the first live run: a key from any other domain returns HTTP 200 with an empty `jobs` array for UAE locations, not an error). Bare key, no quotes. |

**Cloudflare Worker secrets** (`career-intelligence-api-sajna` → Settings → Variables):

| Secret | Purpose |
|---|---|
| `GEMINI_API_KEY` | **Must be a separate Google AI Studio project key from your own.** Your own discovery alone uses close to its 500/day free-tier pool — sharing would starve one stack or the other silently. |
| `ANTHROPIC_API_KEY` | Fallback model only, used when Gemini returns 429 (rate limited) or 503 (overloaded). Same key you already use elsewhere is fine — it's a low-volume fallback, not a primary load. |

**Nothing else needs any key.** `career-dashboard-sajna` only needs the
`JOBS_KV` binding — no secrets.

---

## 3. Current file inventory

| File | Deploys to |
|---|---|
| `career-intelligence-api-sajna.js` | Cloudflare Worker `career-intelligence-api-sajna` |
| `career-dashboard-sajna.js` | Cloudflare Worker `career-dashboard-sajna` |
| `discovery_sajna.mjs` | GitHub repo `career-discovery-sajna`, root |
| `discovery_sajna.yml` | GitHub repo, `.github/workflows/discovery_sajna.yml` |

All three JS/MJS files verified with `node --check` — syntactically valid.

---

## 4. Deploy steps, from scratch

### 4.1 Cloudflare KV

1. Cloudflare dashboard → **Storage & Databases** → **KV** → **Create instance**
2. Name it exactly `career_jobs_sajna` → Create
3. Open the namespace and copy its **Namespace ID** from the details panel —
   you'll need this for `CF_KV_NAMESPACE_ID` in step 4.3

### 4.2 Deploy career-intelligence-api-sajna

1. **Workers & Pages** → **Create** → **Create Worker**
2. Name it `career-intelligence-api-sajna` → Deploy the placeholder
3. **Edit code** → delete the placeholder → paste the entire contents of
   `career-intelligence-api-sajna.js` → **Deploy**
4. **Settings → Variables and Secrets** → **Add**:
   - Secret `GEMINI_API_KEY` — your **separate** Google AI Studio key for this stack
   - Secret `ANTHROPIC_API_KEY` — can reuse your existing key
5. **Settings → Bindings → Add binding → KV Namespace**:
   - Variable name: `JOBS_KV` (must match exactly — the code uses `env.JOBS_KV`)
   - Namespace: `career_jobs_sajna`
6. Redeploy if Cloudflare prompts you to after adding bindings

**Verify:** open `https://career-intelligence-api-sajna.niyasbinnazeer.workers.dev/debug`.
You should get `"ok": true` with a short `geminiSample` string. If it fails,
check the Gemini key first — that's the most common issue.

### 4.3 Deploy career-dashboard-sajna

1. **Workers & Pages** → **Create** → **Create Worker**
2. Name it `career-dashboard-sajna` → Deploy the placeholder
3. **Edit code** → paste `career-dashboard-sajna.js` → **Deploy**
4. **Settings → Bindings → Add binding → KV Namespace**:
   - Variable name: `JOBS_KV`
   - Namespace: `career_jobs_sajna` (same namespace as the API worker)

**Verify:** open `https://career-dashboard-sajna.niyasbinnazeer.workers.dev/?key=sajna-2026`.
You should see an empty dashboard ("Nothing here yet"), not a 401.

### 4.4 Cloudflare API token (for the discovery script)

The GitHub Actions script writes to KV directly via Cloudflare's REST API, so
it needs its own token — separate from anything used inside the Workers:

1. Cloudflare dashboard → profile icon → **My Profile** → **API Tokens** → **Create Token**
2. Use **Edit Cloudflare Workers** template, or a custom token scoped to
   **Account → Workers KV Storage → Edit**
3. Copy the token — you won't see it again — this becomes `CF_API_TOKEN`
4. Your **Account ID** is visible on the right sidebar of any domain/Workers
   overview page in the dashboard — this becomes `CF_ACCOUNT_ID`

### 4.5 Set up the GitHub repo

1. Create a new repo, e.g. `career-discovery-sajna`
2. Add `discovery_sajna.mjs` at the repo root
3. Create the folder `.github/workflows/` and add `discovery_sajna.yml` there
4. Repo → **Settings → Secrets and variables → Actions → New repository secret**,
   add all five secrets from the table in §2 (`CF_ACCOUNT_ID`, `CF_API_TOKEN`,
   `CF_KV_NAMESPACE_ID`, `CAREER_ANALYZER_URL`, `JOOBLE_API_KEY`)
5. Get a Jooble API key at **https://ae.jooble.org/api/about** — the UAE
   domain specifically, not the default jooble.org. This also keeps it
   separate from your own search's key/quota, same reasoning as the Gemini
   key separation above.

### 4.6 Trigger the first run

1. Repo → **Actions** tab → select **Career Discovery (Sajna)** in the left
   sidebar → **Run workflow** (manual trigger, top right)
2. Watch the run log — it prints a JSON summary at the end:
   `{ totalDiscovered, totalSkippedDuplicate, perSource: { jooble: {...} } }`
3. Open the dashboard (`?key=sajna-2026`) — jobs should start appearing
   within a minute or two of the run finishing

If `perSource.jooble.errors` is non-zero, check the log lines just above the
summary — they show the specific keyword/location combo and the Jooble error
message.

---

## 5. What's different from the Niyas stack, deliberately

- **Single discovery source (Jooble)**, not five — Adzuna has no UAE
  coverage, Jobicy/Himalayas are remote-only. See the architecture note in §1.
- **No Chrome extension** — this instance is fully automated, no manual
  "analyze this page" workflow.
- **Location adjustment logic**: Dubai/Sharjah = no penalty, rest of UAE =
  mild penalty + flagged, outside UAE = larger penalty + flagged (Niyas's
  stack instead uses `visaSponsorship` — not relevant here since Sajna is
  already UAE-resident).
- **Salary floor**: AED 4,000/month, both as a light pre-filter in discovery
  (skips postings that explicitly disclose less) and as a scoring adjustment
  in the analyzer (flags anything ambiguous or ~just~ below).
- **Company signal list** swapped to UAE contractors/developers (Arabtec,
  ALEC, Emaar, AECOM, Turner & Townsend, etc.) instead of L&D/pharma.
- **Resume version buckets**: Quantity Surveying / Project Coordination /
  General Admin.
- Everything else — Gemini-primary/Haiku-fallback scoring pattern, KV dedupe
  via direct Cloudflare REST API writes, paginated dashboard reads (900/page,
  cursor-based, stays under the 1,000-subrequest cap), client-side dedup
  button, dual apply buttons (stored posting URL + resolved direct-apply
  link), status pipeline, notes/checklist persistence — mirrors your stack
  exactly.

## 6. Known limitations to keep an eye on

- **Jooble's request limit is a lifetime total of 500, not a daily one** —
  confirmed directly against Jooble's own docs (this corrects what your own
  stack's handover assumed was an unclear daily/monthly cap). At 2 calls/run
  (combined keywords, one call per location) and the once-daily cron this
  version ships with, that's ~250 days of runway. If you ever increase the
  cron frequency or split keywords back into separate calls, redo this math
  first — it's easy to burn through 500 lifetime requests much faster than
  it sounds.
- **Direct-apply-link resolution can be blocked** by Jooble's, Indeed's, or
  the underlying source's bot protection. When that happens, no link is
  extracted and the dashboard simply doesn't show the second "Direct apply
  link" button for that job — it never shows a wrong link.
- **Indeed scraping is fragile by nature — see §7 below**, it's the part of
  this stack most likely to need attention over time.
- **NaukriGulf and Bayt/GulfTalent are real coverage gaps.** None expose a
  free public search API — worth checking again periodically, or manually
  browsing those sites occasionally to supplement what Jooble and Indeed
  surface.

## 7. Indeed scraper — what to watch for and how to know it's failing

This is the one part of the stack that isn't a sanctioned integration, so it
deserves specific attention:

- **It's outside Indeed's terms of service.** This is a personal job-search
  tool at low volume (capped at 8 job-detail fetches per keyword/location
  combo, with 400ms+ delays between requests), not a commercial scraping
  operation, but it's still automated access Indeed's ToS doesn't permit.
  That's a real, ongoing tradeoff you're accepting, not a technicality.
- **How it can fail silently:** if Indeed changes their JSON-LD structure or
  starts serving a block/CAPTCHA page to the GitHub Actions runner's IP
  range, `fetchIndeedJobDetail()` will return `null` for every job — no
  crash, just zero Indeed jobs making it through, run after run.
- **What to check:** the run log's JSON summary at the end —
  `perSource.indeed.found` (jobs discovered on search pages) vs
  `perSource.indeed.errors` (detail fetches that came back with no parseable
  `JobPosting` block). If `found` is healthy but `errors` is consistently
  close to it, Indeed is very likely blocking the runner or serving a page
  the parser doesn't recognize anymore.
- **If it does get blocked:** there's no real workaround short of proxying
  through a residential IP (adds cost and complexity disproportionate to
  what this is worth for a personal tool) or dropping Indeed back to Jooble's
  indirect coverage. Given the ToS considerations already in play, that's
  a reasonable point to just let it go rather than escalate further.
- **The search-page harvest step is separate from the detail-page fetch**,
  so if only detail fetches start failing, `harvestIndeedJobKeys()` is still
  confirming Indeed's search results remain reachable — useful for telling
  "they blocked detail pages specifically" apart from "they blocked us
  entirely."
