'use strict';
// Covers the authentication behaviour added in 0.11 — the fix for the browser's
// native credential dialog reappearing every poll.
//
// The regression this guards against is expensive and invisible from the code: a
// request that goes out without a real X-UserToken gets 401 + WWW-Authenticate:
// BASIC back, which is what makes Chrome show a username/password box that no SSO
// login can satisfy. On a 15s poll, forever.

const { loadPlaywright, json, html, ticketRecord, startSnowPage, createResults, TOKEN } = require('./harness');

async function run() {
    const { chromium } = loadPlaywright();
    const r = createResults('session');
    const browser = await chromium.launch();

    // mode is flipped mid-test to simulate the session dying under the poll.
    let mode = 'ok';
    const seen = [];

    const page = await startSnowPage(browser, {
        handler: url => {
            if (/_list\.do$/.test(url.pathname)) {
                if (mode === '401') return { status: 401, headers: { 'WWW-Authenticate': 'BASIC realm="Service-now"' }, body: 'denied' };
                if (mode === 'loginpage') return html('<html><title>Sign In</title><form action="login.do"></form></html>');
                const table = url.pathname.slice(1).replace('_list.do', '');
                return json({ records: table === 'incident' ? [ticketRecord()] : [] });
            }
            return null;
        }
    });
    page.on('request', req => seen.push({ url: req.url(), headers: req.headers() }));

    // 1. The token actually goes out.
    await page.waitForSelector('.sdmPopup', { timeout: 10000 });
    const listReq = seen.find(s => /_list\.do/.test(s.url));
    r.check('poll sends a real X-UserToken', listReq && listReq.headers['x-usertoken'] === TOKEN,
        listReq ? `sent ${JSON.stringify(listReq.headers['x-usertoken'])}` : 'no list request seen');
    r.check('token is never sent empty', !seen.some(s => s.headers['x-usertoken'] === ''));

    // 2. A 401 stops the loop rather than re-provoking the dialog.
    mode = '401';
    await page.evaluate(() => window.__ackMonitorDebug.forcePoll());
    await page.waitForFunction(() => window.__ackMonitorDebug.session().broken, null, { timeout: 10000 });
    r.check('401 marks the session broken', true);
    r.check('status pill shows the signed-out state',
        (await page.locator('.sdmStatusText').textContent()).includes('signed out'));
    r.check('reconnect button is offered', await page.locator('.sdmReconnectBtn').isVisible());

    const before = seen.length;
    await page.waitForTimeout(9000); // three poll ticks
    const after = seen.filter((s, i) => i >= before && /_list\.do|api\/now/.test(s.url));
    r.check('a broken session stops polling', after.length === 0, `${after.length} request(s) after the break`);

    // 3. Reconnect recovers without a reload.
    mode = 'ok';
    await page.click('.sdmReconnectBtn');
    await page.waitForFunction(() => !window.__ackMonitorDebug.session().broken, null, { timeout: 10000 });
    await page.waitForTimeout(1500);
    r.check('reconnect resumes polling',
        (await page.locator('.sdmStatusText').textContent()).includes('pending'));

    // 4. An SSO login page served as 200 is recognised, not parsed as JSON.
    mode = 'loginpage';
    await page.evaluate(() => window.__ackMonitorDebug.forcePoll());
    await page.waitForFunction(() => window.__ackMonitorDebug.session().broken, null, { timeout: 10000 });
    r.check('a 200 login page is treated as a dead session', true);

    await browser.close();
    return r.report();
}

module.exports = { run };
if (require.main === module) run().then(f => process.exit(f ? 1 : 0));
