'use strict';
// OLA Watch tracking more than one OLA definition at once, with different
// lifetimes: INC-RES-CORP-SD runs an hour, CTSK-RES-CORP-SD runs four.
//
// The thing worth protecting here is that nothing downstream knows how long an
// OLA is supposed to be. Percentage, the "Breaching soon" band and the countdown
// all come from each row's own start_time / planned_end_time / sla.duration, so
// the two clocks share one set of percentage thresholds without sharing a
// duration. A regression would look like the 4-hour OLA being read against a
// 1-hour window — on screen at 75% about forty minutes in, hours early.

const path = require('path');
const fs = require('fs');
const { loadPlaywright, json, startSnowPage, createResults } = require('./harness');

const SHOT_DIR = path.join(__dirname, '.screenshots');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const snow = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// elapsed/total are what the row should read as; the record is built backwards
// from "now" so the assertions don't depend on when the suite runs.
function olaRecord({ id, number, table, name, duration, elapsed, total, assignee = '' }) {
    const now = Date.now();
    return {
        sys_id: { value: id }, stage: { value: 'in_progress' },
        // Deliberately wrong, and deliberately different per row: the script
        // derives its own percentage and must not fall back to this one.
        percentage: { value: '1' }, has_breached: { value: 'false' },
        start_time: { value: snow(now - elapsed) },
        planned_end_time: { value: snow(now - elapsed + total) },
        'sla.name': { display_value: name, value: name },
        'sla.duration': { value: duration },
        'sla.schedule': { value: '' }, 'sla.schedule_source': { value: '' },
        'task.sys_id': { value: 'T' + id }, 'task.number': { display_value: number },
        'task.sys_class_name': { value: table },
        'task.short_description': { display_value: `desc for ${number}` },
        'task.assigned_to': { value: assignee, display_value: assignee },
        'task.priority': { display_value: '2 - High' }
    };
}

const RECORDS = [
    // 1-hour incident OLA, 45 minutes in: 75%, a quarter of an hour left.
    olaRecord({ id: 'A', number: 'INC2105486', table: 'incident', name: 'INC-RES-CORP-SD',
        duration: '1970-01-01 01:00:00', elapsed: 45 * MIN, total: 60 * MIN + 30000 }),
    // 4-hour catalog-task OLA, 3 hours in: the same 75%, but an hour left.
    olaRecord({ id: 'B', number: 'CTASK0044981', table: 'sc_task', name: 'CTSK-RES-CORP-SD',
        duration: '1970-01-01 04:00:00', elapsed: 3 * HOUR, total: 4 * HOUR + 30000 }),
    // 4-hour OLA only 45 minutes in: 18.75%, below SHOW_AT. Read against a
    // 1-hour window it would be 75% and on screen — this is the regression row.
    olaRecord({ id: 'C', number: 'CTASK0044982', table: 'sc_task', name: 'CTSK-RES-CORP-SD',
        duration: '1970-01-01 04:00:00', elapsed: 45 * MIN, total: 4 * HOUR })
];

async function run() {
    const { chromium } = loadPlaywright();
    const r = createResults('watch');
    const browser = await chromium.launch();
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const seen = [];

    try {
        const page = await startSnowPage(browser, {
            script: 'watch',
            handler(url) {
                if (url.pathname === '/sys_user_group_list.do') return json({ records: [{ sys_id: 'GRP1' }] });
                if (url.pathname === '/api/now/table/task_sla') {
                    seen.push(decodeURIComponent(url.search));
                    return json({ result: RECORDS });
                }
                return null;
            }
        });
        await page.waitForTimeout(1200);
        await page.click('#olaRibbon');
        await page.waitForTimeout(200);

        // One query for both, not one per name — and an IN clause, since two
        // `sla.name=` terms ANDed together would match nothing.
        const q = seen.join('\n');
        r.check('one task_sla request', seen.length === 1, `${seen.length} request(s)`);
        r.check('query asks for both OLAs by name',
            /sla\.nameININC-RES-CORP-SD,CTSK-RES-CORP-SD/.test(q),
            (q.match(/sla\.name[^^&]*/) || ['?'])[0]);
        r.check('query still scopes to the group and stage',
            /task\.assignment_group=GRP1/.test(q) && /stage=in_progress/.test(q));

        const rows = await page.evaluate(() => [...document.querySelectorAll('#olaPanel .olaRow')].map(el => ({
            number: el.querySelector('.olaNum').textContent,
            clock: el.querySelector('.olaClock').textContent,
            crit: el.querySelector('.olaClock').classList.contains('olaCrit'),
            title: el.title
        })));

        r.check('both at-risk rows are listed, from two different OLAs', rows.length === 2,
            rows.map(x => x.number).join(', ') || 'none');
        const inc = rows.find(x => x.number === 'INC2105486');
        const ctask = rows.find(x => x.number === 'CTASK0044981');
        r.check('the 1-hour incident OLA is listed', !!inc);
        r.check('the 4-hour catalog-task OLA is listed', !!ctask);

        // The whole point: same percentage, different amounts of time left.
        r.check('1-hour OLA shows ~15 minutes left', inc && /^1[45]:\d\d$/.test(inc.clock), inc && inc.clock);
        r.check('4-hour OLA shows ~1 hour left', ctask && /^(1:00:\d\d|59:\d\d)$/.test(ctask.clock), ctask && ctask.clock);
        r.check('both are in the breaching band at 75%', inc && ctask && inc.crit && ctask.crit);

        // Read against a 1-hour window this one would be 75% and on screen.
        r.check('the young 4-hour OLA is not on screen',
            !rows.some(x => x.number === 'CTASK0044982'),
            'CTASK0044982 is 18.75% consumed, below SHOW_AT');

        // Mixed clocks need the name somewhere, and the row is the only place.
        r.check('rows name their OLA', ctask && /CTSK-RES-CORP-SD/.test(ctask.title), ctask && JSON.stringify(ctask.title));

        // A catalog task links to its own table, not to incident.
        const href = await page.evaluate(() => {
            const el = [...document.querySelectorAll('#olaPanel .olaRow')].find(n => n.querySelector('.olaNum').textContent === 'CTASK0044981');
            let opened = null;
            const real = window.open;
            window.open = u => { opened = u; };
            el.click();
            window.open = real;
            return opened;
        });
        r.check('catalog task opens on sc_task', /sc_task\.do\?sys_id=TB/.test(href || ''), href);

        await page.screenshot({ path: path.join(SHOT_DIR, 'watch-two-olas.png'), clip: { x: 0, y: 0, width: 340, height: 260 } });
        await page.close();
    } finally {
        await browser.close();
    }

    return r.report();
}

if (require.main === module) run().then(f => process.exit(f ? 1 : 0));
module.exports = { run };
