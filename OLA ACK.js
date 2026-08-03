// ==UserScript==
// @name         SD Monitor - Live Acknowledge Popup
// @namespace    geodis-sd-monitor
// @version      0.12
// @description  Cross-site synced live alert for unacknowledged tickets; full function on ServiceNow, mirrored popups elsewhere
// @homepageURL  https://github.com/Nazimjaja/SD-Monitor---Lead-Assignment
// @updateURL    https://raw.githubusercontent.com/Nazimjaja/SD-Monitor---Lead-Assignment/main/OLA%20ACK.js
// @downloadURL  https://raw.githubusercontent.com/Nazimjaja/SD-Monitor---Lead-Assignment/main/OLA%20ACK.js
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
    console.log(`[ACK Monitor] loaded on ${location.hostname} — mode: ${IS_SNOW_HOST ? 'SNOW (full)' : 'mirror-only'}`);

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
    function acknowledgeViaHiddenIframe(table, sysId, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;bottom:0;right:0;';
            iframe.src = `/${table}.do?sys_id=${sysId}&sysparm_stack=no`;

            let settled = false;
            let clicked = false;

            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error('Timed out waiting for the Acknowledge button/confirmation.'));
            }, timeoutMs);

            function cleanup() {
                clearTimeout(timer);
                setTimeout(() => iframe.remove(), 500);
            }

            function attemptClick(doc) {
                const btn = findAckButton(doc);
                if (!btn) {
                    settled = true;
                    cleanup();
                    reject(new Error('Acknowledge button not found — ticket may already be acknowledged.'));
                    return;
                }
                if (btn.disabled) {
                    settled = true;
                    cleanup();
                    reject(new Error('Acknowledge button still disabled after filling mandatory fields — check Impact/Work notes requirements.'));
                    return;
                }
                clicked = true;
                btn.click();
            }

            iframe.addEventListener('load', () => {
                if (settled) return;
                try {
                    const doc = iframe.contentDocument;
                    // An expired session serves the SSO login page here instead of the
                    // ticket form. Without this it reads as "Acknowledge button not
                    // found — may already be acknowledged", which sends people looking
                    // at the ticket rather than at their session.
                    if (!clicked && looksLikeLoginPage(doc.documentElement?.innerHTML || '')) {
                        settled = true;
                        cleanup();
                        markSessionBroken('ServiceNow served a sign-in page instead of the ticket form.');
                        reject(new SessionError('The ServiceNow session has expired — sign in again, then Reconnect.'));
                        return;
                    }
                    if (!clicked) {
                        fillMandatoryAckFields(doc, table);
                        // Give the page's own change handlers/validation a moment to
                        // process before we check the button and click it.
                        setTimeout(() => { if (!settled) attemptClick(doc); }, 800);
                    } else {
                        settled = true;
                        cleanup();
                        resolve(true);
                    }
                } catch (e) {
                    settled = true;
                    cleanup();
                    reject(new Error('Iframe access error: ' + e.message));
                }
            });

            document.body.appendChild(iframe);
        });
    }

    async function acknowledgeTicket(table, sysId, userId) {
        await assignRecord(table, sysId, userId);
        await acknowledgeViaHiddenIframe(table, sysId);
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
        .sdmPopup {
            position: fixed !important;
            right: 18px !important;
            width: ${CONFIG.POPUP_WIDTH}px !important;
            background: rgba(255, 255, 255, 0.68) !important;
            backdrop-filter: blur(20px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
            border: 1px solid rgba(255, 255, 255, 0.45) !important;
            border-radius: 14px !important;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.06) !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            z-index: 999999 !important;
            padding: 14px 16px !important;
            margin: 0 !important;
            color: #1a1a2e !important;
            transition: top 0.25s ease !important;
        }
        .sdmPopup.sdmPending { border-left: 4px solid #e5484d !important; }
        .sdmPopup.sdmAcked   { border-left: 4px solid #2e9e5b !important; }
        .sdmPopup h3 {
            margin: 0 0 4px 0 !important; font-size: 14px !important; font-weight: 600 !important;
            letter-spacing: -0.01em !important; padding-right: 14px !important;
            color: #1a1a2e !important; line-height: 1.3 !important;
        }
        .sdmPopup .sdmMeta { font-size: 12px !important; color: rgba(26,26,46,0.65) !important; margin: 0 0 8px 0 !important; line-height: 1.4 !important; }
        .sdmPopup .sdmCountdown { font-size: 18px !important; font-weight: 700 !important; color: #e5484d !important; margin: 0 0 10px 0 !important; letter-spacing: 0.02em !important; }
        .sdmPopup .sdmCountdown.overdue { color: #b3261e !important; animation: sdmBlink 1s infinite !important; }
        @keyframes sdmBlink { 50% { opacity: 0.45; } }
        .sdmPopup button {
            width: 100% !important;
            padding: 8px !important;
            margin: 0 !important;
            background: rgba(46, 125, 50, 0.92) !important;
            color: white !important;
            border: none !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            font-weight: 500 !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            line-height: normal !important;
            cursor: pointer !important;
            box-shadow: none !important;
            transition: background 0.15s ease !important;
        }
        .sdmPopup button:hover { background: rgba(37, 100, 40, 0.95) !important; }
        .sdmPopup button:disabled { background: rgba(150,150,150,0.55) !important; cursor: default !important; }
        .sdmPopup .sdmOpenBtn { background: rgba(59, 130, 246, 0.9) !important; margin-top: 8px !important; }
        .sdmPopup .sdmOpenBtn:hover { background: rgba(37, 99, 235, 0.95) !important; }
        .sdmPopup .sdmError { color: #b3261e !important; font-size: 11px !important; margin: 6px 0 0 0 !important; }
        .sdmPopup .sdmSuccess { color: #1a1a2e !important; font-size: 13px !important; font-weight: 600 !important; padding: 2px 0 8px 0 !important; margin: 0 !important; }
        .sdmPopup .sdmCloseX {
            position: absolute !important; top: 10px !important; right: 12px !important; cursor: pointer !important;
            font-size: 13px !important; color: rgba(26,26,46,0.4) !important; line-height: 1 !important;
        }
        .sdmPopup .sdmCloseX:hover { color: rgba(26,26,46,0.8) !important; }

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
            + `<button class="sdmReconnectBtn" type="button">Reconnect</button>`;
        document.body.appendChild(statusEl);
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
    // Note: browsers block audio until the page has had some user interaction
    // (click/keypress). Since agents are actively working the SNOW page, this
    // should already be satisfied in practice, but it's worth knowing if a
    // popup's very first sound seems to silently not play after a fresh load.
    let audioCtx = null;
    function playAlertSound() {
        if (!CONFIG.SOUND_ENABLED) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const now = audioCtx.currentTime;
            [880, 1108].forEach((freq, i) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                const t0 = now + i * 0.15;
                gain.gain.setValueAtTime(0, t0);
                gain.gain.linearRampToValueAtTime(0.15, t0 + 0.02);
                gain.gain.linearRampToValueAtTime(0, t0 + 0.18);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(t0);
                osc.stop(t0 + 0.2);
            });
        } catch (e) {
            console.warn('[ACK Monitor] could not play alert sound', e);
        }
    }

    // ─── POPUP STACKING (runs on every page — mirrors included) ─────────────
    const popupsBySysId = new Map();

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
        popup.remove();
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

        const closeX = document.createElement('span');
        closeX.className = 'sdmCloseX';
        closeX.title = 'Dismiss';
        closeX.textContent = '✕';

        const success = document.createElement('div');
        success.className = 'sdmSuccess';
        success.textContent = `✅ ${ticket.number} acknowledged by ${ackedByName}`;

        const openBtn = document.createElement('button');
        openBtn.className = 'sdmOpenBtn';
        openBtn.textContent = '🔗 Open Ticket';

        popup.append(closeX, success, openBtn);

        closeX.addEventListener('click', () => {
            removePopup(ticket.sys_id);
            publishEvent({ type: 'TICKET_REMOVED', sys_id: ticket.sys_id });
        });
        openBtn.addEventListener('click', () => {
            const base = ticket.origin || (IS_SNOW_HOST ? location.origin : '');
            if (base) {
                window.open(`${base}/${ticket.table}.do?sys_id=${ticket.sys_id}&sysparm_stack=no`, '_blank');
            } else {
                console.warn('[ACK Monitor] no known SNOW origin for this ticket — cannot open it from here.');
            }
        });

        popup._closeTimer = setTimeout(() => removePopup(ticket.sys_id), Math.max(remainingMs, 0));
        relayoutPopups();
    }

    function handleAckError(sysId, message) {
        const popup = popupsBySysId.get(sysId);
        if (!popup) return;
        if (popup._ackRequestTimeout) clearTimeout(popup._ackRequestTimeout);
        const ackBtn = popup.querySelector('.sdmAckBtn');
        const errorEl = popup.querySelector('.sdmError');
        if (ackBtn) { ackBtn.disabled = false; ackBtn.textContent = 'Acknowledged'; }
        if (errorEl) { errorEl.textContent = `❌ ${message}`; errorEl.style.display = 'block'; }
        relayoutPopups();
    }

    function showPendingPopup(ticket, { broadcast = true, playSound = true, shownAt = Date.now() } = {}) {
        if (popupsBySysId.has(ticket.sys_id)) return;

        // Built node-by-node with textContent rather than an innerHTML template:
        // ticket.number/short_desc are server-supplied strings that end up rendered
        // on every domain this script runs on, so they must never be parsed as HTML.
        const popup = document.createElement('div');
        popup.className = 'sdmPopup sdmPending';

        const title = document.createElement('h3');
        title.textContent = `🎫 ${ticket.number}`;

        const meta = document.createElement('div');
        meta.className = 'sdmMeta';
        meta.textContent = `${ticket.short_desc}${ticket.priority ? ' · ' + ticket.priority : ''}`;

        const countdownEl = document.createElement('div');
        countdownEl.className = 'sdmCountdown';

        const ackBtn = document.createElement('button');
        ackBtn.className = 'sdmAckBtn';
        ackBtn.textContent = 'Acknowledged';

        const errorEl = document.createElement('div');
        errorEl.className = 'sdmError';
        errorEl.style.display = 'none';

        popup.append(title, meta, countdownEl, ackBtn, errorEl);
        document.body.appendChild(popup);
        popupsBySysId.set(ticket.sys_id, popup);
        if (playSound) playAlertSound();

        // The countdown is derived from shownAt (when the ticket first alerted)
        // rather than from when this particular popup was built, so a tab that
        // opens or reloads mid-alert shows the same time remaining as every other
        // tab instead of restarting at the full duration.
        function renderCountdown() {
            const remaining = CONFIG.COUNTDOWN_SECONDS - Math.floor((Date.now() - shownAt) / 1000);
            if (remaining <= 0) {
                countdownEl.textContent = 'OVERDUE';
                countdownEl.classList.add('overdue');
                if (popup._countdownTimer) {
                    clearInterval(popup._countdownTimer);
                    popup._countdownTimer = null;
                }
                return;
            }
            const mm = String(Math.floor(remaining / 60)).padStart(2, '0');
            const ss = String(remaining % 60).padStart(2, '0');
            countdownEl.textContent = `${mm}:${ss}`;
        }
        renderCountdown();
        relayoutPopups();
        if (!countdownEl.classList.contains('overdue')) {
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
                ackBtn.textContent = 'Acknowledging...';
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
                    ackBtn.textContent = 'Acknowledged';
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
                ackBtn.textContent = 'Acknowledging...';
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
        // Auth triage: if a credential prompt ever comes back, check here first —
        // a null token is the cause, not a symptom.
        session() { return { token: sessionToken, broken: sessionBroken, snowHost: IS_SNOW_HOST }; },
        refreshToken() { return getSessionToken(true); },
        reconnect: reconnectSession
    };
})();