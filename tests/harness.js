'use strict';
// Shared plumbing for the browser tests.
//
// The userscript is not loadable as a module — it is an IIFE that expects a browser
// and Tampermonkey's GM_* API — so every test here runs it the way it actually runs:
// evaluated into a real page, on a hostname that satisfies its SNOW check, with the
// GM_* API stubbed and every network call intercepted.

const path = require('path');
const fs = require('fs');

const SCRIPT_PATH = path.join(__dirname, '..', 'OLA ACK.user.js');
const SNOW_ORIGIN = 'https://test.service-now.com';
const TOKEN = 'a'.repeat(40); // any 32+ char string satisfies the g_ck length check

// Playwright may be a local devDependency or a global install (CI images often have
// one already). Try both before giving up, and say what to do if neither is there.
function loadPlaywright() {
    for (const id of ['playwright', 'playwright-core', '/opt/pw/node_modules/playwright', '/opt/node22/lib/node_modules/playwright']) {
        try { return require(id); } catch { /* keep looking */ }
    }
    throw new Error('Playwright not found — run `npm install` in tests/, or point NODE_PATH at a global install.');
}

function readUserscript() {
    return fs.readFileSync(SCRIPT_PATH, 'utf8');
}

// Minimal but faithful GM_* implementations. GM storage is per-page here, which
// matches a single browser profile; the cross-tab paths are not what these cover.
async function installGmStubs(page, version = '0.0-test') {
    await page.addInitScript(v => {
        const store = {};
        const listeners = {};
        window.GM_setValue = (k, val) => {
            const old = store[k];
            store[k] = val;
            (listeners[k] || []).forEach(fn => fn(k, old, val, false));
        };
        window.GM_getValue = (k, d) => (k in store ? store[k] : d);
        window.GM_deleteValue = k => { delete store[k]; };
        window.GM_addValueChangeListener = (k, fn) => { (listeners[k] = listeners[k] || []).push(fn); };
        window.GM_addStyle = css => {
            const el = document.createElement('style');
            el.textContent = css;
            document.head.appendChild(el);
        };
        window.GM_info = { script: { version: v } };
        window.unsafeWindow = window;
        // What the script reads to identify the signed-in agent.
        window.g_user_id = 'USER123';
        window.g_user_name = 'Test Agent';
    }, version);
}

// Every test builds its instance out of these: a handler gets the parsed URL and
// returns a body, or null to fall through to the default SNOW-ish blank page.
async function installRoutes(page, handler) {
    await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/blank.do') {
            return route.fulfill({ contentType: 'text/html', body: `<script>var g_ck = "${TOKEN}";</script>` });
        }
        const answer = await handler(url, route);
        if (answer) return route.fulfill(answer);
        return route.fulfill({ contentType: 'text/html', body: '<html><body></body></html>' });
    });
}

function json(body, status = 200) {
    return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

function html(body, status = 200) {
    return { status, contentType: 'text/html', body };
}

// Records for the poll's JSONv2 query. Only the fields the script reads matter.
function ticketRecord(over = {}) {
    return {
        sys_id: 'SYS1',
        number: 'INC0001',
        short_description: 'test ticket',
        priority: '1',
        ...over
    };
}

async function startSnowPage(browser, { handler, version, colorScheme, viewport } = {}) {
    const page = await browser.newPage({
        viewport: viewport || { width: 1000, height: 760 },
        colorScheme: colorScheme || 'light'
    });
    await installRoutes(page, handler || (() => null));
    await installGmStubs(page, version);
    await page.goto(SNOW_ORIGIN + '/');
    await page.evaluate(readUserscript());
    return page;
}

// ─── tiny assertion collector ────────────────────────────────────────────────
function createResults(suiteName) {
    const rows = [];
    return {
        check(name, passed, detail = '') {
            rows.push({ name, passed: !!passed, detail });
            const mark = passed ? 'PASS' : 'FAIL';
            console.log(`  ${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
        },
        report() {
            const failed = rows.filter(r => !r.passed);
            console.log(`${suiteName}: ${rows.length - failed.length}/${rows.length} passed`);
            return failed.length;
        }
    };
}

module.exports = {
    SNOW_ORIGIN, TOKEN,
    loadPlaywright, readUserscript, installGmStubs, installRoutes,
    json, html, ticketRecord, startSnowPage, createResults
};
