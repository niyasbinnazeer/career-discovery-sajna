// discovery_sajna.mjs
// Runs in GitHub Actions on a cron. Queries Jooble for Sajna's target roles
// in Dubai/Sharjah, dedupes against KV (via the Cloudflare REST API — this
// script never touches the Workers runtime), resolves each job's real
// off-aggregator apply link, and POSTs surviving jobs to the analyzer worker
// (career-intelligence-api-sajna), which scores them and auto-saves to KV.
//
// NOTE ON SOURCES: unlike the Niyas stack, this script does NOT query Adzuna
// — Adzuna has no UAE coverage (its country list is AU/AT/BE/BR/CA/FR/DE/IN/
// IT/MX/NL/NZ/PL/SG/ZA/ES/CH/GB/US). It also skips Jobicy and Himalayas,
// which are remote-only boards and won't surface on-site Dubai/Sharjah
// construction/coordination roles.
//
// Two sources are wired in: Jooble (official free API) and Indeed
// (DIY scraper — ae.indeed.com's search results are server-rendered HTML,
// confirmed by direct fetch; each job page also carries a JSON-LD
// `JobPosting` block, which is what's actually parsed, since it's far more
// stable than presentation markup). Indeed scraping is NOT an official,
// sanctioned integration — it's outside Indeed's terms of service, it will
// break if Indeed changes their markup/JSON-LD, and GitHub Actions' shared
// datacenter IPs may get rate-limited or blocked over time. Watch
// `perSource.indeed.errors` in the run log; if it climbs, Indeed has likely
// started blocking the runner's IP range.
//
// NaukriGulf is deliberately NOT included. It's a fully client-rendered app
// — a plain fetch() returns zero job data, confirmed by direct fetch (the
// raw HTML is just a "JavaScript is disabled" shell). Getting real coverage
// there requires either a headless browser (Puppeteer/Playwright) or a paid
// scraping service — both bigger asks than what's built here. Revisit if
// that tradeoff becomes worth it later.
//
// If you find another job API with genuine UAE coverage, add it as its own
// querySOURCE() function following the same pattern as queryJooble().

import crypto from "crypto";

const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_KV_NAMESPACE_ID = process.env.CF_KV_NAMESPACE_ID;
const CAREER_ANALYZER_URL = process.env.CAREER_ANALYZER_URL;
const JOOBLE_API_KEY = process.env.JOOBLE_API_KEY;

for (const [name, val] of Object.entries({
  CF_ACCOUNT_ID, CF_API_TOKEN, CF_KV_NAMESPACE_ID, CAREER_ANALYZER_URL, JOOBLE_API_KEY
})) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const LOCATIONS = ["Dubai", "Sharjah"];

const ROLE_KEYWORDS = [
  "document controller",
  "project coordinator",
  "client coordinator",
  "quantity surveyor",
  "junior quantity surveyor",
  "geotechnical engineer",
  "admin assistant"
];

const MIN_SALARY_AED = 4000;

// Caps how many Indeed job-detail pages get fetched per keyword/location
// combo. Indeed scraping is already a ToS/blocking risk; this keeps request
// volume bounded rather than fetching every result on page one.
const MAX_INDEED_RESULTS_PER_QUERY = 8;

