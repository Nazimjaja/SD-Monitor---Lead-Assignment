'use strict';
// Covers what the agent actually sees: the popup in each of its states, in both
// colour schemes. Screenshots land in tests/.screenshots/ (git-ignored) so a visual
// change can be eyeballed; the assertions below are what makes it a test.

const path = require('path');
const fs = require('fs');
const { loadPlaywright, json, startSnowPage, createResults, SNOW_ORIGIN } = require('./harness');

const SHOT_DIR = path.join(__dirname, '.screenshots');

const TICKETS = [
    { sys_id: 'S1', table: 'incident', number: 'INC2105486', short_desc: 'Outlook not syncing for the whole Lyon warehouse team since the maintenance window', priority: 'P1', origin: SNOW_ORIGIN },
    { sys_id: 'S2', table: 'incident', number: 'INC2105502', short_desc: 'Badge reader offline at gate 3', priority: 'P2', origin: SNOW_ORIGIN },
    { sys_id: 'S3', table: 'sc_task', number: 'TASK0044981', short_desc: 'New starter laptop preparation', priority: '', origin: SNOW_ORIGIN },
    { sys_id: 'S4', table: 'incident', number: 'INC2105511', short_desc: 'Printer jam on the 2nd floor', priority: 'P3', origin: SNOW_ORIGIN }
];
const AGES = [5, 100, 130, 20]; // seconds since each alert started

// Popups are created through the real GM event stream rather than by calling
// internals, so this exercises the same path a mirror tab uses.
async function showAll(page) {
    for (const [i, ticket] of TICKETS.entries()) {
        await page.evaluate(({ ticket, age }) => {
            window.GM_setValue('sdAckMonitor_event', JSON.stringify({
                type: 'TICKET_POPUP', ticket, shownAt: Date.now() - age * 1000, _id: 'e' + Math.random()
            }));
        }, { ticket, age: AGES[i] });
        await page.waitForTimeout(120);
    }
    await page.evaluate(ticket => {
        window.GM_setValue('sdAckMonitor_event', JSON.stringify({
            type: 'TICKET_ACKED', ticket, ackedBy: 'Nazim FODIL', _id: 'a' + Math.random()
        }));
    }, TICKETS[3]);
    await page.waitForTimeout(900);
}

async function run() {
    const { chromium } = loadPlaywright();
    const r = createResults('popup');
    const browser = await chromium.launch();
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    for (const scheme of ['light', 'dark']) {
        const page = await startSnowPage(browser, {
            colorScheme: scheme,
            version: '0.0-test',
            handler: url => (/_list\.do$/.test(url.pathname) ? json({ records: [] }) : null)
        });
        await showAll(page);

        const shot = path.join(SHOT_DIR, `popup-${scheme}.png`);
        await page.screenshot({ path: shot });

        r.check(`[${scheme}] every ticket gets a popup`, (await page.locator('.sdmPopup').count()) === TICKETS.length);
        r.check(`[${scheme}] priority chip is rendered`,
            (await page.locator('.sdmPopup').first().locator('.sdmPrio').textContent()) === 'P1');
        r.check(`[${scheme}] countdown is mm:ss`,
            /^\d{2}:\d{2}$/.test(await page.locator('.sdmPopup').first().locator('.sdmTime').textContent()));

        // The progress bar has to reflect time left. Its width goes through a custom
        // property because an inline width cannot beat the rule's own !important —
        // the first cut of this design shipped four permanently-full bars.
        const widths = await page.locator('.sdmFill').evaluateAll(els => els.map(e => e.getBoundingClientRect().width));
        r.check(`[${scheme}] progress bar drains with the clock`, widths[0] > widths[1] && widths[1] > widths[2],
            widths.map(w => Math.round(w)).join(' > '));
        r.check(`[${scheme}] an overdue popup empties its bar`, widths[2] === 0);
        r.check(`[${scheme}] overdue is called out`,
            (await page.locator('.sdmPopup').nth(2).locator('.sdmTime').textContent()) === 'OVERDUE');
        r.check(`[${scheme}] acknowledged state names who did it`,
            (await page.locator('.sdmPopup.sdmAcked .sdmDoneText').textContent()).includes('Nazim FODIL'));
        r.check(`[${scheme}] the version badge is on the status pill`,
            (await page.locator('#sdmStatusIndicator .sdmVer').textContent()) === 'v0.0-test');

        await page.close();
    }

    console.log(`  screenshots: ${SHOT_DIR}`);
    await browser.close();
    return r.report();
}

module.exports = { run };
if (require.main === module) run().then(f => process.exit(f ? 1 : 0));
