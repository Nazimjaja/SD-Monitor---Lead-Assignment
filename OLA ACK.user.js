// ==UserScript==
// @name         SD Monitor - Live Acknowledge Popup
// @namespace    geodis-sd-monitor
// @version      0.19
// @description  Cross-site synced live alert for unacknowledged tickets; full function on ServiceNow, mirrored popups elsewhere
// @homepageURL  https://github.com/Nazimjaja/SD-Monitor---Lead-Assignment
// @updateURL    https://raw.githubusercontent.com/Nazimjaja/SD-Monitor---Lead-Assignment/main/OLA%20ACK.user.js
// @downloadURL  https://raw.githubusercontent.com/Nazimjaja/SD-Monitor---Lead-Assignment/main/OLA%20ACK.user.js
// @changelog    0.19 - The red rail down the left edge of the popup is gone — it fought with
//                     the countdown bar for the same job and only made the card look
//                     lopsided. Urgency is still carried by the clock, the bottom bar and
//                     the breathing glow.
//                     The card is real glass now: a translucent fill over a wide backdrop
//                     blur, with a diagonal sheen across the top-left. Because a blur does
//                     nothing over a white page, the card never leans on it for its edges —
//                     the hairline border, the sheen and the layered shadow are what keep it
//                     legible on a plain white background. Browsers without backdrop-filter
//                     fall back to the old solid surface.
// @changelog    0.18 - The Acknowledge button is green rather than near-black. On a card whose
//                     accent is the red of a running deadline, a dark neutral button read as
//                     chrome; green makes the two colours mean different things — the clock
//                     pressing, and the way out of it. A deeper emerald than the obvious one,
//                     so the white label stays legible at 11.5px.
// @changelog    0.17 - Dark mode is gone: the popup is light on every page, whatever the OS
//                     theme says, and pins color-scheme so no browser dark styling leaks
//                     into its controls.
//                     Fixed the popup coming out larger on some pages than others. Every
//                     dimension here is a fixed pixel value, but a host page that scales its
//                     own content — a zoom or a transform on an ancestor, which some
//                     ServiceNow form views apply — scales our fixed-position card with it.
//                     A probe of known width is measured once per page and the popups are
//                     given the inverse, so the card is the same size on a ticket form as on
//                     a list. Browser zoom deliberately does not trigger this: it scales the
//                     viewport too, so the popup keeps matching the rest of the page, which
//                     is what someone zooming wants. __ackMonitorDebug.pageScale() reports
//                     what a page is doing and what the card actually measures.
// @changelog    0.16 - Popup redesigned again, to the compact layout with the countdown as
//                     the card's bottom edge. It loses a whole line by putting the clock on
//                     the header row beside the ticket number, and the remaining time reads
//                     off the draining edge instead of a row of its own — smaller than the
//                     previous card while carrying the same information.
//                     The flat surface is gone. Depth is built from layers rather than one
//                     blur: a near-opaque gradient surface, a hairline border, an inset top
//                     highlight, and a shadow in three steps from contact to ambient, over a
//                     light backdrop blur — depth against a ServiceNow list rather than
//                     frosted glass over it. The accent rail is inset, rounded and lit; the
//                     priority chip is a gradient with its own highlight; buttons have a
//                     press state and a spinner while an acknowledge is in flight, which can
//                     take seconds. Popups slide in, lift on hover and animate out instead of
//                     disappearing mid-blink, and under 30 seconds the whole card breathes
//                     and the edge sweeps — peripheral vision reads a change in the object
//                     long before it reads four characters. All of it is disabled for anyone
//                     who has asked their system for reduced motion.
// @changelog    0.15 - The alert sound is fixed and the popup redesigned.
//                     Sound: an AudioContext built before the tab has seen a click is born
//                     suspended, and scheduling notes on a suspended context does nothing,
//                     silently. That context was cached forever and resume() was never
//                     called, so the first alert after a page load — exactly the case where
//                     nobody has clicked yet, because the agent is looking at another
//                     window — turned the sound off for the whole session. The first user
//                     gesture anywhere on the page now resumes it, and every alert resumes
//                     before playing rather than scheduling into a sleeping context.
//                     __ackMonitorDebug.testSound() reports whether the browser is allowing
//                     audio at all.
//                     Popup: rebuilt on one surface, one type scale and one accent. The
//                     heavy translucency is gone — it was what made the popup read
//                     differently on every background it landed on. Priority now has its own
//                     chip, the description gets two lines instead of being crushed onto the
//                     meta line, the countdown uses tabular figures so it stops jittering
//                     every second, and a progress bar drains alongside it. Emoji are out.
//                     A ghost "Open" button reaches the ticket without acknowledging it
//                     first. Dark mode is honoured for the tabs this mirrors onto.
// @changelog    0.14 - Acknowledging no longer dead-ends in "Timed out waiting for the
//                     Acknowledge button/confirmation". Two changes. The frame the ticket
//                     form loads in was 1px by 1px at opacity 0: that lays the form out at
//                     1px wide and makes it exactly the kind of zero-area frame Chrome
//                     throttles timers in, while ServiceNow's submit path runs on timers —
//                     so the click landed and then nothing happened until the timeout. It is
//                     now a normal 1200x900 frame parked off-screen. And success is no longer
//                     inferred solely from the frame reloading: the record's own u_substate
//                     is polled, so a save that lands without a navigation still counts.
//                     Failures now say which thing went wrong rather than sharing one
//                     message — a confirmation dialog waiting on a human, the form refusing
//                     to save (quoting it), a button that never appeared, or one that stayed
//                     disabled — and the button is waited for rather than checked once at
//                     800ms, which called a slow form a missing button.
//                     __ackMonitorDebug.ackDebug() replays the whole thing with the frame
//                     on screen and a step trace in the console.
// @changelog    0.13 - The status pill now carries the running version, read from the script's
//                     own metadata rather than typed in, so it can't drift from @version. Two
//                     reasons it earns its place now that the script auto-updates from GitHub:
//                     it's the visible confirmation that an update actually landed, and a tab
//                     opened before an update keeps running the old code until it reloads, so
//                     "which version is this tab on" stops being answerable from memory.
// @changelog    0.12 - Acknowledging an incident no longer overwrites an Impact somebody had
//                     already set. The mandatory-field step filled Impact whenever it wasn't
//                     already 3-Low, but clicking Acknowledge submits the whole form, so that
//                     value was saved — and since ServiceNow derives Priority from Impact ×
//                     Urgency, acknowledging an incident raised as 1-High silently dropped it
//                     to Low and moved its SLA target with it. It now fills Impact only when
//                     the field is genuinely empty, which is the case the step exists for, and
//                     the value it uses in that case is CONFIG.ACK_FALLBACK_IMPACT.
// @changelog    0.11 - Authentication fix, the same one the assignment dashboard took in its 0.5:
//                     the browser no longer prompts for credentials. Requests ride the SSO session
//                     cookies as before, but they now also carry the session token (g_ck) that
//                     ServiceNow requires alongside the cookie — the poll sent none at all and the
//                     assign PATCH sent `g_ck || ''`, and SNOW answers a failed token check with
//                     401 + WWW-Authenticate: BASIC, which is what raised the browser's native
//                     login box. The token is read from every place g_ck lives (UI16 global, Next
//                     Experience, sysparm_ck field) and scraped from a page as a last resort,
//                     rather than degrading to ''. An expired session is now recognised — both the
//                     401 and the SSO redirect to a login page, which used to arrive as a 200 full
//                     of HTML and surface as a JSON parse error — and the tab stands down from
//                     polling instead of re-provoking the prompt every 15s, showing a Reconnect
//                     button on the status pill instead. A tab in that state declines its turn
//                     without staking the poll claim, so healthy tabs still poll for everyone.
//                     Script now carries its GitHub @updateURL, so Tampermonkey can self-update.
// @changelog    0.10 - Polling is now shared across SNOW tabs instead of every open SNOW
//                     tab polling independently (N tabs = N× the API load). Rather than
//                     electing a leader, GM storage tracks when the last poll happened and
//                     any tab volunteers once one is overdue — so a hard-killed tab costs
//                     at most one normal poll interval, with no lease to expire first.
//                     Hidden tabs defer briefly so a visible tab takes the round when one
//                     exists (background timer throttling makes hidden tabs poor pollers),
//                     but polling itself is never gated on visibility — a hidden tab must
//                     keep alerting. Poll teardown now reconciles against persisted state
//                     so a handoff between tabs can't strand stale popups. Documented the
//                     two platform constraints behind the iframe-based acknowledge and the
//                     GM-storage sync.
// @changelog    0.9 - Correctness pass. Removed a duplicate EXTRA_FILTER key that silently
//                     shadowed the first. Bounded the processed-event id set so long-lived
//                     tabs stop growing it forever. Countdown now stops at zero instead of
//                     ticking into negative numbers, and is derived from the ticket's first
//                     alert time so every tab agrees on time remaining (a tab opened mid-alert
//                     no longer restarts at 02:00). Ack-request claims carry a timestamp and
//                     go stale after 30s, so a tab that dies mid-ack no longer leaves the
//                     request permanently unfulfillable. Popups are built with textContent
//                     instead of innerHTML templates, so ticket text can never be parsed as
//                     HTML on any of the domains this runs on.
// @changelog    0.8 - Hardened every visual CSS property (border, border-radius, background,
//                     box-shadow, padding, cursor, etc.) with !important across the popup, buttons,
//                     and status indicator, plus a scoped box-sizing: border-box reset for our own
//                     elements. Fixes popups losing their rounded corners/styling on tabs/views
//                     (e.g. SNOW Next Experience list views) whose own base element CSS ships
//                     !important rules that were winning the specificity fight.
// @changelog    0.7 - Switched CSS injection from a manual <style> element to GM_addStyle so
//                     styling isn't dropped by a host page's Content-Security-Policy (style-src
//                     without 'unsafe-inline').
// @changelog    0.6 - Fixed a race where a poll cycle could tear down a popup mid-acknowledge
//                     (before the ack confirmation arrived), silently dropping the "Open Ticket"
//                     popup until a page reload. transformToAcked now rebuilds the popup shell if
//                     needed, and in-flight acks are shielded from poll-driven cleanup.
// @match        *://*/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // Sandboxed mode (triggered by non-"none" @grant) isolates `window` from the
    // real page — SNOW's own globals (NOW, g_ck, g_user_id) live on the real page,
    // so we reach them through unsafeWindow instead.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // A page counts as "the real thing" only if it's actually a ServiceNow instance.
    // Everywhere else, the script only mirrors popups and relays ack requests back here.
    const IS_SNOW_HOST = /\.service-now\.com$/i.test(location.hostname);

    // Read back from the installed script's own metadata rather than being typed
    // here, so it can't drift from @version the way a hand-maintained copy would.
    // Shown on the status pill: with the script auto-updating from GitHub, "which
    // version is this tab actually running" stops being answerable by memory —
    // tabs opened before an update keep running the old code until they reload.
    const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info?.script?.version) || '?';
    console.log(`[ACK Monitor] v${SCRIPT_VERSION} loaded on ${location.hostname} — mode: ${IS_SNOW_HOST ? 'SNOW (full)' : 'mirror-only'}`);

    // ─── CONFIG ─────────────────────────────────────────────────────────────
    const CONFIG = {
        TABLES: ['sc_task', 'incident'],
        // "Not Acknowledged" value per table — confirmed 1 for sc_task via a clean
        // live diff, and confirmed 0 for incident directly from its substate dropdown.
        NOT_ACKED_SUBSTATE: { sc_task: '1', incident: '0' },
        // Extra query conditions appended per table (encoded query syntax) — incident's
        // state=7 is Closed; a closed incident can apparently still read u_substate=0,
        // so exclude it explicitly.
        EXTRA_FILTER: { incident: 'stateNOT IN7' },
        // Impact written to an incident that has none, purely to clear the mandatory
        // field blocking its Acknowledge button. Only ever applied to a blank Impact —
        // an Impact somebody has already judged is never overwritten. 3 = Low, i.e.
        // the least presumptuous value; whoever works the ticket can raise it.
        ACK_FALLBACK_IMPACT: '3',
        // How long the whole acknowledge attempt may take, how long to keep looking
        // for the Acknowledge button while the form finishes rendering, and how often
        // to ask the server whether the acknowledge has landed. The first is generous
        // because a real ServiceNow form on a loaded instance is not quick.
        ACK_TIMEOUT_MS: 25000,
        ACK_BUTTON_WAIT_MS: 8000,
        ACK_WATCH_MS: 1200,
        POLL_MS: 15000,
        COUNTDOWN_SECONDS: 120,
        ACKED_LIFETIME_MS: 5 * 60 * 1000,
        ACK_REQUEST_TIMEOUT_MS: 12000, // how long a mirror tab waits for a SNOW tab to respond
        CLAIM_STALE_MS: 30000, // a claim older than this is assumed abandoned and reclaimable
        // How often each SNOW tab checks whether a poll is overdue. Cheap (a local
        // storage read), and it bounds how fast a surviving tab picks up polling after
        // another tab dies — so keep it well under POLL_MS.
        POLL_TICK_MS: 3000,
        // How long a hidden tab defers before volunteering to poll, letting a visible
        // tab take the round when one exists. Long enough to actually yield, short
        // enough that all-hidden tabs barely delay the poll.
        HIDDEN_TAB_GRACE_MS: 4000,
        POPUP_WIDTH: 300,
        POPUP_GAP: 10,
        SOUND_ENABLED: true
    };

    // ─── SESSION / AUTHENTICATION (SNOW pages only) ─────────────────────────
    // Everything here rides the browser's existing SSO session — we never ask for
    // credentials and never send an Authorization header. But a session cookie on its
    // own is NOT enough: ServiceNow rejects a session-authenticated API call that
    // arrives without the session token (g_ck) in X-UserToken, and it answers that
    // rejection with "401 + WWW-Authenticate: BASIC". That header is what makes the
    // browser throw up its native username/password dialog — a box no SSO login can
    // ever satisfy. So a missing token doesn't fail quietly, it pops a credential
    // prompt, and a poll on a timer re-provokes it every cycle forever.
    //
    // Two rules follow, and every request below obeys them:
    //   1. Always send a real token. Never send an empty one — SNOW treats
    //      X-UserToken: '' as a *failed* token check, which is worse than anonymous.
    //      (`g_ck || ''` was exactly that, and was the bug.)
    //   2. On the first genuine auth failure, stand down. One dialog is a bug report;
    //      one dialog every POLL_MS is unusable.
    class SessionError extends Error {
        constructor(message) { super(message); this.name = 'SessionError'; }
    }

    let sessionToken = null;
    let sessionTokenPromise = null;
    let sessionBroken = false;

    // Where g_ck lives depends on which UI you're on: a global in UI16, hung off the
    // NOW namespace in Next Experience, and in a hidden form field on plain .do pages.
    // Checking all of them is why this no longer silently degrades to an empty token.
    function tokenFromPageWindow() {
        const w = pageWindow;
        const field = document.querySelector('input[name="sysparm_ck"]');
        const candidates = [
            w.g_ck,
            w.NOW && w.NOW.g_ck,
            w.NOW && w.NOW.session && w.NOW.session.token,
            w.g_sysparm_ck,
            field && field.value
        ];
        return candidates.find(v => typeof v === 'string' && v.length >= 32) || null;
    }

    // Fallback for UIs that expose g_ck nowhere reachable: scrape it out of a page
    // fetched with the session cookies. Deliberately a bare fetch — it must not route
    // through snFetch, which would need a token to run and recurse.
    async function tokenFromBlankPage() {
        const r = await fetch('/blank.do', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return null;
        const text = await r.text();
        const m = /(?:var\s+g_ck\s*=|["']g_ck["']\s*:)\s*["']([^"']{32,})["']/.exec(text);
        return m ? m[1] : null;
    }

    async function getSessionToken(forceRefresh = false) {
        // A mirror tab has no SNOW session and no /blank.do to scrape — it relays ack
        // requests to a SNOW tab instead, so there is nothing to fetch here.
        if (!IS_SNOW_HOST) return null;
        if (sessionToken && !forceRefresh) return sessionToken;
        const direct = tokenFromPageWindow();
        if (direct) { sessionToken = direct; return sessionToken; }
        if (!sessionTokenPromise) {
            sessionTokenPromise = tokenFromBlankPage()
                .catch(() => null)
                .then(t => { sessionToken = t; return t; })
                .finally(() => { sessionTokenPromise = null; });
        }
        return sessionTokenPromise;
    }

    // A dead SSO session usually arrives as a redirect to the IdP rather than a 401,
    // which means a 200 carrying HTML. Without this the response reaches r.json() and
    // surfaces as an unexplained "Unexpected token <" instead of "sign in again".
    function looksLikeLoginPage(text) {
        return /<form[^>]+login\.do/i.test(text)
            || /name=["']sysparm_login/i.test(text)
            || /SAMLRequest/i.test(text)
            || /<title>[^<]*(sign in|log ?in)/i.test(text);
    }

    function markSessionBroken(reason) {
        if (sessionBroken) return;
        sessionBroken = true;
        sessionToken = null;
        // No interval to clear: polling is the shared cross-tab tick, and pollCycle
        // checks sessionBroken before volunteering. Standing down there rather than
        // here is deliberate — this tab declines the round *without* staking the
        // claim, so a healthy tab still takes it and everyone keeps getting alerts.
        showSessionBanner(reason);
    }

    // Single funnel for every ServiceNow call, so the cookie/token/redirect handling
    // can't drift apart between the read and write paths.
    async function snFetch(path, { method = 'GET', body = null, headers = {} } = {}) {
        if (sessionBroken) {
            throw new SessionError('Paused — the ServiceNow session needs re-authenticating.');
        }

        const send = token => {
            const h = Object.assign({
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                // Ask SNOW to answer an expired session with a 401 body instead of
                // 302-ing us into the SSO login flow. Following that redirect chain is
                // both how we ended up parsing HTML as JSON and an extra opportunity
                // for an auth challenge to reach the browser.
                'X-No-Response-Redirect': 'true'
            }, headers);
            if (token) h['X-UserToken'] = token; // rule 1: never an empty token
            return fetch(path, {
                method,
                headers: h,
                body,
                // The SSO session cookies are the entire authentication story here.
                // fetch() already defaults to same-origin, but state it so nobody
                // "tidies" this into a credential-less request later.
                credentials: 'same-origin',
                cache: 'no-store',
                redirect: 'follow'
            });
        };

        const token = await getSessionToken();
        let r = await send(token);

        // A rejected token is recoverable — the page may have been open across a
        // session renewal — so re-read g_ck and retry exactly once. A second failure
        // means the session itself is gone, and retrying on a timer from there is what
        // produced a credential dialog every few seconds.
        if (r.status === 401 || r.status === 403) {
            const fresh = await getSessionToken(true);
            if (fresh && fresh !== token) r = await send(fresh);
        }
        if (r.status === 401 || r.status === 403 || r.headers.get('X-Is-Logged-In') === 'false') {
            markSessionBroken(`ServiceNow rejected the request (HTTP ${r.status}).`);
            throw new SessionError('Not signed in to ServiceNow, or the session token is no longer valid.');
        }

        if (r.ok && !/json/i.test(r.headers.get('content-type') || '')) {
            const text = await r.text();
            if (looksLikeLoginPage(text)) {
                markSessionBroken('ServiceNow answered with a sign-in page.');
                throw new SessionError('The ServiceNow session has expired — SSO returned its login page.');
            }
            throw new Error(`Expected JSON from ${path}, got ${r.headers.get('content-type') || 'no content-type'}.`);
        }
        return r;
    }

    // ─── SNOW HELPERS (only meaningfully used when IS_SNOW_HOST) ───────────
    function getMyId()      { return pageWindow.NOW?.user?.userID || pageWindow.g_user_id || ''; }
    function getMyName()    { return pageWindow.NOW?.user?.fullName || pageWindow.g_user_name || 'You'; }

    async function jFetch(table, query, limit = 20) {
        const r = await snFetch(`/${table}_list.do?JSONv2&sysparm_action=getRecords&sysparm_query=${query}&sysparm_limit=${limit}`);
        if (!r.ok) throw new Error(`${table}: HTTP ${r.status}`);
        return (await r.json()).records || [];
    }

    async function assignRecord(table, sysId, userId) {
        const r = await snFetch(`/api/now/table/${table}/${sysId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assigned_to: userId })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 120)}`);
        return r.json();
    }

    function findAckButton(doc) {
        return Array.from(doc.querySelectorAll('button.form_action_button'))
            .find(b => b.textContent.trim() === 'Acknowledge');
    }

    // Incident's Acknowledge button is blocked by client-side validation until
    // Impact is set and a Work Notes comment is entered. We set both and fire the
    // same events the page's own handlers listen for (change/input/blur), so its
    // validation state actually clears instead of just looking filled in the DOM.
    function fillMandatoryAckFields(doc, table) {
        if (table !== 'incident') return;

        // Only fill Impact when the ticket genuinely has none. Clicking Acknowledge
        // submits the whole form, so anything we change here is *saved* — and because
        // ServiceNow derives Priority from Impact × Urgency, overwriting a real Impact
        // would silently re-prioritise the incident. Acknowledging a P1 raised as
        // 1-High would have quietly dropped it to Low and moved its SLA target. An
        // unset choice comes through as the empty option, so an empty value is the
        // only safe signal that nobody has judged this ticket's impact yet.
        const impactSelect = doc.getElementById('incident.impact');
        if (impactSelect && !String(impactSelect.value || '').trim()) {
            impactSelect.value = CONFIG.ACK_FALLBACK_IMPACT;
            impactSelect.dispatchEvent(new Event('change', { bubbles: true }));
            impactSelect.dispatchEvent(new Event('input', { bubbles: true }));
            console.log(`[ACK Monitor] incident had no Impact — set ${CONFIG.ACK_FALLBACK_IMPACT} to satisfy the mandatory field.`);
        }

        const workNotes = doc.getElementById('activity-stream-work_notes-textarea');
        if (workNotes && !workNotes.value.trim()) {
            workNotes.value = 'Acknowledged';
            workNotes.dispatchEvent(new Event('input', { bubbles: true }));
            workNotes.dispatchEvent(new Event('change', { bubbles: true }));
            workNotes.dispatchEvent(new Event('blur', { bubbles: true }));
        }
    }

    // WHY AN IFRAME AND NOT A REST CALL: acknowledging means flipping u_substate,
    // and that field is protected by ServiceNow field-level ACLs — a direct PATCH
    // to it is rejected no matter how the request is authenticated. The only route
    // that works is the one a human takes: load the ticket form and click the real
    // Acknowledge button, letting SNOW's own server-side logic do the write.
    // (assignRecord's PATCH to assigned_to above is a *different* field and is
    // permitted, which is why that half can stay a clean API call.)
    // Do not "simplify" this into a single PATCH — it will fail silently in prod.
    //
    // Success used to be defined as "the frame fired a second load event", i.e. the
    // form submitted and reloaded. That signal is real but it is not the only way an
    // acknowledge can land, and — worse — its absence covers several different
    // failures that all surfaced as one unhelpful "timed out" message. So the outcome
    // is now decided by evidence: the record itself is the authority, and the form is
    // inspected for the two things that legitimately stop a save.
    function textOf(el) {
        return ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
    }

    // Deliberately getClientRects() and not offsetParent: offsetParent is null for
    // any position:fixed element, which is precisely what a modal dialog is — so the
    // obvious check would have been blind to the exact thing it is looking for.
    function isRendered(el) {
        return !!el && typeof el.getClientRects === 'function' && el.getClientRects().length > 0;
    }

    // A ServiceNow confirmation dialog (GlideModal/GlideDialogWindow) renders inside
    // the same document and waits for a human. In a frame nobody can see, that wait
    // never ends. Worth checking explicitly: this instance registers a
    // ShowConfirmUpdateDialog onLoad script, so it is a live possibility here.
    function findBlockingDialog(doc) {
        const sel = '.modal, [role="dialog"], #dialog_container, .dialog_body';
        return Array.from(doc.querySelectorAll(sel))
            .find(el => isRendered(el) && textOf(el)) || null;
    }

    // Whatever the form puts up when it refuses to save — a mandatory field it still
    // wants, an ACL rejection, a client script's own complaint.
    function formErrors(doc) {
        const sel = '#output_messages .outputmsg_error, .outputmsg_error, .notification-error, .alert-danger, .form_field_error';
        return Array.from(doc.querySelectorAll(sel))
            .filter(isRendered)
            .map(textOf).filter(Boolean).slice(0, 3);
    }

    // The one answer the form's DOM cannot fake. u_substate is read-only to us but
    // perfectly readable, so "did this actually get acknowledged" is a question we
    // can just ask, instead of inferring it from frame lifecycle events.
    async function isAckedOnServer(table, sysId) {
        const notAcked = CONFIG.NOT_ACKED_SUBSTATE[table] ?? '1';
        try {
            const r = await snFetch(`/api/now/table/${table}/${sysId}?sysparm_fields=u_substate`);
            if (!r.ok) return false;
            const v = (await r.json())?.result?.u_substate;
            return v !== undefined && v !== null && String(v) !== String(notAcked);
        } catch {
            return false; // a read failure is not evidence either way; keep waiting
        }
    }

    function acknowledgeViaHiddenIframe(table, sysId, { timeoutMs = CONFIG.ACK_TIMEOUT_MS, visible = false } = {}) {
        return new Promise((resolve, reject) => {
            const trace = [];
            const note = msg => { trace.push(msg); console.log(`[ACK Monitor] ack ${sysId}: ${msg}`); };

            const iframe = document.createElement('iframe');
            // A real viewport parked off-screen, rather than the 1px opacity:0 frame
            // this used to use. A zero-area frame lays the form out at 1px wide and is
            // a prime candidate for Chrome's hidden-frame timer throttling — and
            // ServiceNow's submit path runs on timers, so the click would land and then
            // nothing would happen until our own timeout fired.
            iframe.style.cssText = visible
                ? 'position:fixed;right:12px;bottom:12px;width:min(560px,90vw);height:70vh;z-index:1000000;border:2px solid #b3261e;border-radius:8px;background:#fff;box-shadow:0 8px 32px rgba(0,0,0,0.3);'
                : 'position:fixed;left:-20000px;top:0;width:1200px;height:900px;border:0;pointer-events:none;';
            iframe.src = `/${table}.do?sys_id=${sysId}&sysparm_stack=no`;

            let settled = false;
            let clicked = false;
            let watcher = null;

            function finish(fn, arg) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                clearInterval(watcher);
                // A frame opened for debugging stays long enough to be read.
                setTimeout(() => iframe.remove(), visible ? 30000 : 500);
                fn(arg);
            }

            function safeDoc() {
                try { return iframe.contentDocument; } catch { return null; }
            }

            const timer = setTimeout(async () => {
                if (settled) return;
                // A slow save that lands just after the deadline is a success we would
                // otherwise throw away — and report as a failure on a ticket that is
                // now acknowledged.
                if (await isAckedOnServer(table, sysId)) {
                    note('server confirms acknowledged (arrived late)');
                    finish(resolve, true);
                    return;
                }
                const doc = safeDoc();
                const dialog = doc && findBlockingDialog(doc);
                const errors = doc ? formErrors(doc) : [];
                let why;
                if (dialog) {
                    why = `the form is waiting on a dialog ("${textOf(dialog).slice(0, 120)}") that needs a human answer`;
                } else if (errors.length) {
                    why = `the form refused to save — ${errors.join(' | ').slice(0, 200)}`;
                } else if (!clicked) {
                    why = 'the Acknowledge button never became clickable';
                } else {
                    why = 'the Acknowledge button was clicked but the ticket never changed state';
                }
                finish(reject, new Error(`${why}. Steps: ${trace.join(' → ') || 'none'}. Run __ackMonitorDebug.ackDebug() to watch it happen.`));
            }, timeoutMs);

            // The form finishes rendering in stages — UI policies, late-loading
            // includes, batched AJAX that returns after "page loaded". A single check
            // at a fixed 800ms called a merely slow form a missing button, so keep
            // looking until the deadline.
            function waitForButton(doc) {
                const deadline = Date.now() + CONFIG.ACK_BUTTON_WAIT_MS;
                const tick = () => {
                    if (settled) return;
                    const btn = findAckButton(doc);
                    if (btn && !btn.disabled) {
                        note('Acknowledge button found — clicking');
                        clicked = true;
                        btn.click();
                        startWatching(doc);
                        return;
                    }
                    if (Date.now() > deadline) {
                        finish(reject, new Error(btn
                            ? 'the Acknowledge button stayed disabled — the form still wants something (Impact / Work notes).'
                            : 'no Acknowledge button on this form — the ticket may already be acknowledged.'));
                        return;
                    }
                    setTimeout(tick, 300);
                };
                setTimeout(tick, 400);
            }

            // After the click there are three possible worlds: it saved (the record
            // changes, with or without a navigation), it is blocked on something a
            // human has to answer, or it was refused. Poll for all three rather than
            // waiting out the timeout to report one generic failure.
            function startWatching(doc) {
                watcher = setInterval(async () => {
                    if (settled) return;
                    if (await isAckedOnServer(table, sysId)) {
                        note('server confirms acknowledged');
                        finish(resolve, true);
                        return;
                    }
                    const dialog = findBlockingDialog(doc);
                    if (dialog) {
                        finish(reject, new Error(`acknowledging opened a dialog that needs a human answer: "${textOf(dialog).slice(0, 160)}"`));
                        return;
                    }
                    const errors = formErrors(doc);
                    if (errors.length) {
                        finish(reject, new Error(`the form refused to save — ${errors.join(' | ').slice(0, 200)}`));
                    }
                }, CONFIG.ACK_WATCH_MS);
            }

            iframe.addEventListener('load', () => {
                if (settled) return;
                const doc = safeDoc();
                if (!doc) { finish(reject, new Error('the ticket form could not be read from the frame.')); return; }

                // The reload after a submit is still the fastest success signal —
                // it just is not the only one any more.
                if (clicked) { note('form reloaded after the click'); finish(resolve, true); return; }

                try {
                    // An expired session serves the SSO login page here instead of the
                    // ticket form. Without this it reads as "Acknowledge button not
                    // found — may already be acknowledged", which sends people looking
                    // at the ticket rather than at their session.
                    if (looksLikeLoginPage(doc.documentElement?.innerHTML || '')) {
                        markSessionBroken('ServiceNow served a sign-in page instead of the ticket form.');
                        finish(reject, new SessionError('The ServiceNow session has expired — sign in again, then Reconnect.'));
                        return;
                    }
                    note('form loaded');
                    fillMandatoryAckFields(doc, table);
                    waitForButton(doc);
                } catch (e) {
                    finish(reject, new Error('Iframe access error: ' + e.message));
                }
            });

            document.body.appendChild(iframe);
        });
    }

    async function acknowledgeTicket(table, sysId, userId, opts = {}) {
        await assignRecord(table, sysId, userId);
        await acknowledgeViaHiddenIframe(table, sysId, opts);
    }

    // ─── CROSS-SITE SYNC (GM storage — shared across every domain the script runs on) ──
    // WHY GM STORAGE AND NOT BroadcastChannel: BroadcastChannel is origin-scoped, so
    // it can only reach tabs on the same domain. The whole point here is syncing a
    // ServiceNow tab with mirror tabs on unrelated domains, so we need Tampermonkey's
    // storage layer — it's the only channel that spans origins.
    //
    // Two layers: a one-shot EVENT stream for instant updates to already-open tabs,
    // and a persisted STATE snapshot so a tab that opens/reloads *after* something
    // happened can catch up to "what's currently active" instead of missing it.
    const EVENT_KEY = 'sdAckMonitor_event';
    const STATE_KEY = 'sdAckMonitor_state';
    // Bounded dedupe log. A Set preserves insertion order, so evicting the oldest
    // entries once we pass the cap keeps a long-lived tab (a full shift's worth of
    // events) from growing this without limit.
    const MAX_PROCESSED_EVENT_IDS = 500;
    const processedEventIds = new Set();

    function markEventProcessed(id) {
        processedEventIds.add(id);
        while (processedEventIds.size > MAX_PROCESSED_EVENT_IDS) {
            processedEventIds.delete(processedEventIds.values().next().value);
        }
    }

    const knownPendingSysIds = new Set(); // tickets THIS tab currently believes are pending
    const inFlightAckSysIds = new Set(); // sys_ids THIS tab is actively acknowledging right now —
                                          // keeps the poll from tearing the popup down mid-flight
                                          // (the server-side state can flip before our own await resolves)

    function getState() {
        try { return JSON.parse(GM_getValue(STATE_KEY, '{}')); } catch { return {}; }
    }

    function setState(state) {
        GM_setValue(STATE_KEY, JSON.stringify(state));
    }

    // Drop acked entries whose 5-minute window has already elapsed, so a tab
    // opened long after the fact doesn't resurrect a stale confirmation.
    function pruneState(state) {
        const now = Date.now();
        Object.keys(state).forEach(sysId => {
            const entry = state[sysId];
            if (entry.status === 'acked' && now - entry.ackedAt > CONFIG.ACKED_LIFETIME_MS) {
                delete state[sysId];
            }
        });
        return state;
    }

    function upsertState(sysId, patch) {
        const state = pruneState(getState());
        state[sysId] = { ...(state[sysId] || {}), ...patch };
        setState(state);
    }

    function deleteState(sysId) {
        const state = pruneState(getState());
        delete state[sysId];
        setState(state);
    }

    function publishEvent(event) {
        event._id = Date.now() + '-' + Math.random().toString(36).slice(2);
        markEventProcessed(event._id); // don't re-process our own broadcast if echoed back
        GM_setValue(EVENT_KEY, JSON.stringify(event));
    }

    // Only relevant when 2+ SNOW tabs are open: both would otherwise race to
    // fulfill the same ACK_REQUEST. GM storage has no real compare-and-swap, so
    // we approximate a lock with a random jitter + a delayed re-check — the tab
    // that actually wrote the claim key wins; the other backs off.
    const TAB_ID = Date.now() + '-' + Math.random().toString(36).slice(2);

    // Claims carry a timestamp so a tab that wins the race and then dies (crash,
    // hung ack, tab closed mid-flight) doesn't leave the request permanently
    // unfulfillable — after CLAIM_STALE_MS another tab may take it over.
    function readClaim(claimKey) {
        const raw = GM_getValue(claimKey, '');
        if (!raw) return null;
        try {
            const claim = JSON.parse(raw);
            if (!claim || !claim.tabId) return null;
            if (Date.now() - claim.ts > CONFIG.CLAIM_STALE_MS) return null; // stale — up for grabs
            return claim;
        } catch { return null; }
    }

    function claimAckRequest(requestId) {
        return new Promise(resolve => {
            const claimKey = `sdAckMonitor_claim_${requestId}`;
            setTimeout(() => {
                const existing = readClaim(claimKey);
                if (existing) { resolve(existing.tabId === TAB_ID); return; }
                GM_setValue(claimKey, JSON.stringify({ tabId: TAB_ID, ts: Date.now() }));
                setTimeout(() => {
                    const winner = readClaim(claimKey);
                    resolve(!!winner && winner.tabId === TAB_ID);
                }, 150);
            }, Math.floor(Math.random() * 250));
        });
    }

    GM_addValueChangeListener(EVENT_KEY, (name, oldValue, newValue) => {
        if (!newValue) return;
        let event;
        try { event = JSON.parse(newValue); } catch { return; }
        if (!event || processedEventIds.has(event._id)) return;
        markEventProcessed(event._id);
        handleEvent(event);
    });

    function handleEvent(event) {
        if (event.type === 'TICKET_POPUP') {
            showPendingPopup(event.ticket, { broadcast: false, shownAt: event.shownAt || Date.now() });
        } else if (event.type === 'TICKET_ACKED') {
            transformToAcked(event.ticket, event.ackedBy);
        } else if (event.type === 'ACK_ERROR') {
            handleAckError(event.ticket.sys_id, event.message);
        } else if (event.type === 'TICKET_REMOVED') {
            knownPendingSysIds.delete(event.sys_id);
            removePopup(event.sys_id, { updateState: false }); // publisher already updated state
        } else if (event.type === 'ACK_REQUEST' && IS_SNOW_HOST && !sessionBroken) {
            // Same reasoning as the poll: a tab with a rejected session must not claim
            // work, because claiming it makes every other SNOW tab stand down and the
            // ack would then fail here. Declining lets a signed-in tab take it.
            claimAckRequest(event._id).then(won => {
                if (won) fulfillAckRequest(event.ticket, event._id);
            });
        }
    }

    async function fulfillAckRequest(ticket, requestId) {
        const myId = getMyId();
        if (!myId) {
            publishEvent({ type: 'ACK_ERROR', ticket, message: 'No active ServiceNow session found on this tab.' });
            if (requestId) GM_deleteValue(`sdAckMonitor_claim_${requestId}`);
            return;
        }
        inFlightAckSysIds.add(ticket.sys_id);
        try {
            await acknowledgeTicket(ticket.table, ticket.sys_id, myId);
            const ackedBy = getMyName();
            upsertState(ticket.sys_id, { ticket, status: 'acked', ackedBy, ackedAt: Date.now() });
            knownPendingSysIds.delete(ticket.sys_id);
            publishEvent({ type: 'TICKET_ACKED', ticket, ackedBy });
        } catch (err) {
            publishEvent({ type: 'ACK_ERROR', ticket, message: err.message });
        } finally {
            inFlightAckSysIds.delete(ticket.sys_id);
            if (requestId) GM_deleteValue(`sdAckMonitor_claim_${requestId}`);
        }
    }

    // ─── STYLES — glass, compact ────────────────────────────────────────────
    // GM_addStyle (rather than a manually created + appended <style> element) keeps
    // this immune to the host page's Content-Security-Policy — a plain
    // document.createElement('style') + document.head.appendChild(style) can have
    // its rules silently dropped by a strict style-src CSP.
    //
    // Every visual property below is hardened with !important, and our own
    // elements get a scoped box-sizing reset. Without this, a fresh tab landing on
    // a SNOW view that ships its own base element styles (e.g. Next Experience list
    // views, which apply !important on buttons/boxes as part of its design system)
    // can win the specificity fight against un-guarded rules — border-radius,
    // padding, box-sizing etc. silently fall back to SNOW's defaults, which is why
    // the popup looks polished on one tab/view but square and plain on another.
    GM_addStyle(`
        .sdmPopup, .sdmPopup * {
            box-sizing: border-box !important;
        }
        /* Real glass, not a white box: a translucent fill over a wide blur, so what is
           behind the card shows through as colour and movement. The catch with glass
           is that it disappears on a white page -- blurring white gives you white --
           so the card is never allowed to depend on the blur for its edges. Definition
           comes from things that survive any backdrop: a dark hairline border, a
           diagonal specular sheen across the top-left, and a shadow in four steps from
           contact to ambient. Every variant -- priority, urgency, acknowledged -- moves
           custom properties, not rules. */
        .sdmPopup {
            --sdm-surface-a: rgba(255,255,255,0.72);
            --sdm-surface-b: rgba(241,245,249,0.58);
            --sdm-border: rgba(15,23,42,0.14);
            --sdm-highlight: rgba(255,255,255,0.80);
            --sdm-text: #0f172a;
            --sdm-muted: #475569;
            --sdm-accent: #e11d48;
            --sdm-accent-soft: #fb7185;
            --sdm-accent-glow: rgba(225,29,72,0.30);
            --sdm-prio-a: #64748b;
            --sdm-prio-b: #475569;
            /* Green for the action, red for the clock: the two colours on the card
               now mean different things — the deadline pressing, and the way out of
               it. Deeper than a mid emerald on purpose, so white label text stays
               legible at 11.5px rather than sitting on a bright fill. */
            --sdm-btn-a: #059669;
            --sdm-btn-b: #047857;
            --sdm-btn-text: #ffffff;
            --sdm-hairline: rgba(15,23,42,0.13);
            --sdm-track: rgba(15,23,42,0.07);
            --sdm-progress: 100%;

            position: fixed !important;
            right: 18px !important;
            width: ${CONFIG.POPUP_WIDTH}px !important;
            padding: 9px 12px 11px 12px !important;
            margin: 0 !important;
            overflow: hidden !important;
            background-color: transparent !important;
            background-image: linear-gradient(155deg, var(--sdm-surface-a), var(--sdm-surface-b)) !important;
            backdrop-filter: blur(20px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
            border: 1px solid var(--sdm-border) !important;
            border-radius: 14px !important;
            box-shadow:
                0 1px 2px rgba(15,23,42,0.06),
                0 6px 12px -4px rgba(15,23,42,0.10),
                0 18px 32px -14px rgba(15,23,42,0.22),
                inset 0 1px 0 var(--sdm-highlight),
                inset 0 -1px 0 rgba(15,23,42,0.05) !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
            font-size: 13px !important;
            line-height: 1.4 !important;
            text-align: left !important;
            color: var(--sdm-text) !important;
            color-scheme: light !important;
            z-index: 999999 !important;
            transform: scale(var(--sdm-scale, 1)) !important;
            transform-origin: top right !important;
            transition: top 0.32s cubic-bezier(0.22,1,0.36,1), box-shadow 0.2s ease, transform 0.2s ease !important;
            animation: sdmEnter 420ms cubic-bezier(0.22,1,0.36,1) backwards !important;
        }
        /* backwards, not both: once the entrance has played the element goes back to
           its normal styles, which is what lets :hover move it at all. */
        @keyframes sdmEnter {
            from { opacity: 0; transform: translateX(26px) scale(calc(var(--sdm-scale, 1) * 0.965)); }
            to   { opacity: 1; transform: scale(var(--sdm-scale, 1)); }
        }
        @keyframes sdmLeave {
            to { opacity: 0; transform: translateX(18px) scale(calc(var(--sdm-scale, 1) * 0.97)); }
        }
        .sdmPopup.sdmLeaving { animation: sdmLeave 200ms ease forwards !important; pointer-events: none !important; }
        .sdmPopup:hover {
            transform: translateY(-1px) scale(var(--sdm-scale, 1)) !important;
            box-shadow:
                0 1px 2px rgba(15,23,42,0.07),
                0 10px 18px -6px rgba(15,23,42,0.14),
                0 26px 44px -18px rgba(15,23,42,0.28),
                inset 0 1px 0 var(--sdm-highlight),
                inset 0 -1px 0 rgba(15,23,42,0.05) !important;
        }
        /* The specular sheen -- the thing that makes a pane read as glass rather than
           as a flat translucent rectangle, and the one cue that still works when the
           page behind is plain white. z-index:-1 keeps it above the card's own fill
           but under the text, so nothing gets washed out; the transform on .sdmPopup
           gives us the stacking context that keeps it clipped to the card. */
        .sdmPopup::before {
            content: "" !important;
            position: absolute !important; inset: 0 !important; z-index: -1 !important;
            pointer-events: none !important; border-radius: inherit !important;
            background-image: linear-gradient(140deg,
                rgba(255,255,255,0.55) 0%,
                rgba(255,255,255,0.18) 26%,
                rgba(255,255,255,0) 52%) !important;
        }
        /* Without backdrop-filter there is nothing behind the glass to look at, and a
           58%-white card over a busy list is just unreadable. Fall back to the solid
           surface those browsers were getting before. */
        @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
            .sdmPopup {
                --sdm-surface-a: rgba(255,255,255,0.99);
                --sdm-surface-b: rgba(248,250,252,0.99);
            }
        }
        /* Urgency owns the accent -- everything here is inside an SLA countdown, so a
           P4 does not get to look calm. Priority colours its own chip instead. */
        .sdmPopup.sdmP1 { --sdm-prio-a: #ef4444; --sdm-prio-b: #b91c1c; }
        .sdmPopup.sdmP2 { --sdm-prio-a: #f97316; --sdm-prio-b: #c2410c; }
        .sdmPopup.sdmP3 { --sdm-prio-a: #eab308; --sdm-prio-b: #a16207; }
        .sdmPopup.sdmAcked {
            --sdm-accent: #059669; --sdm-accent-soft: #34d399; --sdm-accent-glow: rgba(5,150,105,0.30);
            --sdm-surface-a: rgba(236,253,245,0.74); --sdm-surface-b: rgba(240,253,248,0.58);
        }
        /* Under 30s the whole card is lit, not just the digits -- peripheral vision
           reads a change in the object long before it reads four characters. */
        .sdmPopup.sdmHot { animation: sdmEnter 420ms cubic-bezier(0.22,1,0.36,1) backwards, sdmBreathe 2.2s ease-in-out 420ms infinite !important; }
        @keyframes sdmBreathe {
            0%, 100% { box-shadow: 0 1px 2px rgba(15,23,42,0.06), 0 6px 12px -4px rgba(15,23,42,0.10), 0 18px 32px -14px rgba(15,23,42,0.22), 0 0 0 0 rgba(225,29,72,0), inset 0 1px 0 var(--sdm-highlight), inset 0 -1px 0 rgba(15,23,42,0.05); }
            50%      { box-shadow: 0 1px 2px rgba(15,23,42,0.06), 0 6px 12px -4px rgba(15,23,42,0.10), 0 18px 34px -14px rgba(225,29,72,0.34), 0 0 0 3px rgba(225,29,72,0.10), inset 0 1px 0 var(--sdm-highlight), inset 0 -1px 0 rgba(15,23,42,0.05); }
        }

        .sdmPopup .sdmHead { display: flex !important; align-items: center !important; gap: 7px !important; margin: 0 !important; }
        .sdmPopup .sdmPrio {
            font-size: 9.5px !important; font-weight: 800 !important; letter-spacing: 0.06em !important;
            color: #ffffff !important;
            background-image: linear-gradient(180deg, var(--sdm-prio-a), var(--sdm-prio-b)) !important;
            border-radius: 4px !important; padding: 2px 5px !important; margin: 0 !important;
            flex: 0 0 auto !important; line-height: 1.3 !important;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.25), 0 1px 2px rgba(15,23,42,0.18) !important;
            text-shadow: 0 1px 1px rgba(0,0,0,0.18) !important;
        }
        .sdmPopup .sdmNum {
            font-size: 13px !important; font-weight: 650 !important; letter-spacing: -0.01em !important;
            color: var(--sdm-text) !important; flex: 1 1 auto !important; min-width: 0 !important;
            overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
        }
        .sdmPopup .sdmTime {
            flex: 0 0 auto !important;
            font-size: 13.5px !important; font-weight: 700 !important; letter-spacing: 0.01em !important;
            font-variant-numeric: tabular-nums !important; font-feature-settings: "tnum" 1 !important;
            color: var(--sdm-muted) !important;
            transition: color 0.3s ease !important;
        }
        .sdmPopup .sdmTime.sdmUrgent { color: var(--sdm-accent) !important; text-shadow: 0 0 14px var(--sdm-accent-glow) !important; }
        .sdmPopup .sdmTime.sdmOver {
            font-size: 10.5px !important; font-weight: 800 !important; letter-spacing: 0.09em !important;
            color: #ffffff !important; background-image: linear-gradient(180deg, var(--sdm-accent-soft), var(--sdm-accent)) !important;
            border-radius: 4px !important; padding: 2px 6px !important;
            box-shadow: 0 1px 6px var(--sdm-accent-glow) !important;
            animation: sdmFade 1.6s ease-in-out infinite !important;
        }
        @keyframes sdmFade { 50% { opacity: 0.55; } }
        .sdmPopup .sdmTimerLabel { display: none !important; }

        .sdmPopup .sdmDesc {
            font-size: 11.5px !important; color: var(--sdm-muted) !important; margin: 2px 0 8px 0 !important;
            overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important;
        }

        .sdmPopup .sdmActions { display: flex !important; gap: 6px !important; }
        .sdmPopup .sdmBtn {
            flex: 1 1 auto !important; height: 26px !important; padding: 0 12px !important; margin: 0 !important;
            background-image: linear-gradient(180deg, var(--sdm-btn-a), var(--sdm-btn-b)) !important;
            color: var(--sdm-btn-text) !important;
            border: 1px solid transparent !important; border-radius: 7px !important;
            font-family: inherit !important; font-size: 11.5px !important; font-weight: 650 !important; line-height: 1 !important;
            letter-spacing: 0.005em !important; text-align: center !important; cursor: pointer !important;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.12), 0 1px 2px rgba(15,23,42,0.18) !important;
            transition: filter 0.15s ease, transform 0.08s ease !important;
            position: relative !important;
        }
        .sdmPopup .sdmBtn:hover { filter: brightness(1.14) !important; }
        .sdmPopup .sdmBtn:active { transform: translateY(0.5px) scale(0.995) !important; }
        .sdmPopup .sdmBtn:disabled { opacity: 0.55 !important; cursor: default !important; filter: none !important; }
        .sdmPopup .sdmGhost {
            flex: 0 0 auto !important; background-image: none !important; background: transparent !important;
            color: var(--sdm-muted) !important; border-color: var(--sdm-hairline) !important;
            box-shadow: none !important;
        }
        .sdmPopup .sdmGhost:hover { background: var(--sdm-track) !important; color: var(--sdm-text) !important; filter: none !important; }
        /* Acknowledging is a round trip through a real form -- it can take seconds, and
           a button that just greys out looks broken while it works. */
        .sdmPopup .sdmBtn.sdmBusy { color: transparent !important; }
        .sdmPopup .sdmBtn.sdmBusy::after {
            content: "" !important; position: absolute !important; top: 50% !important; left: 50% !important;
            width: 12px !important; height: 12px !important; margin: -6px 0 0 -6px !important;
            border: 2px solid rgba(255,255,255,0.30) !important; border-top-color: var(--sdm-btn-text) !important;
            border-radius: 50% !important; animation: sdmSpin 0.6s linear infinite !important;
        }
        @keyframes sdmSpin { to { transform: rotate(360deg); } }

        /* The timer as the card's bottom edge: full-width, always in the same place,
           costing no height at all. */
        .sdmPopup .sdmTrack {
            position: absolute !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
            height: 3px !important; margin: 0 !important; background: var(--sdm-track) !important; overflow: hidden !important;
            /* The card's inner radius (14px outer, less the 1px border), so the bar
               follows the bottom corners instead of cutting across them. */
            border-radius: 0 0 13px 13px !important;
        }
        .sdmPopup .sdmFill {
            height: 100% !important; width: var(--sdm-progress, 100%) !important;
            background-image: linear-gradient(90deg, var(--sdm-accent-soft), var(--sdm-accent)) !important;
            box-shadow: inset 0 1px 0 rgba(255,255,255,0.25) !important;
            transition: width 1s linear !important;
            position: relative !important;
        }
        .sdmPopup.sdmHot .sdmFill::after {
            content: "" !important; position: absolute !important; top: 0 !important; bottom: 0 !important; left: 0 !important; right: 0 !important;
            background-image: linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent) !important;
            animation: sdmSweep 1.8s ease-in-out infinite !important;
        }
        @keyframes sdmSweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }

        .sdmPopup .sdmError { font-size: 11px !important; line-height: 1.4 !important; color: var(--sdm-accent) !important; margin: 7px 0 0 0 !important; }

        .sdmPopup .sdmDone { display: flex !important; align-items: center !important; gap: 8px !important; margin: 5px 0 9px 0 !important; }
        .sdmPopup .sdmCheck {
            width: 19px !important; height: 19px !important; flex: 0 0 auto !important;
            border-radius: 50% !important;
            background-image: linear-gradient(180deg, var(--sdm-accent-soft), var(--sdm-accent)) !important;
            box-shadow: 0 2px 8px -1px var(--sdm-accent-glow), inset 0 1px 0 rgba(255,255,255,0.3) !important;
            color: #ffffff !important;
            font-size: 11px !important; font-weight: 700 !important; line-height: 19px !important; text-align: center !important;
            animation: sdmPop 420ms cubic-bezier(0.34,1.56,0.64,1) backwards !important;
        }
        @keyframes sdmPop { from { transform: scale(0.3); opacity: 0; } to { transform: scale(1); opacity: 1; } }
        .sdmPopup .sdmDoneText { font-size: 12px !important; color: var(--sdm-text) !important; min-width: 0 !important; }
        .sdmPopup .sdmClose {
            flex: 0 0 auto !important; width: 19px !important; height: 19px !important; padding: 0 !important; margin: 0 !important;
            border: none !important; background: transparent !important; box-shadow: none !important;
            color: var(--sdm-muted) !important; font-size: 14px !important; line-height: 1 !important;
            cursor: pointer !important; border-radius: 5px !important; opacity: 0.6 !important;
            transition: opacity 0.15s ease, background 0.15s ease !important;
        }
        .sdmPopup .sdmClose:hover { opacity: 1 !important; background: var(--sdm-track) !important; }

        /* Anyone who has asked their system to calm down gets the layout, not the show. */
        @media (prefers-reduced-motion: reduce) {
            .sdmPopup, .sdmPopup *, .sdmPopup::before, .sdmPopup .sdmFill::after {
                animation: none !important;
                transition: none !important;
            }
        }

        #sdmStatusIndicator, #sdmStatusIndicator * {
            box-sizing: border-box !important;
        }
        #sdmStatusIndicator {
            position: fixed !important;
            left: 16px !important;
            bottom: 16px !important;
            background: rgba(255,255,255,0.65) !important;
            backdrop-filter: blur(16px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(16px) saturate(180%) !important;
            border: 1px solid rgba(255,255,255,0.4) !important;
            border-radius: 20px !important;
            padding: 6px 12px !important;
            margin: 0 !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            font-size: 11px !important;
            color: rgba(26,26,46,0.75) !important;
            box-shadow: 0 4px 16px rgba(0,0,0,0.12) !important;
            z-index: 999998 !important;
            display: flex !important;
            align-items: center !important;
            gap: 6px !important;
            user-select: none !important;
        }
        #sdmStatusIndicator .sdmDot {
            width: 7px !important; height: 7px !important; border-radius: 50% !important;
            background: #2e9e5b !important;
            animation: sdmPulse 2s infinite !important;
            flex-shrink: 0 !important;
            margin: 0 !important;
        }
        #sdmStatusIndicator.sdmErrorState .sdmDot { background: #e5484d !important; animation: none !important; }
        #sdmStatusIndicator .sdmVer {
            font-size: 10px !important;
            font-weight: 600 !important;
            letter-spacing: 0.02em !important;
            color: rgba(26,26,46,0.45) !important;
            background: rgba(26,26,46,0.07) !important;
            border-radius: 6px !important;
            padding: 2px 5px !important;
            margin: 0 !important;
            flex: 0 0 auto !important;
        }
        #sdmStatusIndicator .sdmReconnectBtn {
            display: none !important;
            border: none !important;
            border-radius: 10px !important;
            background: #b3261e !important;
            color: #fff !important;
            font-family: inherit !important;
            font-size: 10.5px !important;
            line-height: normal !important;
            padding: 3px 9px !important;
            margin: 0 0 0 2px !important;
            cursor: pointer !important;
            box-shadow: none !important;
            flex: 0 0 auto !important;
        }
        #sdmStatusIndicator.sdmSessionLost .sdmReconnectBtn { display: inline-block !important; }
        #sdmStatusIndicator .sdmReconnectBtn:disabled { opacity: 0.5 !important; cursor: default !important; }
        @keyframes sdmPulse {
            0%   { box-shadow: 0 0 0 0 rgba(46,158,91,0.4); }
            70%  { box-shadow: 0 0 0 6px rgba(46,158,91,0); }
            100% { box-shadow: 0 0 0 0 rgba(46,158,91,0); }
        }
    `);

    // ─── STATUS INDICATOR — SNOW pages only ─────────────────────────────────
    let statusTextEl = null;
    let statusEl = null;
    let reconnectBtn = null;
    if (IS_SNOW_HOST) {
        statusEl = document.createElement('div');
        statusEl.id = 'sdmStatusIndicator';
        statusEl.innerHTML = `<span class="sdmDot"></span><span class="sdmStatusText">ACK Monitor loaded</span>`
            + `<span class="sdmVer"></span>`
            + `<button class="sdmReconnectBtn" type="button">Reconnect</button>`;
        document.body.appendChild(statusEl);
        // Its own span rather than part of the status text, which setStatus rewrites
        // on every poll — the version has to survive those.
        statusEl.querySelector('.sdmVer').textContent = `v${SCRIPT_VERSION}`;
        statusTextEl = statusEl.querySelector('.sdmStatusText');
        reconnectBtn = statusEl.querySelector('.sdmReconnectBtn');
        reconnectBtn.addEventListener('click', reconnectSession);
    }

    function setStatus(text, isError = false) {
        if (!statusEl) return; // no-op on non-SNOW pages
        statusTextEl.textContent = text;
        statusEl.classList.toggle('sdmErrorState', isError);
    }

    // ─── SESSION BANNER + RECONNECT ─────────────────────────────────────────
    // The status pill is the only chrome this script owns on a SNOW page, so it
    // doubles as the "you are signed out" banner. It has to be actionable: the poll
    // has stood down and nothing will restart it on its own — that standing down is
    // the actual fix for the credential dialog, since every further request would
    // re-provoke the browser's native login box.
    function showSessionBanner(reason) {
        if (statusEl) statusEl.classList.add('sdmSessionLost');
        setStatus('ACK Monitor — signed out, alerts paused', true);
        console.warn('[ACK Monitor] session lost:', reason);
    }

    async function reconnectSession() {
        if (reconnectBtn) { reconnectBtn.disabled = true; reconnectBtn.textContent = '…'; }
        // Clear the flag first so snFetch is allowed to try again, and drop the cached
        // token so we re-read it rather than replaying the one that was just rejected.
        sessionBroken = false;
        sessionToken = null;
        setStatus('ACK Monitor — reconnecting…');
        try {
            const token = await getSessionToken(true);
            if (!token) throw new Error('Could not read the ServiceNow session token (g_ck) — the SSO session looks gone.');
            if (statusEl) statusEl.classList.remove('sdmSessionLost');
            await pollMyUnacknowledged();
            markPolled(); // rejoin the shared rhythm rather than leaving a poll overdue
        } catch (e) {
            markSessionBroken(e.message);
        } finally {
            if (reconnectBtn) { reconnectBtn.disabled = false; reconnectBtn.textContent = 'Reconnect'; }
        }
    }

    // ─── ALERT SOUND — synthesized, no external file needed ────────────────
    // The autoplay policy is the whole story here, and the old code lost to it in a
    // way it could never recover from. An AudioContext constructed before the tab has
    // seen a user gesture is born 'suspended', and scheduling notes on a suspended
    // context does nothing at all — silently. That context was then cached forever and
    // resume() was never called, so the *first* alert after a page load (exactly the
    // case where nobody has clicked yet — the agent is looking at another window,
    // which is the whole point of an alerting tool) turned the sound off for the rest
    // of the session, no matter how much they clicked afterwards.
    //
    // Two fixes: take the first user gesture the tab sees, anywhere on the page, to
    // get the context running; and resume before every alert, playing from inside the
    // promise so notes are never scheduled onto a context that is still asleep.
    let audioCtx = null;

    function getAudioCtx() {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        if (!audioCtx || audioCtx.state === 'closed') audioCtx = new Ctor();
        return audioCtx;
    }

    function unlockAudio() {
        if (!CONFIG.SOUND_ENABLED) return;
        const ctx = getAudioCtx();
        if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
    // Capturing and passive: this must not interfere with the host page's own
    // handling of the click, it only needs to know one happened.
    ['pointerdown', 'keydown'].forEach(evt =>
        document.addEventListener(evt, unlockAudio, { capture: true, passive: true }));

    function playAlertSound() {
        if (!CONFIG.SOUND_ENABLED) return;
        const ctx = getAudioCtx();
        if (!ctx) { console.warn('[ACK Monitor] no Web Audio support — alert is silent.'); return; }

        const beep = () => {
            try {
                const now = ctx.currentTime;
                [880, 1108].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.type = 'sine';
                    osc.frequency.value = freq;
                    const t0 = now + i * 0.15;
                    gain.gain.setValueAtTime(0, t0);
                    gain.gain.linearRampToValueAtTime(0.15, t0 + 0.02);
                    gain.gain.linearRampToValueAtTime(0, t0 + 0.18);
                    osc.connect(gain).connect(ctx.destination);
                    osc.start(t0);
                    osc.stop(t0 + 0.2);
                });
            } catch (e) {
                console.warn('[ACK Monitor] could not play alert sound', e);
            }
        };

        if (ctx.state === 'suspended') {
            ctx.resume().then(beep).catch(() => {
                console.warn('[ACK Monitor] the browser is still blocking audio on this tab — click anywhere on the page once and later alerts will sound.');
            });
            return;
        }
        beep();
    }

    // ─── POPUP STACKING (runs on every page — mirrors included) ─────────────
    const popupsBySysId = new Map();

    // A host page that scales its own content — a `zoom` on an ancestor, or a
    // transform, both of which some ServiceNow form views apply — scales our
    // fixed-position card along with it. That is why the same popup can come out
    // visibly larger on a ticket form than on a list view, despite every dimension
    // here being a fixed pixel value.
    //
    // Measure a probe of known width once and hand the popups the inverse. Browser
    // zoom (Ctrl +) deliberately does not trigger this: it scales the viewport too,
    // so the probe still measures 100 and the popup keeps matching the rest of the
    // page, which is what someone zooming actually wants.
    let pageScale = null;
    function getPageScale() {
        if (pageScale !== null) return pageScale;
        try {
            const probe = document.createElement('div');
            probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:100px;height:1px;pointer-events:none;visibility:hidden;';
            document.body.appendChild(probe);
            const measured = probe.getBoundingClientRect().width;
            probe.remove();
            const ratio = measured / 100;
            // Ignore the implausible: a wild ratio means the measurement is wrong,
            // and scaling by a wrong number is worse than not scaling at all.
            pageScale = (ratio > 0.5 && ratio < 3 && Math.abs(ratio - 1) > 0.02) ? 1 / ratio : 1;
            if (pageScale !== 1) {
                console.log(`[ACK Monitor] this page scales its content by ${ratio.toFixed(3)}x — compensating so the popup stays ${CONFIG.POPUP_WIDTH}px.`);
            }
        } catch {
            pageScale = 1;
        }
        return pageScale;
    }

    // A mirror tab has no ServiceNow origin of its own, so the ticket carries the one
    // it was found on. Shared by the pending and acknowledged states.
    function openTicket(ticket) {
        const base = ticket.origin || (IS_SNOW_HOST ? location.origin : '');
        if (!base) {
            console.warn('[ACK Monitor] no known SNOW origin for this ticket — cannot open it from here.');
            return;
        }
        window.open(`${base}/${ticket.table}.do?sys_id=${ticket.sys_id}&sysparm_stack=no`, '_blank');
    }

    function relayoutPopups() {
        let top = 24;
        popupsBySysId.forEach(popup => {
            popup.style.top = `${top}px`;
            top += popup.offsetHeight + CONFIG.POPUP_GAP;
        });
    }

    function removePopup(sysId, { updateState = true } = {}) {
        const popup = popupsBySysId.get(sysId);
        if (updateState) deleteState(sysId);
        if (!popup) return;
        if (popup._countdownTimer) clearInterval(popup._countdownTimer);
        if (popup._closeTimer) clearTimeout(popup._closeTimer);
        if (popup._ackRequestTimeout) clearTimeout(popup._ackRequestTimeout);
        popupsBySysId.delete(sysId);
        // Out of the map immediately so the stack closes the gap straight away, but
        // left in the DOM long enough to animate out. A popup vanishing mid-blink is
        // what makes an interface feel like it glitched.
        popup.classList.add('sdmLeaving');
        setTimeout(() => popup.remove(), 220);
        relayoutPopups();
    }

    function transformToAcked(ticket, ackedByName, remainingMs = CONFIG.ACKED_LIFETIME_MS) {
        let popup = popupsBySysId.get(ticket.sys_id);
        if (!popup) {
            // The pending popup can be torn down (e.g. a poll cycle noticed the ticket
            // had already left the "unacknowledged" query mid-acknowledgement and
            // removed it) before this ack confirmation arrives — on this tab or a
            // mirror tab. Rebuild the shell so the acked confirmation still shows
            // without requiring a page reload.
            showPendingPopup(ticket, { broadcast: false, playSound: false });
            popup = popupsBySysId.get(ticket.sys_id);
            if (!popup) return; // couldn't rebuild it — nothing more we can do
        }
        if (popup._countdownTimer) clearInterval(popup._countdownTimer);
        if (popup._ackRequestTimeout) clearTimeout(popup._ackRequestTimeout);

        popup.classList.remove('sdmPending');
        popup.classList.add('sdmAcked');
        popup.textContent = '';

        const head = document.createElement('div');
        head.className = 'sdmHead';

        const num = document.createElement('span');
        num.className = 'sdmNum';
        num.textContent = ticket.number;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'sdmClose';
        closeBtn.type = 'button';
        closeBtn.title = 'Dismiss';
        closeBtn.setAttribute('aria-label', 'Dismiss');
        closeBtn.textContent = '×';

        head.append(num, closeBtn);

        const done = document.createElement('div');
        done.className = 'sdmDone';
        const check = document.createElement('span');
        check.className = 'sdmCheck';
        check.textContent = '✓';
        const doneText = document.createElement('span');
        doneText.className = 'sdmDoneText';
        doneText.textContent = `Acknowledged by ${ackedByName}`;
        done.append(check, doneText);

        const actions = document.createElement('div');
        actions.className = 'sdmActions';
        const openBtn = document.createElement('button');
        openBtn.className = 'sdmBtn sdmGhost sdmOpenBtn';
        openBtn.type = 'button';
        openBtn.textContent = 'Open ticket';
        actions.append(openBtn);

        const doneTrack = document.createElement('div');
        doneTrack.className = 'sdmTrack';
        const doneFill = document.createElement('div');
        doneFill.className = 'sdmFill';
        doneTrack.append(doneFill);

        popup.append(head, done, actions, doneTrack);

        closeBtn.addEventListener('click', () => {
            removePopup(ticket.sys_id);
            publishEvent({ type: 'TICKET_REMOVED', sys_id: ticket.sys_id });
        });
        openBtn.addEventListener('click', () => openTicket(ticket));

        popup._closeTimer = setTimeout(() => removePopup(ticket.sys_id), Math.max(remainingMs, 0));
        relayoutPopups();
    }

    function handleAckError(sysId, message) {
        const popup = popupsBySysId.get(sysId);
        if (!popup) return;
        if (popup._ackRequestTimeout) clearTimeout(popup._ackRequestTimeout);
        const ackBtn = popup.querySelector('.sdmAckBtn');
        const errorEl = popup.querySelector('.sdmError');
        if (ackBtn) { ackBtn.disabled = false; ackBtn.classList.remove('sdmBusy'); }
        if (errorEl) { errorEl.textContent = `❌ ${message}`; errorEl.style.display = 'block'; }
        relayoutPopups();
    }

    function showPendingPopup(ticket, { broadcast = true, playSound = true, shownAt = Date.now() } = {}) {
        if (popupsBySysId.has(ticket.sys_id)) return;

        // Built node-by-node with textContent rather than an innerHTML template:
        // ticket.number/short_desc are server-supplied strings that end up rendered
        // on every domain this script runs on, so they must never be parsed as HTML.
        const popup = document.createElement('div');
        // P1/P2 carry their own chip colour; anything else stays neutral rather than
        // inventing a shade per priority value the instance might use.
        const prioClass = /^P[123]$/.test(ticket.priority || '') ? ` sdm${ticket.priority}` : '';
        popup.className = `sdmPopup sdmPending${prioClass}`;

        const head = document.createElement('div');
        head.className = 'sdmHead';

        const prio = document.createElement('span');
        prio.className = 'sdmPrio';
        prio.textContent = ticket.priority || (ticket.table === 'sc_task' ? 'TASK' : 'INC');

        const num = document.createElement('span');
        num.className = 'sdmNum';
        num.textContent = ticket.number;

        // The clock sits on the header line rather than in a row of its own: it is
        // the same glance as the ticket number, and it saves the popup a whole line.
        const countdownEl = document.createElement('span');
        countdownEl.className = 'sdmTime';

        head.append(prio, num, countdownEl);

        const desc = document.createElement('div');
        desc.className = 'sdmDesc';
        desc.textContent = ticket.short_desc;

        // The remaining time as the card's bottom edge — always in the same place,
        // readable from across a desk in a way four digits are not, and costing no
        // height at all.
        const track = document.createElement('div');
        track.className = 'sdmTrack';
        const fill = document.createElement('div');
        fill.className = 'sdmFill';
        track.append(fill);

        const actions = document.createElement('div');
        actions.className = 'sdmActions';
        const ackBtn = document.createElement('button');
        ackBtn.className = 'sdmBtn sdmAckBtn';
        ackBtn.type = 'button';
        ackBtn.textContent = 'Acknowledge';
        const openBtn = document.createElement('button');
        openBtn.className = 'sdmBtn sdmGhost sdmOpenBtn';
        openBtn.type = 'button';
        openBtn.textContent = 'Open';
        openBtn.title = 'Open the ticket in a new tab';
        openBtn.addEventListener('click', () => openTicket(ticket));
        actions.append(ackBtn, openBtn);

        const errorEl = document.createElement('div');
        errorEl.className = 'sdmError';
        errorEl.style.display = 'none';

        popup.append(head, desc, actions, errorEl, track);
        const scale = getPageScale();
        if (scale !== 1) popup.style.setProperty('--sdm-scale', String(scale));
        document.body.appendChild(popup);
        popupsBySysId.set(ticket.sys_id, popup);
        if (playSound) playAlertSound();

        // The countdown is derived from shownAt (when the ticket first alerted)
        // rather than from when this particular popup was built, so a tab that
        // opens or reloads mid-alert shows the same time remaining as every other
        // tab instead of restarting at the full duration.
        function renderCountdown() {
            const total = CONFIG.COUNTDOWN_SECONDS;
            const remaining = total - Math.floor((Date.now() - shownAt) / 1000);
            if (remaining <= 0) {
                countdownEl.textContent = 'OVERDUE';
                countdownEl.classList.remove('sdmUrgent');
                countdownEl.classList.add('sdmOver');
                // The card stops breathing once the deadline is gone: the badge takes
                // over, and a pulse nobody can act on any more is just noise.
                popup.classList.remove('sdmHot');
                fill.style.setProperty('--sdm-progress', '0%');
                if (popup._countdownTimer) {
                    clearInterval(popup._countdownTimer);
                    popup._countdownTimer = null;
                }
                return;
            }
            const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
            const ss = String(remaining % 60).padStart(2, '0');
            countdownEl.textContent = `${mm}:${ss}`;
            countdownEl.classList.toggle('sdmUrgent', remaining <= 30);
            popup.classList.toggle('sdmHot', remaining <= 30);
            fill.style.setProperty('--sdm-progress', `${Math.max(0, Math.min(100, (remaining / total) * 100))}%`);
        }
        renderCountdown();
        relayoutPopups();
        if (!countdownEl.classList.contains('sdmOver')) {
            popup._countdownTimer = setInterval(renderCountdown, 1000);
        }

        ackBtn.addEventListener('click', async () => {
            errorEl.style.display = 'none';

            if (IS_SNOW_HOST) {
                const myId = getMyId();
                if (!myId) {
                    errorEl.textContent = '❌ Could not resolve your sys_id on this page.';
                    errorEl.style.display = 'block';
                    return;
                }
                ackBtn.disabled = true;
                ackBtn.classList.add('sdmBusy');
                inFlightAckSysIds.add(ticket.sys_id);
                try {
                    await acknowledgeTicket(ticket.table, ticket.sys_id, myId);
                    const myName = getMyName();
                    transformToAcked(ticket, myName);
                    upsertState(ticket.sys_id, { ticket, status: 'acked', ackedBy: myName, ackedAt: Date.now() });
                    knownPendingSysIds.delete(ticket.sys_id);
                    publishEvent({ type: 'TICKET_ACKED', ticket, ackedBy: myName });
                } catch (err) {
                    ackBtn.disabled = false;
                    ackBtn.classList.remove('sdmBusy');
                    errorEl.textContent = `❌ ${err.message}`;
                    errorEl.style.display = 'block';
                    relayoutPopups();
                    console.error('[SD Monitor]', err);
                } finally {
                    inFlightAckSysIds.delete(ticket.sys_id);
                }
            } else {
                // Mirror tab: can't act directly (no session/CSRF here) — relay to a SNOW tab.
                ackBtn.disabled = true;
                ackBtn.classList.add('sdmBusy');
                publishEvent({ type: 'ACK_REQUEST', ticket });
                popup._ackRequestTimeout = setTimeout(() => {
                    handleAckError(ticket.sys_id, 'No open ServiceNow tab responded. Open SNOW and try again.');
                }, CONFIG.ACK_REQUEST_TIMEOUT_MS);
            }
        });

        if (broadcast) {
            knownPendingSysIds.add(ticket.sys_id);
            upsertState(ticket.sys_id, { ticket, status: 'pending', shownAt });
            publishEvent({ type: 'TICKET_POPUP', ticket, shownAt });
        }
    }

    function syncFromPersistedState() {
        const state = pruneState(getState());
        setState(state); // persist the pruning itself
        Object.keys(state).forEach(sysId => {
            const entry = state[sysId];
            if (entry.status === 'pending') {
                knownPendingSysIds.add(sysId);
                showPendingPopup(entry.ticket, { broadcast: false, playSound: false, shownAt: entry.shownAt || Date.now() });
            } else if (entry.status === 'acked') {
                const remaining = CONFIG.ACKED_LIFETIME_MS - (Date.now() - entry.ackedAt);
                if (remaining > 0) {
                    showPendingPopup(entry.ticket, { broadcast: false, playSound: false }); // create the shell
                    transformToAcked(entry.ticket, entry.ackedBy, remaining);
                }
            }
        });
    }
    syncFromPersistedState();

    // ─── POLL — SNOW pages only ──────────────────────────────────────────────
    async function pollMyUnacknowledged() {
        const myId = getMyId();
        if (!myId) {
            setStatus('ACK Monitor — no user ID on this page', true);
            console.warn('[ACK Monitor] no myId resolved — getMyId() returned empty, skipping this poll.');
            return;
        }

        let allTickets = [];
        for (const table of CONFIG.TABLES) {
            try {
                const substateVal = CONFIG.NOT_ACKED_SUBSTATE[table] ?? '1';
                let query = `assigned_to=${myId}^u_substate=${substateVal}`;
                if (CONFIG.EXTRA_FILTER[table]) query += `^${CONFIG.EXTRA_FILTER[table]}`;
                const tickets = await jFetch(table, query, 50);
                tickets.forEach(t => { t._table = table; });
                allTickets = allTickets.concat(tickets);
            } catch (e) {
                // A dead session isn't a per-table hiccup to log and carry on from:
                // the next table would just re-provoke the auth challenge. The banner
                // is already up, so abandon the whole round.
                if (e instanceof SessionError) return;
                setStatus(`ACK Monitor — poll error (${table})`, true);
                console.error(`[ACK Monitor] poll failed for ${table}`, e);
            }
        }

        console.log(`[ACK Monitor] found ${allTickets.length} unacknowledged ticket(s):`, allTickets.map(t => `${t._table}:${t.number}`));
        setStatus(allTickets.length ? `ACK Monitor — ${allTickets.length} pending` : 'ACK Monitor — active');

        const currentSysIds = new Set(allTickets.map(t => t.sys_id));

        // Teardown candidates come from the persisted state as well as this tab's own
        // set. Polling leadership can move between tabs, and knownPendingSysIds is only
        // populated by the tab that actually broadcast a popup — a tab that inherits
        // leadership would otherwise have an empty set and never retire stale popups.
        const persisted = getState();
        const previouslyPending = new Set(knownPendingSysIds);
        Object.keys(persisted).forEach(sysId => {
            if (persisted[sysId].status === 'pending') previouslyPending.add(sysId);
        });

        previouslyPending.forEach(sysId => {
            if (!currentSysIds.has(sysId) && !inFlightAckSysIds.has(sysId)) {
                knownPendingSysIds.delete(sysId);
                removePopup(sysId); // also cleans up persisted state
                publishEvent({ type: 'TICKET_REMOVED', sys_id: sysId });
            }
        });

        // Keep our own set aligned with what the server says is pending, so leadership
        // handoffs don't depend on having personally broadcast each popup.
        currentSysIds.forEach(sysId => knownPendingSysIds.add(sysId));

        allTickets.forEach(t => {
            showPendingPopup({
                table: t._table,
                sys_id: t.sys_id,
                number: t.number,
                short_desc: t.short_description || '(no description)',
                priority: t.priority ? `P${t.priority}` : '',
                origin: location.origin
            });
        });
    }

    // ─── POLL SCHEDULING (shared across SNOW tabs) ──────────────────────────
    // Every open SNOW tab used to poll independently: N tabs meant N× the API load
    // and N tabs racing to broadcast the same popup. So the polling has to be shared
    // — but note what we actually care about: not "which tab is in charge", only
    // "has *somebody* polled recently". Tracking the latter directly is both simpler
    // and much better behaved when a tab dies.
    //
    // So there is no leader and no lease. GM storage holds one timestamp: when the
    // last poll happened. Each SNOW tab wakes on a short tick and, if a poll is
    // overdue, volunteers to do it. Whoever gets there first wins the round; the
    // others see the refreshed timestamp and go back to sleep.
    //
    // Why this beats a lease: a lease has to expire before anyone else may act, so
    // a hard-killed tab (crash, task-kill — no unload event fires) stalls polling
    // for the whole expiry window. Here a dead tab simply stops refreshing the
    // timestamp, and the next tab to notice it is overdue picks the work up. The
    // worst case degrades to one normal poll interval instead of an extra timeout.
    //
    // Polling is deliberately NOT gated on document.visibilityState — this is an
    // alerting tool, and the case that matters most is the agent looking at
    // something else, so a hidden tab must keep polling. Visibility is used only as
    // a *preference*: hidden tabs wait a short grace period before volunteering, so
    // a visible tab naturally takes the work when one exists. That matters because
    // browsers throttle background timers hard (Chrome drops them toward ~1/min),
    // and a hidden tab doing the polling would quietly stretch the real interval for
    // everyone. When every tab is hidden, they all volunteer after the grace period
    // and the work still gets done.
    const LAST_POLL_KEY = 'sdAckMonitor_lastPoll';
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const isVisible = () => document.visibilityState === 'visible';

    function readLastPoll() {
        try {
            const rec = JSON.parse(GM_getValue(LAST_POLL_KEY, ''));
            return rec && rec.ts ? rec : null;
        } catch { return null; }
    }

    function markPolled() {
        GM_setValue(LAST_POLL_KEY, JSON.stringify({ ts: Date.now(), tabId: TAB_ID, visible: isVisible() }));
    }

    function pollIsDue() {
        const last = readLastPoll();
        if (!last) return true; // nobody has ever polled
        const wait = CONFIG.POLL_MS + (isVisible() ? 0 : CONFIG.HIDDEN_TAB_GRACE_MS);
        return Date.now() - last.ts >= wait;
    }

    // Same approximate-lock shape as claimAckRequest: jitter, re-check, stake the
    // claim, re-check. Worst case two tabs both conclude they won and double-poll a
    // single round, which is harmless — the popup/state paths are idempotent.
    let pollInFlight = false;
    async function pollCycle() {
        if (pollInFlight || !pollIsDue()) return;

        // Never volunteer if this tab can't actually do the work. Some SNOW pages
        // resolve no user id (session not established yet, an odd sub-app, a logged-out
        // tab) — and because staking the claim makes every *other* tab stand down, a
        // tab that then bails out would silently suppress polling everywhere. Sharing
        // the work means a broken tab has to decline the round, not consume it.
        //
        // A tab whose session was rejected declines for the same reason, and gets its
        // own branch because the consequence differs: polling on from here is what
        // re-opened the browser's credential dialog every POLL_MS. It waits for a
        // human to hit Reconnect; meanwhile any healthy tab keeps alerting for us all.
        if (sessionBroken) return;
        if (!getMyId()) {
            setStatus('ACK Monitor — no user ID on this page', true);
            return;
        }

        pollInFlight = true;
        try {
            await sleep(Math.floor(Math.random() * 200));
            if (!pollIsDue()) return; // someone else took this round while we jittered
            markPolled();             // stake the claim up front so others stand down
            await sleep(150);
            const last = readLastPoll();
            if (!last || last.tabId !== TAB_ID) return; // lost the race — back off
            await pollMyUnacknowledged();
            markPolled();             // measure the next interval from completion
        } finally {
            pollInFlight = false;
        }
    }

    if (IS_SNOW_HOST) {
        // Warm the session token before the first request goes out, so the opening
        // poll can't be the thing that provokes a credential prompt. Deliberately not
        // awaited around the tick below — a slow /blank.do scrape shouldn't delay the
        // schedule, and snFetch awaits the same cached promise anyway.
        getSessionToken().then(token => {
            if (!token) markSessionBroken('No ServiceNow session token found on this page.');
        });

        // The tick is much shorter than POLL_MS: it's just "is a poll overdue?", and a
        // fast tick is what keeps takeover from a dead tab prompt.
        setInterval(pollCycle, CONFIG.POLL_TICK_MS);
        pollCycle();

        // Returning to a tab is when a stale view is most visible, and it's also when
        // this tab becomes the preferred poller — so check immediately instead of
        // waiting out the tick.
        document.addEventListener('visibilitychange', () => {
            if (isVisible()) pollCycle();
        });
    }

    // ─── DEBUG HELPERS (console) ────────────────────────────────────────────
    window.__ackMonitorDebug = {
        forcePoll() {
            if (!IS_SNOW_HOST) { console.warn('[ACK Monitor] forcePoll only works on a SNOW tab.'); return; }
            console.log('[ACK Monitor] forcing an immediate poll (bypassing leadership).');
            pollMyUnacknowledged();
        },
        // Answers "is anything actually polling?" — shows who ran the last poll and
        // how long ago. Any tab may run the next one; there's no fixed owner.
        pollStatus() {
            const last = readLastPoll();
            console.log('[ACK Monitor] last poll:', last,
                '| age(ms):', last ? Date.now() - last.ts : null,
                '| this tab:', TAB_ID, '| wasMe:', !!last && last.tabId === TAB_ID,
                '| due now:', pollIsDue());
            return last;
        },
        // Answers "is this page making the popup a different size?" — 1 means the page
        // is not scaling anything and the card is exactly CONFIG.POPUP_WIDTH wide.
        pageScale() {
            const compensation = getPageScale();
            const el = document.querySelector('.sdmPopup');
            return {
                pageScales: +(1 / compensation).toFixed(3),
                compensation: +compensation.toFixed(3),
                renderedWidth: el ? Math.round(el.getBoundingClientRect().width) : null,
                expected: CONFIG.POPUP_WIDTH
            };
        },
        // Sound triage: state 'running' means the browser is letting us play. A
        // 'suspended' that survives a click on the page is the autoplay policy, not
        // a bug here — and testSound() will say so rather than failing quietly.
        audio() {
            const ctx = getAudioCtx();
            return { enabled: CONFIG.SOUND_ENABLED, state: ctx ? ctx.state : 'unsupported' };
        },
        testSound() { playAlertSound(); return this.audio(); },
        // Watch an acknowledge happen. Runs the real flow with the frame on screen and
        // a step-by-step trace in the console — the only way to see which step a
        // stubborn instance stops at, since the whole thing normally happens off-screen.
        // Call with no arguments to use the ticket currently alerting.
        ackDebug(sysId) {
            if (!IS_SNOW_HOST) { console.warn('[ACK Monitor] ackDebug only works on a SNOW tab.'); return; }
            const state = getState();
            const entry = sysId ? state[sysId] : Object.values(state).find(e => e.status === 'pending');
            if (!entry || !entry.ticket) {
                console.warn('[ACK Monitor] no pending ticket to debug — pass a sys_id, e.g. ackDebug("abc123…").');
                return;
            }
            console.log(`[ACK Monitor] ackDebug on ${entry.ticket.number} (${entry.ticket.sys_id}) — the frame stays on screen for 30s.`);
            return acknowledgeViaHiddenIframe(entry.ticket.table, entry.ticket.sys_id, { visible: true, timeoutMs: 60000 })
                .then(() => console.log('[ACK Monitor] ackDebug: acknowledged.'))
                .catch(e => console.error('[ACK Monitor] ackDebug failed:', e.message));
        },
        // Auth triage: if a credential prompt ever comes back, check here first —
        // a null token is the cause, not a symptom.
        session() { return { token: sessionToken, broken: sessionBroken, snowHost: IS_SNOW_HOST }; },
        refreshToken() { return getSessionToken(true); },
        reconnect: reconnectSession
    };
})();