// A default Node fetch() sends no User-Agent at all, which is an instant,
// trivial bot signal. This doesn't defeat real bot detection (nothing here
// tries to), it just avoids being blocked by the laziest possible check.
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const KV_REST_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/storage/kv/namespaces/${CF_KV_NAMESPACE_ID}`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------- KV dedupe helpers (Cloudflare REST API — no Workers runtime involved) ----------

async function kvKeyExists(key) {
  const res = await fetch(`${KV_REST_BASE}/values/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${CF_API_TOKEN}` }
  });
  if (res.status === 404) return false;
  if (!res.ok) {
    console.log(`KV read warning for ${key}: ${res.status}`);
    return false; // fail open — treat as "not seen" rather than silently skipping a real job
  }
  return true;
}

async function kvPutDedupeKey(key) {
  const res = await fetch(`${KV_REST_BASE}/values/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${CF_API_TOKEN}`,
      "Content-Type": "text/plain"
    },
    body: "1"
  });
  if (!res.ok) {
    console.log(`KV write failed for ${key}: ${res.status} ${await res.text()}`);
  }
}

function dedupeKeyFor(job) {
  const raw = job.link || `${job.title}|${job.company}|${job.location}`;
  const hash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 40);
  return `dedupe:${hash}`;
}

// ---------- Jooble ----------

async function queryJooble(keyword, location) {
  const res = await fetch(`https://jooble.org/api/${JOOBLE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keywords: keyword, location })
  });
  if (!res.ok) {
    throw new Error(`Jooble ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.jobs || [];
}

// ---------- Indeed (DIY scraper — see header note on ToS/reliability caveats) ----------

// Harvests job keys (Indeed's stable per-job identifier, `jk=`) from a
// search-results page. Deliberately doesn't try to parse titles/companies
// off this page — presentation HTML is exactly the kind of thing that
// breaks silently when a site redesigns. The job key is enough to build a
// canonical detail-page URL and a dedupe check before spending a second
// request on anything already seen.
async function harvestIndeedJobKeys(keyword, location) {
  const searchUrl = `https://ae.indeed.com/jobs?q=${encodeURIComponent(keyword)}&l=${encodeURIComponent(location)}`;
  const res = await fetch(searchUrl, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }
  });
  if (!res.ok) {
    throw new Error(`Indeed search ${res.status}`);
  }
  const html = await res.text();
  const keys = new Set();
  for (const m of html.matchAll(/[?&]jk=([a-f0-9]{16,20})/gi)) {
    keys.add(m[1]);
  }
  return [...keys];
}

function stripHtml(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Fetches one job's canonical page and pulls its JSON-LD JobPosting block.
// This is parsed instead of the visible page content because JSON-LD is
// structured data Indeed publishes for Google Jobs indexing — it's a much
// more stable target than scraping rendered HTML, and Indeed has a direct
// incentive not to break it (doing so would hurt their own SEO).
async function fetchIndeedJobDetail(jobKey) {
  const url = `https://ae.indeed.com/viewjob?jk=${jobKey}`;
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" }
  });
  if (!res.ok) {
    throw new Error(`Indeed job page ${res.status}`);
  }
  const html = await res.text();

  const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const [, json] of ldMatches) {
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const c of candidates) {
      if (!c || c["@type"] !== "JobPosting") continue;

      let salary = "";
      const bs = c.baseSalary?.value;
      if (bs) {
        const currency = c.baseSalary.currency || "";
        const unit = bs.unitText ? `/${bs.unitText.toLowerCase()}` : "";
        if (bs.minValue && bs.maxValue) {
          salary = `${currency} ${bs.minValue} - ${bs.maxValue}${unit}`;
        } else if (bs.value) {
          salary = `${currency} ${bs.value}${unit}`;
        }
      }

      const location = c.jobLocation?.address?.addressLocality
        || c.jobLocation?.address?.addressRegion
        || "";

      return {
        title: c.title || "",
        company: c.hiringOrganization?.name || "",
        location,
        link: url,
        salary,
        type: Array.isArray(c.employmentType) ? c.employmentType.join(", ") : (c.employmentType || ""),
        updated: c.datePosted || "",
        snippet: stripHtml(c.description || "").slice(0, 4000),
        _jobKey: jobKey
      };
    }
  }
  return null; // no JobPosting JSON-LD found — page structure changed, or a block/CAPTCHA page
}

function buildContentBlob(job) {
  const parts = [
    `Title: ${job.title || ""}`,
    `Company: ${job.company || ""}`,
    `Location: ${job.location || ""}`,
    job.salary ? `Salary: ${job.salary}` : "",
    job.type ? `Type: ${job.type}` : "",
    job.updated ? `Posted: ${job.updated}` : "",
    "",
    job.snippet || ""
  ];
  return parts.filter(Boolean).join("\n");
}

// Light pre-filter to save Gemini/Haiku calls on postings that already
// explicitly disclose pay below the AED 4,000 floor. Deliberately narrow —
// only fires on an unambiguous "AED <number>" pattern below the floor, since
// Jooble's salary field is free text and inconsistent across currencies.
// Anything ambiguous is left for the analyzer's own salary-floor scoring step.
function obviouslyBelowFloor(job) {
  if (!job.salary) return false;
  const match = job.salary.match(/AED\s*([\d,]+)/i);
  if (!match) return false;
  const amount = parseInt(match[1].replace(/,/g, ""), 10);
  return Number.isFinite(amount) && amount > 0 && amount < MIN_SALARY_AED;
}

