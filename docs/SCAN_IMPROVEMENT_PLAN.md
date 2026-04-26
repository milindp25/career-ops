# Scan Improvement Plan — Context-Efficient Career Page Scanning

## Status: Pending implementation
## Created: 2026-04-15

---

## The Problem

Running `/career-ops scan` in Claude hits the 1M context limit because:
- `portals.yml` = 66KB (~16,900 tokens) loaded upfront
- Each Playwright career page snapshot = ~10-30K tokens
- 208 companies × ~15K avg = way over standard 200K context window

## What We've Done So Far

- Added `--batch` and `--offset` flags to `scan.mjs`
- Added npm scripts: `scan:1`, `scan:2`, `scan:3`, `scan:all` (75 companies each)
- Discovered and wired 22 companies with Greenhouse/Lever APIs:
  - **Greenhouse (19):** Stripe, Airbnb, Lyft, Reddit, HubSpot, Postman, Discord,
    Figma, Pinterest, Chime, Mercury, GitLab, PagerDuty, Elastic, Cloudflare,
    Databricks, MongoDB, Twilio, Vercel
  - **Lever (3):** Atlassian, Plaid, Palantir
  - **Greenhouse (existing 6):** Robinhood, Datadog, Confluent, Brex, Affirm, Toast

## The Plan

### Priority Order (user-defined — IMPORTANT)
1. **Career page first** (`careers_url`) — always try this, it's the source of truth
2. **API fallback** — only if career page is down/unreachable/404

Reason: career pages show ALL roles including those posted outside the ATS.
APIs only show what's in that specific ATS feed.

---

### Step 1 — `discover-ats.mjs` (one-time discovery script)

Visit all 208 career pages with Playwright. For each page detect and store:
- `ats_type`: greenhouse / lever / ashby / workday / smartrecruiters / icims / custom
- `api_endpoint`: constructed API URL if ATS is detectable
- `job_selector`: CSS selector that targets job listing items on the page
- `pagination_type`: none / infinite-scroll / pages
- `last_verified`: date of last successful check

Output: `data/page-profiles.json`

Run in batches of ~10 companies (fits in standard 200K context):
```bash
# 208 companies / ~11 per batch = ~19 batches total
node discover-ats.mjs --batch 11 --offset 0
node discover-ats.mjs --batch 11 --offset 11
# ... etc
```

**This is a one-time cost.** Never needs to repeat unless a company changes their ATS.

---

### Step 2 — Extend `scan.mjs` to use `page-profiles.json`

Logic per company:
```
1. Load page-profiles.json
2. For each company:
   a. Check if profile exists
      - YES + has job_selector → Playwright targeted query (cheap, ~2K tokens)
      - YES + has api_endpoint → use API (zero tokens)
      - NO profile → full Playwright snapshot, save result to profile
   b. If career page fails (404/timeout):
      - Fall back to api_endpoint if available
      - Log as unreachable if no fallback
```

Expected context savings after discovery:
- **Before:** ~17 Claude batches per scan (full snapshots)
- **After:** ~2-3 Claude batches for un-profiled/custom pages only
- **Zero-token:** all ATS-detected companies via scan.mjs directly

---

### Step 3 — `/career-ops scan` in Claude becomes lightweight

After page-profiles.json is populated, Claude's scan only needs to handle:
- New companies added to portals.yml (no profile yet)
- Companies where selector stopped working (needs re-discovery)
- Fully custom pages with no ATS pattern

---

## Context Budget (per batch)

| Item | Tokens |
|------|--------|
| portals.yml | ~16,900 |
| scan.md + _shared.md + _profile.md + cv.md | ~8,961 |
| **Fixed overhead** | **~25,855** |
| Available for Playwright (200K window) | ~174,145 |
| Avg career page snapshot | ~15,000 |
| **Companies per batch** | **~11** |
| **Batches for 180 custom pages** | **~17** |

---

## Files to Create

| File | Purpose |
|------|---------|
| `discover-ats.mjs` | One-time discovery script — visits career pages, detects ATS, saves selectors |
| `data/page-profiles.json` | Stored page structure knowledge per company |

## Files to Modify

| File | Change |
|------|--------|
| `scan.mjs` | Read page-profiles.json, use stored selector/API, fall back correctly |

---

## Notes
- `portals.yml` is gitignored (user data layer) — page-profiles.json should be too
- Re-run `discover-ats.mjs --company "X"` when a company changes their ATS
- Workday companies (Capital One, JPMorgan, Goldman etc.) likely detectable via
  network inspection — their API pattern is `{tenant}.wd5.myworkdayjobs.com/wday/cxs/...`
