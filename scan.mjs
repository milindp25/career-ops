#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner
 *
 * Fetches Greenhouse, Ashby, and Lever APIs directly, applies title
 * filters from portals.yml, deduplicates against existing history,
 * and appends new offers to pipeline.md + scan-history.tsv.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import yaml from 'js-yaml';
import { chromium } from 'playwright';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH    = 'portals.yml';
const PROFILES_PATH   = 'data/page-profiles.json';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const PIPELINE_PATH   = 'data/pipeline.md';
const APPLICATIONS_PATH = 'data/applications.md';
const PAGE_TIMEOUT_MS = 20_000;
const WAIT_FOR_JS_MS  = 2_500;
const PLAYWRIGHT_CONCURRENCY = 3; // browsers open at once

// Ensure required directories exist (fresh setup)
mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  // Explicit api: field in portals.yml — detect type from URL
  if (company.api) {
    if (company.api.includes('greenhouse'))      return { type: 'greenhouse',      url: company.api };
    if (company.api.includes('lever'))           return { type: 'lever',           url: company.api };
    if (company.api.includes('ashbyhq'))         return { type: 'ashby',           url: company.api };
    if (company.api.includes('smartrecruiters')) return { type: 'smartrecruiters', url: company.api };
    if (company.api.includes('myworkdayjobs'))   return { type: 'workday',           url: company.api };
  }

  const url = company.careers_url || '';

  // Ashby
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  // Lever
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  // Greenhouse EU boards
  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
  }));
}

function parseWorkday(json, companyName, apiUrl) {
  const origin = new URL(apiUrl).origin; // https://{tenant}.wd5.myworkdayjobs.com
  const jobs = json.jobPostings || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.externalPath ? `${origin}${j.externalPath}` : '',
    company: companyName,
    location: j.locationsText || '',
  })).filter(j => j.url);
}

function parseSmartRecruiters(json, companyName) {
  const jobs = json.content || [];
  return jobs.map(j => ({
    title: j.name || '',
    url: j.ref || '',
    company: companyName,
    location: [j.location?.city, j.location?.country].filter(Boolean).join(', '),
  }));
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever, smartrecruiters: parseSmartRecruiters, workday: parseWorkday };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Workday uses POST with pagination body (unlike every other ATS which is GET)
async function fetchWorkday(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 100, offset: 0, searchText: '' }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Title filter ────────────────────────────────────────────────────

function buildTitleFilter(titleFilter) {
  const positive = (titleFilter?.positive || []).map(k => k.toLowerCase());
  const negative = (titleFilter?.negative || []).map(k => k.toLowerCase());

  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Location filter ──────────────────────────────────────────────────

function buildLocationFilter(locationFilter) {
  if (!locationFilter) return () => true;

  // Word-boundary regex instead of substring match: "US" must not match
  // "Austria", "Russia", "Brussels", etc. Slashes, commas, hyphens, and
  // spaces all act as boundaries, so "Remote, US" and "/us/en/job/" still match.
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const toRegex  = k => new RegExp(`\\b${escapeRe(k.trim())}\\b`, 'i');

  const required = (locationFilter.require_any || []).map(toRegex);
  const excluded = (locationFilter.exclude_any || []).map(toRegex);

  return (location, fallback = '') => {
    // Career-page scraper can't extract location — fall back to title+url,
    // which usually contains the city (e.g. /job/london/ or "...Budapest, Hungary").
    const text = (location && location.trim()) ? location : fallback;
    if (!text || !text.trim()) return true; // nothing to go on — allow (API jobs with blank location)

    if (excluded.some(re => re.test(text))) return false;
    return required.length === 0 || required.some(re => re.test(text));
  };
}

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();

  // scan-history.tsv
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) { // skip header
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }

  // pipeline.md — extract URLs from checkbox lines
  if (existsSync(PIPELINE_PATH)) {
    const text = readFileSync(PIPELINE_PATH, 'utf-8');
    for (const match of text.matchAll(/- \[[ x]\] (https?:\/\/\S+)/g)) {
      seen.add(match[1]);
    }
  }

  // applications.md — extract URLs from report links and any inline URLs
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(match[0]);
    }
  }

  return seen;
}

function loadSeenCompanyRoles() {
  const seen = new Set();
  if (existsSync(APPLICATIONS_PATH)) {
    const text = readFileSync(APPLICATIONS_PATH, 'utf-8');
    // Parse markdown table rows: | # | Date | Company | Role | ...
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = match[1].trim().toLowerCase();
      const role = match[2].trim().toLowerCase();
      if (company && role && company !== 'company') {
        seen.add(`${company}::${role}`);
      }
    }
  }
  return seen;
}

// ── Pipeline writer ─────────────────────────────────────────────────

