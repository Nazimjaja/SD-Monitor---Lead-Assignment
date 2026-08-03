'use strict';
// Covers the acknowledge path — the most fragile part of this script, because it
// drives a real ServiceNow form in a frame rather than calling an API.
//
// Each scenario is a stand-in incident form that behaves the way some instance
// really does: submitting and navigating, saving over AJAX without navigating,
// rendering its button late, opening a confirmation dialog, or refusing to save.
// The two that cannot succeed must fail *fast and specifically*; before 0.14 they
// both sat for 15s and reported the same "timed out" message.

const { loadPlaywright, json, html, ticketRecord, startSnowPage, createResults } = require('./harness');

const FIELDS = `
  <select id="incident.impact">
    <option value=""></option><option value="1">1 - High</option>
    <option value="2">2 - Medium</option><option value="3">3 - Low</option>
  </select>
  <textarea id="activity-stream-work_notes-textarea"></textarea>`;

const FORMS = {
    navigates: impact => `<html><body>${FIELDS}
      <button class="form_action_button">Acknowledge</button>
      <script>
        document.getElementById('incident.impact').value = ${JSON.stringify(impact)};
        document.querySelector('button').addEventListener('click', () => {
          location.href = '/incident.do?saved=1&impact=' + encodeURIComponent(document.getElementById('incident.impact').value);
        });
      <\/script></body></html>`,

    silentSave: () => `<html><body>${FIELDS}
      <button class="form_action_button">Acknowledge</button>
      <script>document.querySelector('button').addEventListener('click', () => { fetch('/ack-signal'); });<\/script>
      </body></html>`,

    lateButton: () => `<html><body>${FIELDS}
      <script>
        setTimeout(() => {
          const b = document.createElement('button');
          b.className = 'form_action_button';
          b.textContent = 'Acknowledge';
          b.addEventListener('click', () => { location.href = '/incident.do?saved=1&impact=late'; });
          document.body.appendChild(b);
        }, 2500);
      <\/script></body></html>`,

    // position:fixed on purpose — it is what a real modal uses, and it is why the
    // visibility check cannot be offsetParent (null for fixed elements).
    dialog: () => `<html><body>${FIELDS}
      <button class="form_action_button">Acknowledge</button>
      <script>
        document.querySelector('button').addEventListener('click', () => {
          const d = document.createElement('div');
          d.className = 'modal';
          d.style.cssText = 'display:block;position:fixed;top:0;left:0;width:400px;height:200px;background:#fff';
          d.textContent = 'Confirm update: are you sure you want to update this incident?';
          document.body.appendChild(d);
        });
      <\/script></body></html>`,

    refuses: () => `<html><body>${FIELDS}
      <button class="form_action_button">Acknowledge</button>
      <script>
        document.querySelector('button').addEventListener('click', () => {
          const e = document.createElement('div');
          e.className = 'outputmsg_error';
          e.textContent = 'The following mandatory fields are not filled in: Category';
          document.body.appendChild(e);
        });
      <\/script></body></html>`
};

// Returns { acked, seconds, submittedImpact, message }.
async function attempt(browser, form, { impact = '' } = {}) {
    let submittedImpact = null;
    let substate = '0'; // CONFIG.NOT_ACKED_SUBSTATE.incident

    const page = await startSnowPage(browser, {
        handler: url => {
            if (url.pathname === '/ack-signal') { substate = '2'; return html('ok'); }
            if (url.pathname === '/incident.do') {
                if (url.searchParams.get('saved')) {
                    submittedImpact = url.searchParams.get('impact');
                    substate = '2';
                    return html('<html><body>saved</body></html>');
                }
                return html(FORMS[form](impact));
            }
            if (/^\/api\/now\/table\//.test(url.pathname)) {
                return json({ result: { assigned_to: { value: 'USER123' }, u_substate: substate } });
            }
            if (/_list\.do$/.test(url.pathname)) {
                const table = url.pathname.slice(1).replace('_list.do', '');
                return json({ records: table === 'incident' ? [ticketRecord({ short_description: 'ack flow' })] : [] });
            }
            return null;
        }
    });

    await page.waitForSelector('.sdmPopup .sdmAckBtn', { timeout: 10000 });
    const started = Date.now();
    await page.click('.sdmPopup .sdmAckBtn');

    let acked = false;
    let message = '';
    try {
        await page.waitForFunction(() => {
            const err = document.querySelector('.sdmPopup .sdmError');
            if (err && err.style.display !== 'none' && err.textContent.trim()) throw new Error('rejected');
            return !!document.querySelector('.sdmPopup.sdmAcked');
        }, null, { timeout: 40000, polling: 200 });
        acked = true;
    } catch {
        message = ((await page.locator('.sdmError').textContent().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
    }
    const seconds = (Date.now() - started) / 1000;
    await page.close();
    return { acked, seconds, submittedImpact, message };
}

async function run() {
    const { chromium } = loadPlaywright();
    const r = createResults('acknowledge');
    const browser = await chromium.launch();

    // Impact is only ever filled when blank. Overwriting it re-derives Priority from
    // Impact x Urgency, which silently re-prioritises the incident and moves its SLA.
    const kept = await attempt(browser, 'navigates', { impact: '1' });
    r.check('an existing Impact is never overwritten', kept.acked && kept.submittedImpact === '1',
        `submitted impact=${JSON.stringify(kept.submittedImpact)}`);

    const filled = await attempt(browser, 'navigates', { impact: '' });
    r.check('a blank Impact is filled so the button unblocks', filled.acked && filled.submittedImpact === '3',
        `submitted impact=${JSON.stringify(filled.submittedImpact)}`);

    const silent = await attempt(browser, 'silentSave');
    r.check('a save without a navigation still counts', silent.acked, `${silent.seconds.toFixed(1)}s`);

    const late = await attempt(browser, 'lateButton');
    r.check('a button that renders late is waited for', late.acked, `${late.seconds.toFixed(1)}s`);

    const dialog = await attempt(browser, 'dialog');
    r.check('a blocking dialog is reported, not timed out',
        !dialog.acked && /dialog/i.test(dialog.message) && dialog.seconds < 10,
        `${dialog.seconds.toFixed(1)}s — ${dialog.message.slice(0, 90)}`);

    const refused = await attempt(browser, 'refuses');
    r.check('a refusal quotes the form back',
        !refused.acked && /mandatory/i.test(refused.message) && refused.seconds < 10,
        `${refused.seconds.toFixed(1)}s — ${refused.message.slice(0, 90)}`);

    await browser.close();
    return r.report();
}

module.exports = { run };
if (require.main === module) run().then(f => process.exit(f ? 1 : 0));