// ---------- Direct apply link resolution ----------
// Aggregator "apply" links are frequently normal HTML pages, not HTTP
// redirects. Resolve in order: HTTP redirect -> meta-refresh -> JS redirect
// -> the page's own tracking/land link (followed one more hop) -> JSON-LD
// JobPosting.url. Only kept if it genuinely leaves the aggregator's domain.

function sameDomain(a, b) {
  try {
    return new URL(a).hostname === new URL(b).hostname;
  } catch {
    return true; // if unparseable, don't claim it's a different domain
  }
}

function resolveRelative(maybeRelative, base) {
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return null;
  }
}

async function resolveDirectApplyUrl(pageUrl) {
  if (!pageUrl) return null;
  try {
    const res = await fetch(pageUrl, { redirect: "follow" });
    const finalUrl = res.url || pageUrl;

    if (finalUrl !== pageUrl && !sameDomain(finalUrl, pageUrl)) {
      return finalUrl;
    }

    const html = await res.text();

    // meta-refresh
    let m = html.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]+;\s*url=([^"'>]+)["']/i);
    if (m) {
      const resolved = resolveRelative(m[1], pageUrl);
      if (resolved && !sameDomain(resolved, pageUrl)) return resolved;
    }

    // JS redirect
    m = html.match(/location\.(?:href|replace)\s*=\s*["']([^"']+)["']/i);
    if (m) {
      const resolved = resolveRelative(m[1], pageUrl);
      if (resolved && !sameDomain(resolved, pageUrl)) return resolved;
    }

    // aggregator's own tracking / "land/ad" link, followed one more hop
    m = html.match(/href=["']([^"']*(?:land\/ad|redirect|track)[^"']*)["']/i);
    if (m) {
      const landUrl = resolveRelative(m[1], pageUrl);
      if (landUrl) {
        try {
          const landRes = await fetch(landUrl, { redirect: "follow" });
          if (landRes.url && !sameDomain(landRes.url, pageUrl)) return landRes.url;
        } catch { /* ignore, fall through */ }
      }
    }

    // JSON-LD JobPosting.url
    const ldMatches = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const [, json] of ldMatches) {
      try {
        const parsed = JSON.parse(json);
        const candidates = Array.isArray(parsed) ? parsed : [parsed];
        for (const c of candidates) {
          if (c && c["@type"] === "JobPosting" && c.url && !sameDomain(c.url, pageUrl)) {
            return c.url;
          }
        }
      } catch { /* not valid JSON-LD, skip */ }
    }
  } catch (e) {
    console.log(`Resolve failed for ${pageUrl}: ${e.message}`);
  }
  return null; // bot-blocked or genuinely no off-aggregator link — never guess
}

// ---------- Main ----------

// Shared per-job pipeline: dedupe check -> salary pre-filter -> content
// length check -> direct-apply resolution -> POST to analyzer -> mark seen.
// Used by both sources so Jooble and Indeed jobs are handled identically
// once you have a job object in the common shape.
async function processJob(job, sourceName, perSource, counters) {
  const dedupeKey = dedupeKeyFor(job);

  let alreadySeen;
  try {
    alreadySeen = await kvKeyExists(dedupeKey);
  } catch (e) {
    console.log(`Dedup check failed, skipping job to be safe: ${e.message}`);
    return;
  }
  if (alreadySeen) {
    counters.totalSkippedDuplicate++;
    return;
  }

  if (obviouslyBelowFloor(job)) {
    perSource[sourceName].belowFloor++;
    await kvPutDedupeKey(dedupeKey); // don't re-check this one every run
    return;
  }

  perSource[sourceName].new++;

  const content = buildContentBlob(job);
  if (content.trim().length < 100) {
    return; // too sparse to score meaningfully; don't mark as seen — may fill in later
  }

  const directApplyUrl = await resolveDirectApplyUrl(job.directApplyCandidate || job.link);

  try {
    const res = await fetch(CAREER_ANALYZER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content,
        url: job.link || "",
        title: job.title || "",
        directApplyUrl
      })
    });
    if (!res.ok) {
      throw new Error(`Analyzer returned ${res.status}: ${await res.text()}`);
    }
    perSource[sourceName].analyzed++;
    counters.totalDiscovered++;
  } catch (e) {
    console.log(`Analyzer call failed for ${job.link}: ${e.message}`);
    perSource[sourceName].errors++;
    return; // don't mark as seen on failure — retry next run
  }

  await kvPutDedupeKey(dedupeKey);
}