function appendToPipeline(offers) {
  if (offers.length === 0) return;

  let text = readFileSync(PIPELINE_PATH, 'utf-8');

  // Find "## Pendientes" section and append after it
  const marker = '## Pendientes';
  const idx = text.indexOf(marker);
  if (idx === -1) {
    // No Pendientes section — append at end before Procesadas
    const procIdx = text.indexOf('## Procesadas');
    const insertAt = procIdx === -1 ? text.length : procIdx;
    const block = `\n${marker}\n\n` + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  } else {
    // Find the end of existing Pendientes content (next ## or end)
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt = nextSection === -1 ? text.length : nextSection;

    const block = '\n' + offers.map(o =>
      `- [ ] ${o.url} | ${o.company} | ${o.title}`
    ).join('\n') + '\n';
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }

  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  // Ensure file + header exist
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\n', 'utf-8');
  }

  const lines = offers.map(o =>
    `${o.url}\t${date}\t${o.source}\t${o.title}\t${o.company}\tadded`
  ).join('\n') + '\n';

  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Career page scraper (Playwright) ───────────────────────────────
// Uses stored selector from page-profiles.json — much cheaper than full snapshot.

async function scrapeCareerPage(browser, profile, companyName) {
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (compatible; career-ops-scanner/1.0)',
  });
  const page = await context.newPage();

  try {
    await page.goto(profile.careers_url, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });
    await page.waitForTimeout(WAIT_FOR_JS_MS);

    const selector = profile.job_selector;
    if (!selector) throw new Error('no selector in profile');

    // Extract (title, href) pairs from matching elements
    const rawJobs = await page.evaluate((sel) => {
      const elements = Array.from(document.querySelectorAll(sel));
      return elements.map(el => {
        // Walk up to find closest anchor if el isn't one
        const anchor = el.tagName === 'A' ? el : el.closest('a') || el.querySelector('a');
        const title  = (el.textContent || '').trim().replace(/\s+/g, ' ');
        const href   = anchor?.href || '';
        return { title, url: href };
      }).filter(j => j.title && j.url && j.url.startsWith('http'));
    }, selector);

    // Attach company name and filter out nav/footer links (must look like a job URL)
    const JOB_URL_RE = /\/(job|jobs|careers?|opening|position|posting|apply|requisition)s?[/-]/i;
    const jobs = rawJobs
      .map(j => ({ ...j, company: companyName }))
      .filter(j => JOB_URL_RE.test(j.url) || j.url.includes('greenhouse.io') || j.url.includes('lever.co') || j.url.includes('ashbyhq.com'));

    return { jobs, source: `career-page:${profile.ats || 'custom'}` };

  } catch (err) {
    return { jobs: null, error: err.message.slice(0, 100) };
  } finally {
    await context.close();
  }
}

