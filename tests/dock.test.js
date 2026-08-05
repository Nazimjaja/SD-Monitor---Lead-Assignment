'use strict';
// Does the OLA Watch ribbon actually attach itself into the Polaris nav, next to
// All / Favorites / History, without landing on top of any of them?
//
// This suite exists because the two earlier attempts at docking could not be
// confirmed against anything: they were written against a guess at the markup and
// verified by eye. The fixture below is the real container, copied out of the
// instance — absolutely-positioned `.sn-polaris-tab` children carrying the inline
// `left` values ServiceNow computes for them, including the pinned Favorites tab
// sitting at a smaller `left` than All, and the `#nav-overflow` placeholder.
//
// The assertions are geometric: measured rectangles, not screenshots. A ribbon
// that overlaps a tab, lands off-screen, or gets painted underneath something
// fails here rather than on someone's screen.

const path = require('path');
const fs = require('fs');
const { loadPlaywright, json, startSnowPage, createResults } = require('./harness');

const SHOT_DIR = path.join(__dirname, '.screenshots');

// Verbatim from the instance, wrapped in a header strip that behaves like the
// real one: a flex row with the menu on the left and something to its right, so
// "does the ribbon overlap the other buttons" is a question the fixture can
// actually answer.
const POLARIS_HEADER = `
<div id="fixtureHeader" style="position:fixed;top:0;left:0;right:0;height:48px;background:#293e40;display:flex;align-items:center;">
  <div style="width:300px;flex:0 0 auto;color:#fff;font:12px sans-serif;padding-left:12px;">ServiceNow</div>
  <div role="menu" class="sn-polaris-navigation polaris-header-menu" style="min-width: 40px; position: relative; height: 48px; flex: 0 0 auto;"><div id="d6e462a5c3533010cbd77096e940dd8c" role="menuitem" class="sn-polaris-tab can-animate polaris-enabled" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-label="All" unpinnedleft="332" style="position: absolute; margin-inline-end: 0px; left: 332px;">All</div><div id="1b682fe1c3133010cbd77096e940dd18" role="menuitem" class="sn-polaris-tab polaris-enabled is-pinned is-active" tabindex="0" aria-haspopup="true" aria-expanded="true" aria-label="Favorites" style="position: absolute; margin-inline-end: 0px; left: 320px;">Favorites</div><div id="c51543a5c3133010cbd77096e940dd43" role="menuitem" class="sn-polaris-tab can-animate polaris-enabled" tabindex="0" aria-haspopup="true" aria-expanded="false" aria-label="History" unpinnedleft="378" style="position: absolute; margin-inline-end: 0px; left: 378px;">History</div><div id="nav-overflow" role="menuitem" class="sn-polaris-tab tab-overflow is-placeholder can-animate polaris-enabled" aria-haspopup="true" aria-label="More menus" aria-expanded="false" tabindex="0" data-tooltip="Main Menus" unpinnedleft="458" style="position: absolute; margin-inline-end: 0px; left: 458px;">⋮</div></div>
  <div id="fixtureNeighbour" style="flex:0 0 auto;color:#fff;font:12px sans-serif;padding:0 12px;">Search</div>
</div>`;

// The tabs are absolutely positioned and so contribute no width of their own;
// the real nav gives the container an explicit height/position, which the
// fixture above reproduces.
const STYLE = `
<style>
  .sn-polaris-tab { color:#e3ebec; font:12px/32px "Segoe UI",sans-serif; padding:0 10px; top:8px; height:32px; box-sizing:border-box; }
</style>`;

// One OLA at 60% so the panel has a row to show, on a clock that plainly does not
// pause (planned_end is exactly an hour after start), i.e. the fix from 0.11.
function olaRows() {
    const start = new Date(Date.now() - 36 * 60 * 1000);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const snow = d => d.toISOString().slice(0, 19).replace('T', ' ');
    return [{
        sys_id: { value: 'SLA1' }, stage: { value: 'in_progress' },
        percentage: { value: '60' }, has_breached: { value: 'false' },
        start_time: { value: snow(start) }, planned_end_time: { value: snow(end) },
        'sla.duration': { value: '1970-01-01 01:00:00' },
        'sla.schedule': { value: '' }, 'sla.schedule_source': { value: '' },
        'task.sys_id': { value: 'T1' }, 'task.number': { display_value: 'INC2105486' },
        'task.sys_class_name': { value: 'incident' },
        'task.short_description': { display_value: 'Badge reader offline at gate 3' },
        'task.assigned_to': { value: '', display_value: '' },
        'task.priority': { display_value: '2 - High' }
    }];
}