async function main() {
  const perSource = {
    jooble: { found: 0, new: 0, belowFloor: 0, analyzed: 0, errors: 0 },
    indeed: { found: 0, new: 0, belowFloor: 0, analyzed: 0, errors: 0, skippedAlreadySeenBeforeFetch: 0 }
  };
  const counters = { totalDiscovered: 0, totalSkippedDuplicate: 0 };

  for (const location of LOCATIONS) {
    for (const keyword of ROLE_KEYWORDS) {

      // ---- Jooble ----
      let joobleJobs;
      try {
        joobleJobs = await queryJooble(keyword, location);
      } catch (e) {
        console.log(`Jooble query failed ("${keyword}" in ${location}): ${e.message}`);
        perSource.jooble.errors++;
        joobleJobs = [];
      }
      perSource.jooble.found += joobleJobs.length;

      for (const job of joobleJobs) {
        await processJob(job, "jooble", perSource, counters);
        await sleep(150); // be polite to the analyzer worker and Gemini/Anthropic rate limits
      }

      await sleep(300); // be polite to Jooble between keyword/location combos

      // ---- Indeed ----
      let jobKeys;
      try {
        jobKeys = await harvestIndeedJobKeys(keyword, location);
      } catch (e) {
        console.log(`Indeed search failed ("${keyword}" in ${location}): ${e.message}`);
        perSource.indeed.errors++;
        jobKeys = [];
      }
      perSource.indeed.found += jobKeys.length;

      for (const jobKey of jobKeys.slice(0, MAX_INDEED_RESULTS_PER_QUERY)) {
        // Cheap dedupe check on the canonical URL BEFORE spending a second
        // request on the detail page — this is what keeps re-runs cheap,
        // since most jobs on a re-run were already seen last time.
        const candidateUrl = `https://ae.indeed.com/viewjob?jk=${jobKey}`;
        const dedupeKey = dedupeKeyFor({ link: candidateUrl });
        let alreadySeen;
        try {
          alreadySeen = await kvKeyExists(dedupeKey);
        } catch (e) {
          console.log(`Dedup pre-check failed for ${candidateUrl}, skipping to be safe: ${e.message}`);
          continue;
        }
        if (alreadySeen) {
          perSource.indeed.skippedAlreadySeenBeforeFetch++;
          counters.totalSkippedDuplicate++;
          continue;
        }

        let job;
        try {
          job = await fetchIndeedJobDetail(jobKey);
        } catch (e) {
          console.log(`Indeed job detail fetch failed for ${jobKey}: ${e.message}`);
          perSource.indeed.errors++;
          await sleep(400);
          continue;
        }
        if (!job) {
          // No JSON-LD found — likely a block/CAPTCHA page or a structure
          // change. Don't mark as seen, but don't hammer it either.
          perSource.indeed.errors++;
          await sleep(400);
          continue;
        }

        // Indeed's own tracking/redirect link, worth trying to resolve to
        // an off-platform apply destination the same way Jooble links are.
        job.directApplyCandidate = `https://ae.indeed.com/rc/clk?jk=${jobKey}`;

        await processJob(job, "indeed", perSource, counters);
        await sleep(400); // more conservative than Jooble — two requests per job already
      }

      await sleep(500); // be more conservative with Indeed between keyword/location combos
    }
  }

  console.log(JSON.stringify({
    totalDiscovered: counters.totalDiscovered,
    totalSkippedDuplicate: counters.totalSkippedDuplicate,
    perSource
  }, null, 2));
}

main().catch(e => {
  console.error("Discovery run failed:", e);
  process.exit(1);
});