// ── Parallel fetch with concurrency limit ───────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;

  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const batchFlag = args.indexOf('--batch');
  const batchSize = batchFlag !== -1 ? parseInt(args[batchFlag + 1], 10) : null;
  const offsetFlag = args.indexOf('--offset');
  const batchOffset = offsetFlag !== -1 ? parseInt(args[offsetFlag + 1], 10) : 0;

  // 1. Read portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Run onboarding first.');
    process.exit(1);
  }

  const config          = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies       = config.tracked_companies || [];
  const titleFilter     = buildTitleFilter(config.title_filter);
  const locationFilter  = buildLocationFilter(config.location_filter);

  // 2. Load page profiles (from discover-ats.mjs)
  const profiles = existsSync(PROFILES_PATH)
    ? JSON.parse(readFileSync(PROFILES_PATH, 'utf-8'))
    : {};

  // 3. Bucket companies into: career-page (profiled), api-only, skipped
  const enabled = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany));

  // Career page path: has a profile with a working selector
  const careerPageTargets = enabled
    .filter(c => profiles[c.name]?.job_selector && profiles[c.name]?.status === 'ok');

  // API-only path: no usable selector — use portals.yml api: field, auto-detected URL pattern,
  // or api_endpoint stored in page-profiles.json (whichever is available first)
  const apiOnlyTargets = enabled
    .filter(c => !profiles[c.name]?.job_selector)
    .map(c => {
      const profileApi = profiles[c.name]?.api_endpoint
        ? { type: profiles[c.name].ats || 'greenhouse', url: profiles[c.name].api_endpoint }
        : null;
      return { ...c, _api: detectApi(c) || profileApi };
    })
    .filter(c => c._api !== null);

  const skippedCount = enabled.length - careerPageTargets.length - apiOnlyTargets.length;

  // Apply batch slicing (applies to the combined total)
  const allTargets   = [...careerPageTargets.map(c => ({ ...c, _mode: 'career' })),
                        ...apiOnlyTargets.map(c => ({ ...c, _mode: 'api' }))];
  const totalTargets = allTargets.length;
  const sliced       = batchSize ? allTargets.slice(batchOffset, batchOffset + batchSize) : allTargets;
  const batchLabel   = batchSize
    ? ` [batch ${batchOffset + 1}–${Math.min(batchOffset + batchSize, totalTargets)} of ${totalTargets}]`
    : '';

  const slicedCareer = sliced.filter(c => c._mode === 'career');
  const slicedApi    = sliced.filter(c => c._mode === 'api');

  console.log(`Scanning ${sliced.length} companies${batchLabel}`);
  console.log(`  Career pages (Playwright): ${slicedCareer.length}`);
  console.log(`  API-only (zero-token):     ${slicedApi.length}`);
  console.log(`  Skipped (no profile/API):  ${skippedCount}`);
  if (skippedCount > 0) {
    const label = Object.keys(profiles).length === 0
      ? '\n  Tip: run `node discover-ats.mjs` to profile all career pages'
      : `\n  Tip: ${skippedCount} company/ies have no profile yet — run \`node discover-ats.mjs\` to pick them up`;
    console.log(label);
    console.log('  (new companies are auto-detected; existing profiles are untouched)\n');
  }
  if (dryRun) console.log('(dry run — no files will be written)\n');

  // 3. Load dedup sets
  const seenUrls = loadSeenUrls();
  const seenCompanyRoles = loadSeenCompanyRoles();

  // 4. Fetch all APIs
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFiltered = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  // ── Job processor (shared by career-page and API paths) ─────────────
  // Increments counters, deduplicates, and pushes passing jobs to newOffers.
  const processJobs = (jobs, source) => {
    totalFound += jobs.length;
    for (const job of jobs) {
      if (!job.url) continue;
      if (!titleFilter(job.title)) { totalFiltered++; continue; }
      if (!locationFilter(job.location, `${job.title} ${job.url}`)) { totalFiltered++; continue; }
      const companyRoleKey = `${(job.company || '').toLowerCase()}::${job.title.toLowerCase()}`;
      if (seenUrls.has(job.url) || seenCompanyRoles.has(companyRoleKey)) { totalDupes++; continue; }
      seenUrls.add(job.url);
      seenCompanyRoles.add(companyRoleKey);
      newOffers.push({ ...job, source });
    }
  };

  // ── Run career page tasks (Playwright, career page first) ──────────
  let browser = null;
  if (slicedCareer.length > 0) {
    browser = await chromium.launch({ headless: true });

    const careerTasks = slicedCareer.map(company => async () => {
      const profile = profiles[company.name];
      const { jobs, source, error } = await scrapeCareerPage(browser, profile, company.name);

      // If career page failed, fall back to API
      if (!jobs) {
        const fallbackApi = detectApi(company) ||
          (profile.api_endpoint ? { type: profile.ats || 'api', url: profile.api_endpoint } : null);

        if (fallbackApi) {
          try {
            const json = await fetchJson(fallbackApi.url);
            const parsed = PARSERS[fallbackApi.type]
              ? PARSERS[fallbackApi.type](json, company.name, fallbackApi.url)
              : [];
            processJobs(parsed, `${fallbackApi.type}-api (fallback)`);
          } catch (err) {
            errors.push({ company: company.name, error: `career page: ${error} | api fallback: ${err.message}` });
          }
        } else {
          errors.push({ company: company.name, error });
        }
        return;
      }

      processJobs(jobs, source);
    });

    await parallelFetch(careerTasks, PLAYWRIGHT_CONCURRENCY);
    await browser.close();
    browser = null;
  }

  // ── Run API-only tasks ───────────────────────────────────────────────
  const apiTasks = slicedApi.map(company => async () => {
    const { type, url } = company._api;
    try {
      const json = type === 'workday' ? await fetchWorkday(url) : await fetchJson(url);
      const parser = PARSERS[type];
      if (!parser) throw new Error(`No parser for ATS type: ${type}`);
      const jobs = parser(json, company.name, url);
      processJobs(jobs, `${type}-api`);
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(apiTasks, CONCURRENCY);

  // 5. Write results
  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  // 6. Print summary
  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Portal Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${sliced.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFiltered} removed`);
  console.log(`Duplicates:            ${totalDupes} skipped`);
  console.log(`New offers added:      ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) {
      console.log(`  ✗ ${e.company}: ${e.error}`);
    }
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title} | ${o.location || 'N/A'}`);
    }
    if (dryRun) {
      console.log('\n(dry run — run without --dry-run to save results)');
    } else {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
  console.log('→ Share results and get help: https://discord.gg/8pRpHETxa4');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