function handler(url) {
    // The group is resolved over JSONv2 (`records`), the OLA rows over the Table
    // API (`result`) — the script uses both, deliberately, and mixing them up is
    // the fastest way to write a test that proves nothing.
    if (url.pathname === '/sys_user_group_list.do') return json({ records: [{ sys_id: 'GRP1' }] });
    if (url.pathname === '/api/now/table/task_sla') return json({ result: olaRows() });
    return null;
}

// Rects overlap only if they genuinely intersect — a shared edge is adjacency.
function overlaps(a, b) {
    return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

async function measure(page) {
    return page.evaluate(() => {
        const box = n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const ribbon = document.getElementById('olaRibbon');
        const host = document.querySelector('.polaris-header-menu');
        return {
            status: window.__olaWatchDebug.panelStatus(),
            ribbon: ribbon ? box(ribbon) : null,
            ribbonParentIsNav: !!(ribbon && ribbon.parentElement === host),
            panel: box(document.getElementById('olaPanel')),
            host: box(host),
            hostMinWidth: host.style.minWidth,
            neighbour: box(document.getElementById('fixtureNeighbour')),
            tabs: [...host.querySelectorAll('.sn-polaris-tab')]
                .filter(t => t.id !== 'olaRibbon')
                .map(t => ({ label: t.getAttribute('aria-label'), ...box(t) }))
        };
    });
}

async function run() {
    const { chromium } = loadPlaywright();
    const r = createResults('dock');
    const browser = await chromium.launch();
    fs.mkdirSync(SHOT_DIR, { recursive: true });

    try {
        const VIEW = { width: 1400, height: 760 };
        const page = await startSnowPage(browser, { script: 'watch', handler, body: STYLE + POLARIS_HEADER, viewport: VIEW });
        await page.waitForTimeout(1200);   // let the dock poll + its two-frame verification run

        let m = await measure(page);

        r.check('ribbon docked into the nav', m.status.mode === 'docked', m.status.dock);
        r.check('ribbon is a child of the real menu container', m.ribbonParentIsNav);
        r.check('ribbon is visible', m.ribbon && m.ribbon.width > 20 && m.ribbon.height > 10,
            m.ribbon ? `${Math.round(m.ribbon.width)}x${Math.round(m.ribbon.height)}` : 'no rect');

        // The point of the exercise.
        const hit = m.tabs.filter(t => t.width > 0 && overlaps(m.ribbon, t));
        r.check('ribbon overlaps no nav tab', hit.length === 0, hit.map(t => t.label).join(', ') || 'clear of all 4');
        r.check('the script agrees it overlaps nothing', m.status.overlapsATab === false);

        // Sitting after the last one, not before or on top of the row.
        const lastRight = Math.max(...m.tabs.filter(t => t.width > 0).map(t => t.right));
        r.check('ribbon sits after the last tab', m.ribbon.left >= lastRight,
            `ribbon.left ${Math.round(m.ribbon.left)} ≥ last tab right ${Math.round(lastRight)}`);

        // Absolutely-positioned children reserve no width, so without the
        // min-width the ribbon would be drawn straight over whatever the header
        // puts to the right of the menu.
        r.check('nav container was widened to reserve the space', parseFloat(m.hostMinWidth) > 40, `min-width: ${m.hostMinWidth}`);
        r.check('ribbon does not overlap the header neighbour', !overlaps(m.ribbon, m.neighbour),
            `ribbon right ${Math.round(m.ribbon.right)}, neighbour left ${Math.round(m.neighbour.left)}`);
        r.check('ribbon stays inside the nav container', m.ribbon.right <= m.host.right + 1,
            `ribbon right ${Math.round(m.ribbon.right)} ≤ host right ${Math.round(m.host.right)}`);

        // Vertically on the tabs' own baseline rather than at some guessed offset.
        const favorites = m.tabs.find(t => t.label === 'Favorites');
        r.check('ribbon lines up with the tab row', Math.abs(m.ribbon.top - favorites.top) <= 1,
            `ribbon top ${Math.round(m.ribbon.top)} vs tab top ${Math.round(favorites.top)}`);

        await page.screenshot({ path: path.join(SHOT_DIR, 'dock-collapsed.png'), clip: { x: 0, y: 0, width: VIEW.width, height: 60 } });

        // Expanded: the list is anchored under the ribbon and clear of the header.
        await page.click('#olaRibbon');
        await page.waitForTimeout(300);
        m = await measure(page);
        r.check('list opens under the ribbon', m.panel.top >= m.ribbon.bottom,
            `panel top ${Math.round(m.panel.top)} ≥ ribbon bottom ${Math.round(m.ribbon.bottom)}`);
        // Anchored to one of the ribbon's edges — left normally, right when a
        // left-aligned list would hang off the screen, which is the usual case
        // docked at the right-hand end of the nav.
        const leftAligned = Math.abs(m.panel.left - m.ribbon.left) <= 1;
        const rightAligned = Math.abs(m.panel.right - m.ribbon.right) <= 1;
        r.check('list is anchored to a ribbon edge', leftAligned || rightAligned,
            leftAligned ? 'left-aligned' : `right-aligned (panel right ${Math.round(m.panel.right)}, ribbon right ${Math.round(m.ribbon.right)})`);
        r.check('list stays on screen', m.panel.right <= VIEW.width && m.panel.left >= 0,
            `${Math.round(m.panel.left)}–${Math.round(m.panel.right)}`);
        r.check('a ticket row rendered', await page.locator('#olaPanel .olaNum').first().textContent() === 'INC2105486');
        await page.screenshot({ path: path.join(SHOT_DIR, 'dock-expanded.png'), clip: { x: 0, y: 0, width: VIEW.width, height: 320 } });

        // ServiceNow moves its own tabs around (pinning, animation, resize). The
        // ribbon has to follow, or the gap it was placed in stops being free.
        const ribbonLeftBefore = m.ribbon.left;
        await page.evaluate(() => { document.querySelector('[aria-label="History"]').style.left = '470px'; });
        await page.waitForTimeout(400);
        m = await measure(page);
        const movedHit = m.tabs.filter(t => t.width > 0 && overlaps(m.ribbon, t));
        r.check('ribbon still docked after a tab moves', m.status.mode === 'docked', m.status.dock);
        r.check('ribbon overlaps nothing after a tab moves', movedHit.length === 0,
            movedHit.map(t => t.label).join(', ') || 'clear');
        r.check('ribbon actually followed the tab', m.ribbon.left > ribbonLeftBefore,
            `${Math.round(ribbonLeftBefore)} → ${Math.round(m.ribbon.left)}`);
        r.check('ribbon is still after the last tab after the move',
            m.ribbon.left >= Math.max(...m.tabs.filter(t => t.width > 0).map(t => t.right)));

        // Pushed far enough right that no position in the nav is on screen any
        // more, the ribbon has to leave rather than hide off the edge.
        await page.evaluate(() => { document.querySelector('[aria-label="History"]').style.left = '1400px'; });
        await page.waitForTimeout(600);
        const pushed = await page.evaluate(() => {
            const r = document.getElementById('olaRibbon').getBoundingClientRect();
            return { ...window.__olaWatchDebug.panelStatus(), left: r.left, right: r.right };
        });
        r.check('no room in the nav → corner rather than off-screen', pushed.mode === 'corner', pushed.dock);
        r.check('ribbon is back on screen', pushed.right > 0 && pushed.left < VIEW.width,
            `${Math.round(pushed.left)}–${Math.round(pushed.right)}`);

        await page.close();

        // No Polaris nav on the page at all: the ribbon must still be there, in
        // the corner, rather than disappearing with it.
        const bare = await startSnowPage(browser, { script: 'watch', handler });
        await bare.waitForTimeout(1200);
        const bareState = await bare.evaluate(() => {
            const rib = document.getElementById('olaRibbon');
            const r = rib.getBoundingClientRect();
            return { mode: window.__olaWatchDebug.panelStatus().mode, visible: r.width > 20 && r.height > 10, top: r.top, left: r.left };
        });
        r.check('no nav → corner fallback', bareState.mode === 'corner');
        r.check('corner ribbon is still visible', bareState.visible, `at ${Math.round(bareState.left)},${Math.round(bareState.top)}`);
        await bare.close();

        // The real instance nests the header several open shadow roots deep. Two
        // things break there and nowhere else: the document stylesheet does not
        // reach the ribbon (unstyled, no size, rejected by its own verification),
        // and offsetParent returns null across a shadow boundary, so the
        // coordinate origin for the tabs' inline `left` has to come from a tab.
        const shadow = await startSnowPage(browser, { script: 'watch', handler, viewport: VIEW });
        await shadow.evaluate(({ style, header }) => {
            // host > #shadow-root > host > #shadow-root > host > #shadow-root > nav
            let parent = document.body;
            for (let i = 0; i < 3; i++) {
                const host = document.createElement(`sn-layer-${i}`);
                parent.appendChild(host);
                parent = host.attachShadow({ mode: 'open' });
            }
            parent.innerHTML = style + header;
        }, { style: STYLE, header: POLARIS_HEADER });
        await shadow.waitForTimeout(2000);
        const deep = await shadow.evaluate(() => {
            const status = window.__olaWatchDebug.panelStatus();
            // Walk back down to the nav to measure it in its own root.
            let root = document;
            for (let i = 0; i < 3; i++) root = root.querySelector(`sn-layer-${i}`).shadowRoot;
            const host = root.querySelector('.polaris-header-menu');
            const rib = root.getElementById('olaRibbon');
            const box = n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
            return {
                status,
                foundInShadow: !!rib,
                ribbonParentIsNav: !!rib && rib.parentElement === host,
                ribbon: rib ? box(rib) : null,
                tabs: [...host.querySelectorAll('.sn-polaris-tab')].filter(t => t.id !== 'olaRibbon').map(t => ({ label: t.getAttribute('aria-label'), ...box(t) }))
            };
        });
        r.check('docks through nested shadow roots', deep.status.mode === 'docked', deep.status.dock);
        r.check('ribbon is inside the shadow nav', deep.foundInShadow && deep.ribbonParentIsNav);
        r.check('ribbon is styled inside the shadow root',
            !!deep.ribbon && deep.ribbon.height >= 20 && deep.ribbon.width > 40,
            deep.ribbon ? `${Math.round(deep.ribbon.width)}x${Math.round(deep.ribbon.height)}` : 'no rect');
        const deepHit = deep.tabs.filter(t => t.width > 0 && overlaps(deep.ribbon, t));
        r.check('no overlap inside the shadow root', deepHit.length === 0, deepHit.map(t => t.label).join(', ') || 'clear of all 4');
        r.check('placed after the last shadow tab',
            deep.ribbon.left >= Math.max(...deep.tabs.filter(t => t.width > 0).map(t => t.right)),
            `${Math.round(deep.ribbon.left)}`);
        r.check('lines up with the shadow tab row',
            Math.abs(deep.ribbon.top - deep.tabs.find(t => t.label === 'Favorites').top) <= 1);
        await shadow.screenshot({ path: path.join(SHOT_DIR, 'dock-shadow.png'), clip: { x: 0, y: 0, width: VIEW.width, height: 60 } });
        await shadow.close();

        // A nav that exists but can't hold the ribbon (zero-size container) must
        // be rejected by verification rather than leaving an invisible ribbon.
        const hidden = await startSnowPage(browser, {
            script: 'watch', handler,
            body: `<div role="menu" class="sn-polaris-navigation polaris-header-menu" style="min-width:40px;width:0;height:0;overflow:hidden;position:relative;"></div>`
        });
        await hidden.waitForTimeout(2500);   // dock attempt + 2 retries + fallback
        const hiddenState = await hidden.evaluate(() => window.__olaWatchDebug.panelStatus());
        r.check('unusable nav falls back to the corner', hiddenState.mode === 'corner', hiddenState.dock);
        r.check('fallback says why', /fallback/.test(hiddenState.dock), hiddenState.dock);
        await hidden.close();

        // And the pure-logic checks, which include the placement arithmetic.
        const selfTest = await (await startSnowPage(browser, { script: 'watch', handler }))
            .evaluate(() => window.__olaWatchDebug.selfTest());
        r.check('userscript selfTest passes', selfTest.ok, (selfTest.fails || []).join(', '));
    } finally {
        await browser.close();
    }

    console.log(`  screenshots: ${SHOT_DIR}`);
    return r.report();
}

if (require.main === module) run().then(f => process.exit(f ? 1 : 0));
module.exports = { run };
