#!/usr/bin/env node
/**
 * Pre-Crime -- Tavily diagnostic
 *
 * Calls the Tavily Extract API directly the same way the goose MCP does,
 * captures the full response to disk, and prints a summary.
 *
 * Purpose: see what the agent actually receives when it scrapes a directory
 * page. If Tavily returns the vendor list, the agent's extraction is broken.
 * If Tavily returns thin/summarized content, Tavily params need tuning.
 *
 * Usage:
 *   node data/diag-tavily.js                      (defaults: 2616commerce vendors page)
 *   node data/diag-tavily.js --url <URL>
 *   node data/diag-tavily.js --url <URL> --env "C:\path\to\deployment\.env"
 *
 * Output: data/diag-tavily-<timestamp>.json with the full payload, plus
 * stdout summary showing what the agent would see.
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PRECRIME_ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// CLI + .env loading
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const getArg = f => { const i = args.indexOf(f); return i !== -1 ? args[i + 1] : null; };

const url = getArg('--url') || 'https://www.2616commerce.com/event-vendors-list';
const envPath = path.resolve(getArg('--env') || 'C:\\Users\\Admin\\Desktop\\WKG\\PHOTOBOOTH\\DALLAS\\precrime\\.env');

if (!fs.existsSync(envPath)) {
    console.error(`ERROR: .env file not found: ${envPath}`);
    console.error('Pass --env <path> to point at your deployment .env.');
    process.exit(1);
}

// Minimal .env parser (no dotenv dep)
const envContent = fs.readFileSync(envPath, 'utf8');
const env = {};
for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    val = val.replace(/^["']|["']$/g, '');  // strip surrounding quotes
    env[key] = val;
}

const apiKey = env.TAVILY_API_KEY;
if (!apiKey || apiKey === 'tvly-REPLACE_ME') {
    console.error('ERROR: TAVILY_API_KEY missing or placeholder in .env.');
    process.exit(1);
}

console.log('==========================================================');
console.log('  Tavily Extract Diagnostic');
console.log('==========================================================');
console.log(`  URL:     ${url}`);
console.log(`  API key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);
console.log('');

// ---------------------------------------------------------------------------
// Call Tavily extract API -- both depths, so we can see the difference
// ---------------------------------------------------------------------------

async function callExtract(depth) {
    const body = {
        urls: [url],
        extract_depth: depth,           // "basic" or "advanced"
        include_images: false,
        format: 'markdown'
    };

    console.log(`Calling Tavily extract (depth=${depth})...`);
    const t0 = Date.now();

    const res = await fetch('https://api.tavily.com/extract', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
    });

    const elapsed = Date.now() - t0;
    const text = await res.text();

    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
        console.error(`  Failed to parse response as JSON. Status: ${res.status}`);
        console.error(`  Body: ${text.slice(0, 500)}`);
        return null;
    }

    console.log(`  HTTP ${res.status} in ${elapsed}ms`);
    return { depth, status: res.status, elapsed, response: parsed };
}

// Heuristic: count phrases that look like business names in a text blob.
// 2-5 word title-cased phrases, not in a stop-word list.
function countLikelyBusinessNames(text) {
    if (!text || typeof text !== 'string') return { count: 0, samples: [] };

    const STOP = new Set([
        'home', 'about', 'contact', 'login', 'sign in', 'sign up', 'menu',
        'search', 'categories', 'all categories', 'featured', 'top rated',
        'next', 'previous', 'page', 'view', 'more', 'less', 'show', 'hide',
        'navigation', 'header', 'footer', 'sidebar', 'toggle', 'main',
        'dallas', 'texas', 'usa', 'united states', 'wedding', 'event',
        'vendor', 'vendors', 'listing', 'directory', 'click here'
    ]);

    // Match 2-5 capitalized words in a row (allow & and - within)
    const matches = text.match(/(?:[A-Z][a-zA-Z'&\-0-9]+(?:\s+[A-Z][a-zA-Z'&\-0-9]+){1,4})/g) || [];

    const candidates = new Set();
    for (const m of matches) {
        const lower = m.toLowerCase();
        if (STOP.has(lower)) continue;
        if (lower.split(/\s+/).every(w => STOP.has(w))) continue;
        candidates.add(m);
    }

    const arr = [...candidates];
    return { count: arr.length, samples: arr.slice(0, 25) };
}

(async () => {
    const results = [];
    for (const depth of ['basic', 'advanced']) {
        const r = await callExtract(depth);
        if (r) results.push(r);
        console.log('');
    }

    // Save full payload
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const outFile = path.resolve(__dirname, `diag-tavily-${ts}.json`);
    fs.writeFileSync(outFile, JSON.stringify({
        url,
        timestamp: ts,
        results
    }, null, 2));
    console.log(`Full payload written to: ${outFile}`);
    console.log('');

    // ---------------------------------------------------------------------
    // Summary
    // ---------------------------------------------------------------------
    console.log('==========================================================');
    console.log('  Summary -- what the agent would see');
    console.log('==========================================================');

    for (const r of results) {
        console.log(`\n--- depth: ${r.depth} ---`);
        const resp = r.response;
        const items = resp?.results || [];
        if (items.length === 0) {
            console.log('  No results returned.');
            if (resp?.failed_results) console.log(`  failed_results: ${JSON.stringify(resp.failed_results)}`);
            continue;
        }
        const item = items[0];
        const content = item.raw_content || item.content || '';
        const contentChars = content.length;
        const heur = countLikelyBusinessNames(content);

        console.log(`  raw_content length:   ${contentChars} chars`);
        console.log(`  likely business names found by regex: ${heur.count}`);
        if (heur.samples.length) {
            console.log(`  first ${Math.min(heur.samples.length, 25)} candidates:`);
            for (const s of heur.samples) console.log(`    - ${s}`);
        }
        console.log(`\n  --- first 800 chars of content ---`);
        console.log('  ' + content.slice(0, 800).split('\n').join('\n  '));
        console.log(`  --- end preview ---`);
    }

    console.log('\n==========================================================');
    console.log('  Verdict guidance:');
    console.log('  - If "likely business names" >> 10 in either depth: Tavily');
    console.log('    is delivering the data. Agent extraction is the bug.');
    console.log('  - If both depths show 0-3 names: Tavily is returning thin');
    console.log('    content. Tweak Tavily call (or switch scrape strategy).');
    console.log('  - If basic=thin but advanced=rich: agent should request');
    console.log('    extract_depth: "advanced" in the MCP call.');
    console.log('==========================================================');
})();
