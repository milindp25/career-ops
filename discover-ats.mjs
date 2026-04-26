#!/usr/bin/env node

/**
 * discover-ats.mjs — One-time career page profiler (zero Claude tokens)
 *
 * Visits each company's careers_url with Playwright, detects:
 *   - ATS platform (Greenhouse, Lever, Workday, SmartRecruiters, etc.)
 *   - API endpoint (if the ATS exposes one)
 *   - Job listing CSS selector (for cheap future scraping)
 *   - Pagination type
 *
 * Saves results to data/page-profiles.json
 * Future scans use stored selectors instead of full snapshots → 80%+ token reduction.
 *
 * Usage:
 *   node discover-ats.mjs                         # profile all un-profiled companies
 *   node discover-ats.mjs --refresh               # re-profile all (including existing)
 *   node discover-ats.mjs --company "Stripe"      # single company
 *   node discover-ats.mjs --batch 20              # first 20 only
 *   node discover-ats.mjs --batch 20 --offset 20  # next 20
 *   node discover-ats.mjs --dry-run               # visit pages but don't save
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { chromium } from 'playwright';
import yaml from 'js-yaml';

// ── Config ───────────────────────────────────────────────────────────

const PORTALS_PATH    = 'portals.yml';
const PROFILES_PATH   = 'data/page-profiles.json';
const CONCURRENCY     = 3;
const PAGE_TIMEOUT_MS = 20_000;
const WAIT_FOR_JS_MS  = 2_500;

mkdirSync('data', { recursive: true });

// ── ATS detection from URL ────────────────────────────────────────────

function detectAtsFromUrl(url) {
  if (!url) return null;
  if (/boards\.greenhouse\.io|job-boards(?:\.eu)?\.greenhouse\.io/.test(url)) return 'greenhouse';
  if (/jobs\.lever\.co/.test(url))           return 'lever';
  if (/jobs\.ashbyhq\.com/.test(url))        return 'ashby';
  if (/myworkdayjobs\.com/.test(url))        return 'workday';
  if (/smartrecruiters\.com/.test(url))      return 'smartrecruiters';
  if (/icims\.com/.test(url))                return 'icims';
  if (/taleo\.net/.test(url))                return 'taleo';
  if (/bamboohr\.com\/careers/.test(url))    return 'bamboohr';
  if (/teamtailor\.com/.test(url))           return 'teamtailor';
  if (/jobs\.jobvite\.com|app\.jobvite\.com/.test(url)) return 'jobvite';
  if (/lever\.co/.test(url))                 return 'lever';
  if (/greenhouse\.io/.test(url))            return 'greenhouse';
  return null;
}

// ── ATS detection from page content ──────────────────────────────────

async function detectAtsFromPage(page) {
  try {
    return await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      if (/greenhouse\.io|gh-token|Greenhouse/.test(html)) return 'greenhouse';
      if (/lever\.co|lever-job|LeverPosting/.test(html))   return 'lever';
      if (/ashbyhq\.com|ashby-job/.test(html))             return 'ashby';
      if (/myworkdayjobs|workday\.com/.test(html))         return 'workday';
      if (/smartrecruiters\.com|SmartRecruiters/.test(html)) return 'smartrecruiters';
      if (/icims\.com|iCIMS/.test(html))                   return 'icims';
      if (/taleo\.net|Taleo/.test(html))                   return 'taleo';
      if (/bamboohr\.com|BambooHR/.test(html))             return 'bamboohr';
      if (/teamtailor\.com/.test(html))                    return 'teamtailor';
      if (/jobvite\.com|Jobvite/.test(html))               return 'jobvite';
      return null;
    });
  } catch {
    return null;
  }
}

// ── API endpoint construction ─────────────────────────────────────────

function buildApiEndpoint(ats, finalUrl) {
  try {
    const u = new URL(finalUrl);
    const parts = u.pathname.split('/').filter(Boolean);

    switch (ats) {
      case 'greenhouse': {
        const slug = parts[0];
        return slug ? `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` : null;
      }
      case 'lever': {
        const slug = parts[0];
        return slug ? `https://api.lever.co/v0/postings/${slug}?mode=json` : null;
      }
      case 'ashby': {
        const slug = parts[0];
        return slug ? `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true` : null;
      }
      case 'workday': {
        // {tenant}.wd5.myworkdayjobs.com/{site}
        const tenant = u.hostname.split('.')[0];
        const site   = parts[0];
        if (tenant && site) {
          return `https://${u.hostname}/wday/cxs/${tenant}/${site}/jobs`;
        }
        return null;
      }
      case 'bamboohr': {
        const tenant = u.hostname.split('.')[0];
        return tenant ? `https://${tenant}.bamboohr.com/careers/list` : null;
      }
      case 'teamtailor': {
        return `${u.origin}/jobs.json`;
      }
      case 'smartrecruiters': {
        // careers.smartrecruiters.com/{slug}
        const slug = parts[0];
        return slug ? `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=100` : null;
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── Job selector candidates (tried in order) ─────────────────────────

const SELECTOR_CANDIDATES = [
  // Greenhouse
  { sel: 'li.opening a',                              ats: 'greenhouse' },
  { sel: '.opening a[href]',                          ats: 'greenhouse' },
  // Lever
  { sel: '.posting h5 a',                             ats: 'lever' },
  { sel: '[data-qa="posting-name"]',                  ats: 'lever' },
  { sel: '.postings-group .posting a',                ats: 'lever' },
  // Ashby
  { sel: 'a[class*="JobPosting"]',                    ats: 'ashby' },
  { sel: '[data-testid="job-listing-item"] a',        ats: 'ashby' },
  // Workday
  { sel: '[data-automation-id="jobFoundDescription"]',ats: 'workday' },
  { sel: 'li[data-automation-id] a[data-automation-id]', ats: 'workday' },
  // SmartRecruiters
  { sel: '.js-job-link',                              ats: 'smartrecruiters' },
  { sel: 'article.js-job a',                         ats: 'smartrecruiters' },
  // iCIMS
  { sel: '.iCIMS_Anchor',                             ats: 'icims' },
  { sel: '.iCIMS_JobsTable a',                        ats: 'icims' },
  // Teamtailor
  { sel: '[data-controller="job"] a',                 ats: 'teamtailor' },
  { sel: '.job-listings a[href*="/jobs/"]',            ats: 'teamtailor' },
  // Jobvite
  { sel: '.jv-job-list-name a',                       ats: 'jobvite' },
  { sel: 'a.jv-job-item',                             ats: 'jobvite' },
  // Generic — try last
  { sel: 'a[href*="/jobs/"][class]',                  ats: null },
  { sel: 'a[href*="/job/"][class]',                   ats: null },
  { sel: '[class*="job-listing"] a[href]',            ats: null },
  { sel: '[class*="job-item"] a[href]',               ats: null },
  { sel: '[class*="position-listing"] a[href]',       ats: null },
  { sel: '[class*="opening"] a[href]',                ats: null },
  { sel: '[class*="career"] li a[href]',              ats: null },
];

async function findJobSelector(page, detectedAts) {
  // Prioritise ATS-specific selectors first
  const ordered = [
    ...SELECTOR_CANDIDATES.filter(c => c.ats === detectedAts),
    ...SELECTOR_CANDIDATES.filter(c => c.ats !== detectedAts),
  ];

  for (const { sel } of ordered) {
    try {
      const count = await page.locator(sel).count();
      if (count >= 2) return sel; // at least 2 matches = likely a real listing
    } catch {
      // selector syntax error, skip
    }
  }
  return null;
}

// ── Pagination detection ──────────────────────────────────────────────

async function detectPagination(page) {
  try {
    return await page.evaluate(() => {
      if (document.querySelector('[data-automation-id="paginationNextButton"]')) return 'pages';
      if (document.querySelector('.pagination a[rel="next"]')) return 'pages';
      if (document.querySelector('button[aria-label*="next"]')) return 'pages';
      if (document.querySelector('[class*="LoadMore"], [class*="load-more"]')) return 'load-more';
      if (document.querySelector('button[class*="load"], button[class*="more"]')) return 'load-more';
      return 'none';
    });
  } catch {
    return 'unknown';
  }
}

// ── Profile a single company ──────────────────────────────────────────

async function profileCompany(browser, company) {
  const result = {
    name:          company.name,
    careers_url:   company.careers_url,
    ats:           null,
    api_endpoint:  company.api || null, // keep existing if already set
    job_selector:  null,
    pagination:    'none',
    status:        'ok',
    last_verified: new Date().toISOString().slice(0, 10),
    error:         null,
  };

  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (compatible; career-ops-scanner/1.0)' });
  const page    = await context.newPage();

  try {
    await page.goto(company.careers_url, {
      waitUntil: 'domcontentloaded',
      timeout:   PAGE_TIMEOUT_MS,
    });

    // Wait for JS-rendered content
    await page.waitForTimeout(WAIT_FOR_JS_MS);

    const finalUrl = page.url();

    // ATS detection: URL first (most reliable), then page content
    result.ats = detectAtsFromUrl(finalUrl)
      ?? detectAtsFromUrl(company.careers_url)
      ?? await detectAtsFromPage(page);

    // Build API endpoint if not already set
    if (!result.api_endpoint && result.ats) {
      result.api_endpoint = buildApiEndpoint(result.ats, finalUrl);
    }

    // Find job listing selector
    result.job_selector = await findJobSelector(page, result.ats);

    // Detect pagination
    result.pagination = await detectPagination(page);

  } catch (err) {
    result.status = 'error';
    result.error  = err.message.slice(0, 120);
  } finally {
    await context.close();
  }

  return result;
}

// ── Concurrency helper ────────────────────────────────────────────────

async function runWithConcurrency(tasks, limit) {
  const results = [];
  const queue   = [...tasks];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      results.push(await task());
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const args          = process.argv.slice(2);
  const dryRun        = args.includes('--dry-run');
  const refresh       = args.includes('--refresh');
  const companyFlag   = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const batchFlag     = args.indexOf('--batch');
  const batchSize     = batchFlag !== -1 ? parseInt(args[batchFlag + 1], 10) : null;
  const offsetFlag    = args.indexOf('--offset');
  const batchOffset   = offsetFlag !== -1 ? parseInt(args[offsetFlag + 1], 10) : 0;

  // Load portals.yml
  if (!existsSync(PORTALS_PATH)) {
    console.error('portals.yml not found.');
    process.exit(1);
  }
  const config    = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = (config.tracked_companies || []).filter(c => c.enabled !== false && c.careers_url);

  // Load existing profiles
  const profiles = existsSync(PROFILES_PATH)
    ? JSON.parse(readFileSync(PROFILES_PATH, 'utf-8'))
    : {};

  // Filter targets
  let targets = companies;
  if (filterCompany) {
    targets = targets.filter(c => c.name.toLowerCase().includes(filterCompany));
  } else if (!refresh) {
    targets = targets.filter(c => !profiles[c.name]); // skip already profiled
  }
  if (batchSize) {
    targets = targets.slice(batchOffset, batchOffset + batchSize);
  }

  if (targets.length === 0) {
    console.log('All companies already profiled. Use --refresh to re-profile.');
    return;
  }

  const batchLabel = batchSize
    ? ` [${batchOffset + 1}–${batchOffset + targets.length} of ${companies.length}]`
    : ` (${companies.length - targets.length} already profiled, ${targets.length} remaining)`;

  console.log(`\nDiscover ATS${batchLabel}`);
  console.log(`Profiling ${targets.length} career pages with ${CONCURRENCY} parallel browsers...`);
  if (dryRun) console.log('(dry run — results will not be saved)\n');
  else console.log('');

  let done = 0;
  const browser = await chromium.launch({ headless: true });

  const tasks = targets.map(company => async () => {
    const result = await profileCompany(browser, company);
    done++;
    const icon   = result.status === 'ok' ? '✓' : '✗';
    const atsTag = result.ats ? `[${result.ats}]` : '[unknown]';
    const selTag = result.job_selector ? '✓ selector' : '✗ no selector';
    const apiTag = result.api_endpoint ? '✓ api' : '';
    console.log(`  ${icon} [${done}/${targets.length}] ${company.name.padEnd(35)} ${atsTag.padEnd(18)} ${selTag} ${apiTag}`);

    // Save incrementally (don't lose progress if script crashes)
    if (!dryRun) {
      profiles[company.name] = result;
      writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2));
    }

    return result;
  });

  const results = await runWithConcurrency(tasks, CONCURRENCY);
  await browser.close();

  // Summary
  const ok         = results.filter(r => r.status === 'ok').length;
  const errors     = results.filter(r => r.status === 'error');
  const withAts    = results.filter(r => r.ats).length;
  const withSel    = results.filter(r => r.job_selector).length;
  const withApi    = results.filter(r => r.api_endpoint).length;

  console.log(`\n${'━'.repeat(55)}`);
  console.log(`ATS Discovery — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`${'━'.repeat(55)}`);
  console.log(`Pages visited:      ${results.length}`);
  console.log(`Successful:         ${ok}`);
  console.log(`ATS detected:       ${withAts}  (API endpoint found for ${withApi})`);
  console.log(`Selector found:     ${withSel}`);
  console.log(`Errors:             ${errors.length}`);

  if (errors.length) {
    console.log('\nFailed:');
    errors.forEach(e => console.log(`  ✗ ${e.name}: ${e.error}`));
  }

  const totalProfiled = Object.keys(profiles).length;
  console.log(`\nTotal profiled so far: ${totalProfiled} / ${companies.length}`);
  console.log(`Remaining:             ${companies.length - totalProfiled}`);
  if (!dryRun) console.log(`\nProfiles saved → ${PROFILES_PATH}`);
  if (companies.length - totalProfiled > 0) {
    console.log(`\nRun again to profile remaining companies.`);
  } else {
    console.log(`\nAll companies profiled! Run: node scan.mjs`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
