// ==UserScript==
// @name         SD Monitor - OLA Breach Warning
// @namespace    geodis-sd-monitor
// @version      0.4
// @description  Warns every SD agent when a group ticket's resolution OLA crosses 50% and 75%, and lets whoever is free take it over on the spot
// @homepageURL  https://github.com/Nazimjaja/SD-Monitor---Lead-Assignment
// @updateURL    https://raw.githubusercontent.com/Nazimjaja/SD-Monitor---Lead-Assignment/main/OLA%20Watch.user.js
// @downloadURL  https://raw.githubusercontent.com/Nazimjaja/SD-Monitor---Lead-Assignment/main/OLA%20Watch.user.js
// @changelog    0.4 - This script had NO @updateURL/@downloadURL and was named OLA Watch.js —
//                     without the .user.js suffix, Tampermonkey never offers an install prompt
//                     for the raw GitHub link, and without an @updateURL it has no way to notice
//                     new versions even if manually installed once. Every fix in 0.2/0.3 may
//                     never have reached an already-installed copy. Renamed to OLA Watch.user.js
//                     and added the same @updateURL/@downloadURL/@homepageURL the ACK monitor
//                     carries (it hit this exact bug once — see its history) — but note that an
//                     existing install still needs to be removed and reinstalled from the new
//                     raw URL ONCE, since a script with no @updateURL has nothing to check
//                     against and can't discover this fix on its own.
//                     Added a persistent Favorites entry — a sibling <sn-collapsible-list>
//                     appended into the real nav body after the existing favourites, structured
//                     the same way (a <ul class="sn-polaris-nav-list-items"> with one <li> inside
//                     an open shadow root) — so OLA Watch has a permanent, native-feeling place
//                     in the nav instead of depending entirely on the conditionally-shown overlay
//                     panel. Its badge always shows the live at-risk count, and clicking it
//                     toggles the overlay open regardless of whether anything is currently at
//                     risk. `sn-collapsible-list` may already be a real registered SNOW component
//                     with its own constructor — if attachShadow rejects because one was already
//                     attached, this falls back to a plain wrapper element rather than rendering
//                     nothing.
// @changelog    0.3 - Fixed the same auth-cookie bug the ACK monitor hit in its own 0.11: every
//                     GET here was sent with no session token at all, and the one PATCH sent
//                     `g_ck || ''` — an explicitly empty token, which ServiceNow treats as a
//                     *failed* check and answers with 401 + WWW-Authenticate: BASIC, popping the
//                     browser's native credential dialog every poll cycle. All requests now go
//                     through snFetch, which reads g_ck from every place it can live, retries
//                     once on a rejected token, recognises an SSO login page served as a 200, and
//                     stands the tab down after a genuine failure instead of re-provoking the
//                     dialog — the ⟳ button gives a broken session one fresh reconnect attempt.
//                     Also fixed the panel's dock position: it was a flat guess (left:0, a fixed
//                     248px) instead of anchored to anything real. syncPanelDock() now reads
//                     `.sn-polaris-nav[aria-label="Favorites menu"]`'s actual
//                     getBoundingClientRect() every second and pins left/width/bottom to match
//                     it, so the panel sits flush against the real Favorites nav — rail or
//                     expanded — rather than wherever left:0/248px happened to land.
// @changelog    0.2 - Tracking INC-RES-CORP-SD (was INC_OLA_RES_SD). The OLA's clock is
//                     FR M-F 08:00–19:00 Europe/Paris, excluding French public holidays, so
//                     computePct now measures elapsed and total window in business
//                     milliseconds (businessMsBetween) instead of raw wall-clock — a window
//                     that spans a close-of-business or a weekend no longer reads as more
//                     consumed than it actually is. CET/CEST is read from Intl at the instant
//                     in question rather than a fixed offset, and holidays (fixed dates plus
//                     the Easter-derived ones) are computed algorithmically so they don't need
//                     yearly upkeep. A window with zero business hours in it — e.g. entirely on
//                     a holiday — falls back to serverPct rather than dividing by zero.
// @changelog    0.1 - First release. Polls task_sla for the group's running INC_OLA_RES_SD
//                     instances, derives the clock locally from planned_end_time rather than
//                     trusting the stored percentage, and raises one OS notification per
//                     ticket per threshold. Polling and the fired-threshold ledger are both
//                     shared through GM storage, so N open SNOW tabs still means one poll and
//                     one notification. Paused and completed SLAs are filtered out server-side
//                     so a ticket parked on "awaiting user info" stops warning. Take-over is
//                     check-then-write against the assignee the agent actually saw, so two
//                     agents clicking seconds apart can't both believe they got it.
// @match        *://*.service-now.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        GM_notification
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // Sandboxed mode (any non-"none" @grant) isolates `window` from the real page,
    // and SNOW's globals (g_ck, g_user_id, NOW) live on the real page.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ─── CONFIG ─────────────────────────────────────────────────────────────
    const CONFIG = {
        ASSIGNMENT_GROUP: 'CORP-SD',

        // The OLA definition name in contract_sla. A task carries several SLA/OLA/UC
        // instances at once (response, resolution, underpinning contracts), so this
        // name is what narrows task_sla down to the single clock we care about.
        // If the panel reports 0 rows on a ticket you know is running, this string is
        // the first thing to check — see __olaWatchDebug.listSlaNames().
        OLA_NAME: 'INC-RES-CORP-SD',

        // The OLA's business schedule: (Geo) FR, Mon–Fri 08:00–19:00, Europe/Paris
        // (CET/CEST — handled below via Intl, not a fixed UTC offset), excluding
        // French public holidays. Drives computePct's business-time math, below.
        SCHEDULE: {
            TIMEZONE: 'Europe/Paris',
            WORKDAYS: [1, 2, 3, 4, 5], // getUTCDay(): 0=Sun … 6=Sat
            START_HOUR: 8, START_MINUTE: 0,
            END_HOUR: 19, END_MINUTE: 0
        },

        // Server-side stage filter. `in_progress` deliberately excludes:
        //   paused    — ticket parked on "awaiting user info"; the clock is stopped, so
        //               warning about it is noise and would keep firing forever
        //   completed / cancelled / breached — nothing left to save
        // Widen this (e.g. 'stageIN in_progress,paused') only if you actually want
        // parked tickets on screen; the percentage shown for a paused SLA is frozen.
        STAGE_FILTER: 'stage=in_progress',

        // Percent-of-OLA-consumed points that raise an alert. Each fires once per
        // ticket. Add 90 here if you want a last call before the breach.
        THRESHOLDS: [50, 75],

        // 30s against a 60-minute OLA is 0.8% of the window — fine granularity, and
        // low enough load that N agents polling all day is invisible.
        POLL_MS: 30000,
        POLL_TICK_MS: 5000,
        HIDDEN_TAB_GRACE_MS: 4000,

        // How long a fired-threshold record survives after its SLA stops coming back
        // in the query. Long enough that one failed or empty poll can't wipe the
        // ledger and re-fire every alert on the next round.
        LEDGER_TTL_MS: 10 * 60 * 1000,

        ROW_LIMIT: 100,
        SOUND_ENABLED: true,
        NOTIFY_ENABLED: true,

        // Docked to the bottom of the left nav, not floating. The right-hand edge is
        // already triple-booked (ACK monitor popups stack down right:18; the
        // assignment dashboard sits at top:70/right:18), and the nav's lower half is
        // dead space once favourites are listed. 248px is the EXPANDED nav width —
        // agents keep it expanded, so this is the width to design for, not the rail.
        //
        // It is position:fixed over the nav rather than appended into it: the Next
        // Experience nav lives behind a web-component shadow root and re-renders on
        // navigation, which would eject an injected node. Overlaying costs nothing
        // and survives. syncPanelDock() reads the REAL nav container's
        // getBoundingClientRect() every second and pins left/width/bottom to match
        // it via .style.setProperty(..., 'important') — so the panel sits flush
        // against wherever the Favorites nav (`.sn-polaris-nav[aria-label="Favorites
        // menu"]`) actually is, rail or expanded, instead of assuming a fixed
        // 248px at the viewport's left edge. PANEL_WIDTH below is only the
        // fallback used on a page where that nav element isn't found at all.
        PANEL_WIDTH: 248
    };

    const TAB_ID = Date.now() + '-' + Math.random().toString(36).slice(2);

    // ─── SESSION / AUTHENTICATION ────────────────────────────────────────────
    // Every request rides the browser's existing SSO session cookies — never a
    // credential prompt. But a cookie alone is NOT enough: ServiceNow rejects a
    // session-authenticated API call that arrives without the session token
    // (g_ck) in X-UserToken, and answers that rejection with "401 + WWW-
    // Authenticate: BASIC" — the exact header that makes the browser throw up
    // its native username/password dialog, which no SSO login can ever satisfy.
    // The earlier version of this script sent no token at all on its GET
    // requests (`fetch(url)`, nothing more) and `g_ck || ''` — an explicitly
    // empty token, which SNOW treats as a *failed* check, worse than none — on
    // its one PATCH. A poll on a 30s timer that keeps doing that re-provokes
    // the dialog every cycle forever. This mirrors the fix the ACK monitor
    // needed for the same bug (its 0.11): every request goes through snFetch,
    // which always attaches a real token and stands the tab down on the first
    // genuine auth failure instead of retrying into another prompt.
    class SessionError extends Error {
        constructor(message) { super(message); this.name = 'SessionError'; }
    }

    let sessionToken = null;
    let sessionTokenPromise = null;
    let sessionBroken = false;

    // Where g_ck lives depends on which UI you're on: a global in UI16, hung off
    // the NOW namespace in Next Experience, and in a hidden form field on plain
    // .do pages. Checking all of them is what keeps this from silently degrading
    // to an empty (worse-than-none) token.
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

    // Fallback for UIs that expose g_ck nowhere reachable: scrape it out of a
    // page fetched with the session cookies. A bare fetch, deliberately — it
    // must not route through snFetch, which would need a token to run and recurse.
    async function tokenFromBlankPage() {
        const r = await fetch('/blank.do', { credentials: 'same-origin', cache: 'no-store' });
        if (!r.ok) return null;
        const text = await r.text();
        const m = /(?:var\s+g_ck\s*=|["']g_ck["']\s*:)\s*["']([^"']{32,})["']/.exec(text);
        return m ? m[1] : null;
    }

    async function getSessionToken(forceRefresh = false) {
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

    // A dead SSO session usually arrives as a redirect to the IdP rather than a
    // 401 — i.e. a 200 full of HTML. Without this it reaches r.json() and
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
        setStatus(`Session expired (${reason}) — click ⟳ to reconnect`, true);
        console.warn('[OLA Watch] session broken:', reason);
    }

    // Single funnel for every ServiceNow call, so the cookie/token/redirect
    // handling can't drift apart between the read and write paths the way it did
    // before (GETs sending nothing, the one PATCH sending an empty token).
    async function snFetch(path, { method = 'GET', body = null, headers = {} } = {}) {
        if (sessionBroken) {
            throw new SessionError('Paused — the ServiceNow session needs re-authenticating.');
        }

        const send = token => {
            const h = Object.assign({
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                // Ask SNOW to answer an expired session with a 401 body instead of
                // 302-ing into the SSO login flow — following that redirect is both
                // how HTML ends up parsed as JSON and an extra chance for the
                // browser's own auth challenge to fire.
                'X-No-Response-Redirect': 'true'
            }, headers);
            if (token) h['X-UserToken'] = token; // never an empty token — see class comment above
            return fetch(path, {
                method, headers: h, body,
                credentials: 'same-origin', // the SSO cookies are the whole auth story
                cache: 'no-store',
                redirect: 'follow'
            });
        };

        const token = await getSessionToken();
        let r = await send(token);

        // A rejected token is recoverable — the page may have been open across a
        // session renewal — so re-read g_ck and retry exactly once. A second
        // failure means the session itself is gone.
        if (r.status === 401 || r.status === 403) {
            const fresh = await getSessionToken(true);
            if (fresh && fresh !== token) r = await send(fresh);
        }
        if (r.status === 401 || r.status === 403 || r.headers.get('X-Is-Logged-In') === 'false') {
            markSessionBroken(`HTTP ${r.status}`);
            throw new SessionError('Not signed in to ServiceNow, or the session token is no longer valid.');
        }

        if (r.ok && !/json/i.test(r.headers.get('content-type') || '')) {
            const text = await r.text();
            if (looksLikeLoginPage(text)) {
                markSessionBroken('SSO returned its sign-in page');
                throw new SessionError('The ServiceNow session has expired — SSO returned its login page.');
            }
            throw new Error(`Expected JSON from ${path}, got ${r.headers.get('content-type') || 'no content-type'}.`);
        }
        return r;
    }

    // ─── SNOW HELPERS ────────────────────────────────────────────────────────
    function getMyId()      { return pageWindow.NOW?.user?.userID || pageWindow.g_user_id || ''; }
    function getMyName()    { return pageWindow.NOW?.user?.fullName || pageWindow.g_user_name || 'You'; }

    async function jFetch(table, query, limit = 20) {
        const r = await snFetch(`/${table}_list.do?JSONv2&sysparm_action=getRecords&sysparm_query=${query}&sysparm_limit=${limit}`);
        if (!r.ok) throw new Error(`${table}: HTTP ${r.status}`);
        return (await r.json()).records || [];
    }

    // ─── ASSIGNMENT GROUP sys_id (cached after first lookup) ────────────────
    // Resolved rather than dot-walked as `task.assignment_group.name=CORP-SD`
    // because a wrong/renamed group has to fail loudly. A two-level dot-walk that
    // matches nothing returns an empty result set, which in an alerting tool is
    // indistinguishable from "nothing is at risk" — the worst possible failure.
    let groupSysId = null;
    async function resolveGroupSysId() {
        if (groupSysId) return groupSysId;
        const records = await jFetch('sys_user_group', `name=${encodeURIComponent(CONFIG.ASSIGNMENT_GROUP)}`, 1);
        if (!records.length) throw new Error(`Group "${CONFIG.ASSIGNMENT_GROUP}" not found — check CONFIG.ASSIGNMENT_GROUP.`);
        groupSysId = records[0].sys_id;
        return groupSysId;
    }

    // ─── OLA ROWS ────────────────────────────────────────────────────────────
    // The Table API (not JSONv2) specifically because it supports dot-walking in
    // sysparm_fields — one request gets the SLA clock *and* the ticket's number,
    // class, assignee and description, instead of a second round trip per ticket.
    const OLA_FIELDS = [
        'sys_id', 'stage', 'percentage', 'has_breached', 'start_time', 'planned_end_time',
        'sla.name',
        'task.sys_id', 'task.number', 'task.sys_class_name',
        'task.short_description', 'task.assigned_to', 'task.priority'
    ].join(',');

    // sysparm_display_value=all returns every field as { value, display_value }.
    // We want both: `value` for sys_ids and for timestamps (always UTC on the Table
    // API, unlike JSONv2 which can be configured either way), `display_value` for
    // the human name to show when someone else has taken a ticket.
    function fieldVal(rec, key) {
        const f = rec[key];
        if (f == null) return '';
        return typeof f === 'object' ? (f.value ?? '') : f;
    }
    function fieldDisplay(rec, key) {
        const f = rec[key];
        if (f == null) return '';
        return typeof f === 'object' ? (f.display_value ?? f.value ?? '') : f;
    }

    async function fetchOlaRows(gid) {
        const query = [
            `sla.name=${CONFIG.OLA_NAME}`,
            'active=true',
            CONFIG.STAGE_FILTER,
            `task.assignment_group=${gid}`
        ].join('^');

        const url = `/api/now/table/task_sla`
            + `?sysparm_query=${encodeURIComponent(query)}`
            + `&sysparm_fields=${encodeURIComponent(OLA_FIELDS)}`
            + `&sysparm_display_value=all`
            + `&sysparm_limit=${CONFIG.ROW_LIMIT}`;

        const r = await snFetch(url);
        if (!r.ok) throw new Error(`task_sla: HTTP ${r.status} — ${(await r.text()).slice(0, 120)}`);
        const records = (await r.json())?.result || [];

        return records.map(rec => ({
            slaSysId:    fieldVal(rec, 'sys_id'),
            stage:       fieldVal(rec, 'stage'),
            serverPct:   parseFloat(fieldVal(rec, 'percentage')) || 0,
            hasBreached: String(fieldVal(rec, 'has_breached')) === 'true',
            start:       fieldVal(rec, 'start_time'),
            plannedEnd:  fieldVal(rec, 'planned_end_time'),
            table:       fieldVal(rec, 'task.sys_class_name') || 'task',
            taskSysId:   fieldVal(rec, 'task.sys_id'),
            number:      fieldDisplay(rec, 'task.number'),
            shortDesc:   fieldDisplay(rec, 'task.short_description'),
            priority:    fieldDisplay(rec, 'task.priority'),
            assignee:    fieldVal(rec, 'task.assigned_to'),
            assigneeName: fieldDisplay(rec, 'task.assigned_to')
        })).filter(row => row.slaSysId && row.taskSysId);
    }

    // ─── BUSINESS SCHEDULE (FR M-F 08:00–19:00 Europe/Paris, ex. FR holidays) ─
    // computePct needs "how much of the OLA's business window has elapsed", and
    // that requires knowing which wall-clock hours in Paris count as business
    // hours for any given UTC instant — including the CET/CEST flip, which a
    // fixed offset can't represent. Intl.DateTimeFormat with timeZone carries
    // the IANA rules (including future DST changes), so the offset is asked for
    // rather than hard-coded.
    function computeEasterSunday(year) {
        // Anonymous Gregorian algorithm (Meeus/Jones/Butcher). French holidays
        // that move with Easter (Easter Monday, Ascension, Whit Monday) are
        // derived from this rather than hand-maintained per year.
        const a = year % 19, b = Math.floor(year / 100), c = year % 100;
        const d = Math.floor(b / 4), e = b % 4;
        const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
        const h = (19 * a + b - d - g + 15) % 30;
        const i = Math.floor(c / 4), k = c % 4;
        const l = (32 + 2 * e + 2 * i - h - k) % 7;
        const m = Math.floor((a + 11 * h + 22 * l) / 451);
        const month = Math.floor((h + l - 7 * m + 114) / 31);
        const day = ((h + l - 7 * m + 114) % 31) + 1;
        return { year, month, day };
    }

    function ymd(year, month, day) {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }

    // Pure calendar-number arithmetic (a Date built from Date.UTC and stepped in
    // UTC days) — deliberately not a real Paris instant, so DST never perturbs
    // "what's tomorrow's date".
    function addCalendarDays(year, month, day, n) {
        const d = new Date(Date.UTC(year, month - 1, day) + n * 86400000);
        return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    }

    const holidayCache = new Map();
    function frenchHolidaysForYear(year) {
        let set = holidayCache.get(year);
        if (set) return set;
        const easter = computeEasterSunday(year);
        const mon  = addCalendarDays(easter.year, easter.month, easter.day, 1);  // Easter Monday
        const asc  = addCalendarDays(easter.year, easter.month, easter.day, 39); // Ascension
        const whit = addCalendarDays(easter.year, easter.month, easter.day, 50); // Whit Monday
        set = new Set([
            ymd(year, 1, 1),                        // New Year's Day
            ymd(mon.year, mon.month, mon.day),       // Easter Monday
            ymd(year, 5, 1),                         // Labour Day
            ymd(year, 5, 8),                         // Victory in Europe Day
            ymd(asc.year, asc.month, asc.day),       // Ascension
            ymd(whit.year, whit.month, whit.day),    // Whit Monday
            ymd(year, 7, 14),                        // Bastille Day
            ymd(year, 8, 15),                        // Assumption
            ymd(year, 11, 1),                        // All Saints
            ymd(year, 11, 11),                       // Armistice Day
            ymd(year, 12, 25)                        // Christmas
        ]);
        holidayCache.set(year, set);
        return set;
    }
    function isFrenchHoliday(year, month, day) {
        return frenchHolidaysForYear(year).has(ymd(year, month, day));
    }

    // Minutes to add to UTC to get Paris local time at this instant (+60 CET,
    // +120 CEST). Read from Intl rather than guessed, so the switch date is
    // whatever the IANA tz database says, not a hard-coded "last Sunday of March".
    function parisOffsetMinutesAt(utcMs) {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: CONFIG.SCHEDULE.TIMEZONE, hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
        const map = {};
        dtf.formatToParts(new Date(utcMs)).forEach(p => { map[p.type] = p.value; });
        const hh = map.hour === '24' ? '00' : map.hour; // some engines format midnight as 24
        const asUtc = Date.UTC(+map.year, +map.month - 1, +map.day, +hh, +map.minute, +map.second);
        return (asUtc - utcMs) / 60000;
    }

    function parisDateParts(utcMs) {
        const dtf = new Intl.DateTimeFormat('en-US', {
            timeZone: CONFIG.SCHEDULE.TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit'
        });
        const map = {};
        dtf.formatToParts(new Date(utcMs)).forEach(p => { map[p.type] = p.value; });
        return { year: +map.year, month: +map.month, day: +map.day };
    }

    // Inverse of the above: the UTC instant for a given Paris local wall-clock
    // time. Guesses the offset from a same-instant UTC reading, then re-checks —
    // the only case that could disagree is the same calendar day's DST flip,
    // which never lands inside an 08:00–19:00 window, but the re-check is cheap
    // and removes the assumption.
    function parisLocalToUtc(year, month, day, hour, minute) {
        const guess = Date.UTC(year, month - 1, day, hour, minute);
        const off1 = parisOffsetMinutesAt(guess);
        let utcMs = guess - off1 * 60000;
        const off2 = parisOffsetMinutesAt(utcMs);
        if (off2 !== off1) utcMs = guess - off2 * 60000;
        return utcMs;
    }

    function isBusinessDay(year, month, day) {
        const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
        if (!CONFIG.SCHEDULE.WORKDAYS.includes(dow)) return false;
        return !isFrenchHoliday(year, month, day);
    }

    // Business milliseconds between two UTC instants: walks Paris calendar days
    // between them and sums each day's overlap with the 08:00–19:00 window,
    // skipping weekends and French holidays entirely. Capped at 400 iterations
    // (~13 months) so a bad timestamp can't spin this forever.
    function businessMsBetween(startMs, endMs) {
        if (endMs <= startMs) return 0;
        let total = 0;
        let d = parisDateParts(startMs);
        for (let i = 0; i < 400; i++) {
            const dayStart = parisLocalToUtc(d.year, d.month, d.day, CONFIG.SCHEDULE.START_HOUR, CONFIG.SCHEDULE.START_MINUTE);
            const dayEnd   = parisLocalToUtc(d.year, d.month, d.day, CONFIG.SCHEDULE.END_HOUR, CONFIG.SCHEDULE.END_MINUTE);
            if (isBusinessDay(d.year, d.month, d.day)) {
                const overlapStart = Math.max(startMs, dayStart);
                const overlapEnd = Math.min(endMs, dayEnd);
                if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
            }
            if (dayStart >= endMs) break;
            d = addCalendarDays(d.year, d.month, d.day, 1);
            if (parisLocalToUtc(d.year, d.month, d.day, 0, 0) > endMs) break;
        }
        return total;
    }

    // ─── CLOCK MATH ──────────────────────────────────────────────────────────
    // Table API `value` timestamps are UTC, always — no CREATED_ON_IS_UTC-style
    // guessing needed here the way there is for JSONv2's sys_created_on.
    function parseSnowUtc(value) {
        if (!value) return null;
        const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value).trim());
        if (!m) {
            const t = Date.parse(value);
            return Number.isNaN(t) ? null : t;
        }
        const [Y, Mo, D, H, Mi, S] = m.slice(1).map(Number);
        return Date.UTC(Y, Mo - 1, D, H, Mi, S);
    }

    // Percentage is derived here rather than read from task_sla.percentage because
    // that field is a snapshot written by the SLA engine on task update and by a
    // scheduled job — it can lag by minutes. Against a 60-minute OLA a few minutes
    // of staleness is several percent of the whole window, which is enough to skip
    // a threshold entirely. planned_end_time is a fixed timestamp, so the live
    // number can be computed exactly.
    //
    // Schedule-aware: both the total window and the elapsed time are measured in
    // business milliseconds (FR M-F 08:00–19:00 Europe/Paris, excluding French
    // holidays) via businessMsBetween, not raw wall-clock ms. Plain wall-clock
    // division would read a ticket opened 18:50 against a 19:00 close as already
    // most of the way consumed, when almost none of its actual business window
    // has passed. nowMs is a parameter (defaulting to Date.now()) purely so the
    // self-test below can pin it rather than racing real time.
    function computePct(row, nowMs = Date.now()) {
        const s = parseSnowUtc(row.start);
        const e = parseSnowUtc(row.plannedEnd);
        if (s == null || e == null || e <= s) return row.serverPct || null;
        const totalBusinessMs = businessMsBetween(s, e);
        if (totalBusinessMs <= 0) return row.serverPct || null; // window has no business hours in it — can't be schedule-derived
        const elapsedBusinessMs = businessMsBetween(s, Math.min(nowMs, e));
        const pct = (elapsedBusinessMs / totalBusinessMs) * 100;
        return Math.min(100, Math.max(0, pct));
    }

    function msRemaining(row) {
        const e = parseSnowUtc(row.plannedEnd);
        return e == null ? null : e - Date.now();
    }

    function fmtRemaining(ms) {
        if (ms == null) return '—';
        if (ms <= 0) return 'BREACHED';
        const total = Math.floor(ms / 1000);
        const mm = String(Math.floor(total / 60)).padStart(2, '0');
        const ss = String(total % 60).padStart(2, '0');
        return `${mm}:${ss}`;
    }

    // Highest configured threshold this row has reached, or null. Thresholds are
    // sorted descending so the answer is the most severe one crossed, not the first.
    function crossedThreshold(pct) {
        if (pct == null) return null;
        const sorted = [...CONFIG.THRESHOLDS].sort((a, b) => b - a);
        return sorted.find(t => pct >= t) ?? null;
    }

    // ─── SHARED STATE (GM storage — one poll and one alert across N tabs) ────
    // Three keys, each solving a different multi-tab problem:
    //   LAST_POLL — who polled last and when, so only one tab does the fetching
    //   STATE     — the current at-risk row set, so every tab renders the same panel
    //               without polling itself
    //   LEDGER    — which (ticket, threshold) pairs have already alerted, so a
    //               notification fires once for the agent and not once per tab, and
    //               survives polling moving to a different tab
    const LAST_POLL_KEY = 'sdOlaWatch_lastPoll';
    const STATE_KEY     = 'sdOlaWatch_state';
    const LEDGER_KEY    = 'sdOlaWatch_ledger';
    const MUTE_KEY      = 'sdOlaWatch_muteUntil';

    function readJson(key, fallback) {
        try {
            const v = JSON.parse(GM_getValue(key, ''));
            return v == null ? fallback : v;
        } catch { return fallback; }
    }

    function getLedger() { return readJson(LEDGER_KEY, {}); }
    function setLedger(l) { GM_setValue(LEDGER_KEY, JSON.stringify(l)); }

    // Prune on lastSeen rather than "absent from this poll" on purpose. A single
    // failed or transiently empty fetch would otherwise clear the ledger, and the
    // next successful poll would re-fire every alert the agents already dismissed.
    function pruneLedger(ledger) {
        const cutoff = Date.now() - CONFIG.LEDGER_TTL_MS;
        Object.keys(ledger).forEach(id => {
            if ((ledger[id].lastSeen || 0) < cutoff) delete ledger[id];
        });
        return ledger;
    }

    function getSharedState() { return readJson(STATE_KEY, { rows: [], stamp: '', error: '' }); }
    function setSharedState(s) { GM_setValue(STATE_KEY, JSON.stringify(s)); }

    // Mute has to be SHARED, not per-tab. Only whichever tab won the poll raises
    // notifications, and that changes round to round — so a tab-local flag would
    // silence alerts only until polling moved elsewhere, which reads as "the mute
    // button randomly doesn't work". Timed rather than until-reload because someone
    // muting wants quiet for a while, and reloading SNOW is not a deliberate act.
    const MUTE_MS = 4 * 60 * 60 * 1000;
    function isMuted() { return Date.now() < (Number(readJson(MUTE_KEY, 0)) || 0); }
    function toggleMute() { GM_setValue(MUTE_KEY, JSON.stringify(isMuted() ? 0 : Date.now() + MUTE_MS)); }

    // ─── SOUND ───────────────────────────────────────────────────────────────
    // Synthesized rather than an external file so the script stays self-contained.
    // Browsers gate audio on prior user interaction with the page; an agent working
    // in SNOW has always satisfied that, but a freshly loaded untouched tab may
    // swallow the first beep. The OS notification is the real alert; this is a nudge.
    let audioCtx = null;
    function playAlertSound() {
        if (!CONFIG.SOUND_ENABLED) return;
        try {
            audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
            const now = audioCtx.currentTime;
            [660, 880].forEach((freq, i) => {
                const osc = audioCtx.createOscillator();
                const gain = audioCtx.createGain();
                osc.type = 'sine';
                osc.frequency.value = freq;
                const t0 = now + i * 0.18;
                gain.gain.setValueAtTime(0, t0);
                gain.gain.linearRampToValueAtTime(0.16, t0 + 0.02);
                gain.gain.linearRampToValueAtTime(0, t0 + 0.22);
                osc.connect(gain).connect(audioCtx.destination);
                osc.start(t0);
                osc.stop(t0 + 0.24);
            });
        } catch (e) {
            console.warn('[OLA Watch] could not play alert sound', e);
        }
    }

    // GM_notification rather than the web Notification API: it needs no permission
    // prompt, and it surfaces at OS level so it reaches an agent who is looking at
    // Outlook or Teams rather than at the SNOW tab — which is the entire point of
    // this tool.
    function notify(row, threshold, pct) {
        if (!CONFIG.NOTIFY_ENABLED) return;
        const mins = Math.max(0, Math.round((msRemaining(row) ?? 0) / 60000));
        const who = row.assigneeName || 'unassigned';
        try {
            GM_notification({
                title: `OLA ${threshold}% — ${row.number}`,
                text: `${mins} min left · ${who}\n${row.shortDesc || ''}`.trim(),
                timeout: 15000,
                onclick: () => {
                    try { window.focus(); } catch {}
                    window.open(`${location.origin}/${row.table}.do?sys_id=${encodeURIComponent(row.taskSysId)}&sysparm_stack=no`, '_blank');
                }
            });
        } catch (e) {
            console.warn('[OLA Watch] GM_notification failed', e);
        }
        playAlertSound();
    }

    // ─── TAKE-OVER (check-then-write) ────────────────────────────────────────
    async function readAssignee(table, sysId) {
        const r = await snFetch(
            `/api/now/table/${table}/${encodeURIComponent(sysId)}?sysparm_fields=assigned_to&sysparm_display_value=all`
        );
        if (!r.ok) throw new Error(`read-back failed: HTTP ${r.status}`);
        const f = (await r.json())?.result?.assigned_to;
        if (f == null) return { value: '', display: '' };
        if (typeof f === 'object') return { value: f.value || '', display: f.display_value || '' };
        return { value: f, display: f };
    }

    // Lifted from the assignment dashboard, including its hard-won check: the Table
    // API answers 200 and silently discards a field you lack write access to, so a
    // successful-looking response does not mean the ticket moved.
    async function assignRecord(table, sysId, userId) {
        const r = await snFetch(`/api/now/table/${table}/${encodeURIComponent(sysId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assigned_to: userId })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 120)}`);
        const written = (await r.json())?.result?.assigned_to;
        const writtenId = written && typeof written === 'object' ? written.value : written;
        if (!writtenId) throw new Error('Server accepted the update but assigned_to came back empty — check your write access.');
        if (writtenId !== userId) throw new Error(`Server stored a different user (${writtenId}).`);
    }

    // Optimistic concurrency. There is no compare-and-swap on the Table API — no
    // ETag, no If-Match — so this cannot be made truly atomic client-side. What it
    // does do is compare against the assignee the agent actually SAW on screen, and
    // read back afterwards to confirm we won. That takes the window in which two
    // agents can both believe they got the ticket from one poll interval (30s) down
    // to the duration of the PATCH itself.
    //
    // The check is "is it still assigned to who I think it is", NOT "is it
    // unassigned" — these tickets are always assigned to someone; that is why they
    // are breaching. `seenAssignee` is refreshed on every poll, so it tracks the
    // screen rather than freezing at whatever was true when the alert first fired.
    //
    // ponytail: ~PATCH-duration race window, loser detected after the fact rather
    // than prevented. Upgrade to a server-side Business Rule that rejects a
    // reassignment when assigned_to changed since read, if double-claims ever
    // actually cause trouble.
    async function takeOver(row, seenAssignee) {
        const before = await readAssignee(row.table, row.taskSysId);
        if (before.value !== seenAssignee) {
            return { ok: false, takenBy: before.display || 'someone else' };
        }

        const myId = getMyId();
        if (!myId) throw new Error('Could not resolve your ServiceNow user id on this page.');
        await assignRecord(row.table, row.taskSysId, myId);

        const after = await readAssignee(row.table, row.taskSysId);
        if (after.value !== myId) {
            return { ok: false, takenBy: after.display || 'someone else' };
        }
        return { ok: true };
    }

    // ─── STYLES ──────────────────────────────────────────────────────────────
    // GM_addStyle, not a <style> element: SNOW ships a CSP whose style-src has no
    // 'unsafe-inline', which silently drops an inline stylesheet. Visual properties
    // are !important-hardened because Next Experience views ship their own
    // !important base rules that otherwise win the specificity fight.
    GM_addStyle(`
        #olaPanel, #olaPanel * { box-sizing: border-box !important; }
        #olaPanel {
            /* Polaris nav palette. --nav-dim is #a8bcbe (6.1:1 on --nav); the more
               obvious #8fa3a5 measures 4.0:1 and fails AA for the 10.5px text. */
            --nav: #293e40; --nav-hi: #33494b; --nav-line: rgba(255,255,255,0.13);
            --nav-txt: #e3ebec; --nav-dim: #a8bcbe; --nav-cap: #93a9ab;
            --crit: #ff6b6b; --warn: #f5b544;

            position: fixed !important;
            left: 0 !important;
            bottom: 0 !important;
            width: ${CONFIG.PANEL_WIDTH}px !important;
            display: none;
            flex-direction: column !important;
            padding: 9px 10px 10px !important;
            background: var(--nav) !important;
            border-top: 1px solid var(--nav-line) !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            color: var(--nav-txt) !important;
            z-index: 999996 !important;
        }
        #olaPanel.olaVisible { display: flex !important; }

        .olaHeader {
            display: flex !important; justify-content: space-between !important; align-items: center !important;
            padding: 0 6px 8px !important; margin: 0 !important;
            font-size: 10px !important; letter-spacing: 0.08em !important; text-transform: uppercase !important;
            color: var(--nav-cap) !important;
        }
        .olaTitle { font-size: 10px !important; letter-spacing: 0.08em !important; }
        .olaCount { font-weight: 700 !important; color: var(--nav-txt) !important; }
        .olaHeaderBtns { display: flex !important; gap: 4px !important; flex: 0 0 auto !important; }
        .olaIconBtn {
            background: transparent !important; border: none !important; border-radius: 4px !important;
            padding: 3px !important; margin: 0 !important; cursor: pointer !important;
            color: var(--nav-dim) !important; font-size: 11px !important; line-height: 1 !important;
            box-shadow: none !important;
        }
        .olaIconBtn:hover { background: var(--nav-hi) !important; color: var(--nav-txt) !important; }

        /* The nav must never scroll as a whole — favourites stay put and the list
           scrolls inside itself. 46vh keeps the dock off the favourites on a laptop. */
        .olaBody {
            max-height: min(46vh, 380px) !important;
            overflow-y: auto !important;
            overscroll-behavior: contain !important;
            padding: 0 2px 0 0 !important;
        }
        .olaBody::-webkit-scrollbar { width: 6px !important; }
        .olaBody::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2) !important; border-radius: 3px !important; }
        .olaBody::-webkit-scrollbar-track { background: transparent !important; }

        /* Sticky is the whole point of this variant: at 12 rows the band label stays
           on screen, so severity distribution survives scrolling. */
        .olaGrp {
            position: sticky !important; top: 0 !important; z-index: 1 !important;
            background: var(--nav) !important;
            display: flex !important; align-items: center !important; gap: 6px !important;
            padding: 6px 6px 4px !important;
            font-size: 10px !important; letter-spacing: 0.05em !important; text-transform: uppercase !important;
        }
        .olaGrp.olaCrit { color: var(--crit) !important; }
        .olaGrp.olaWarn { color: var(--warn) !important; }
        .olaGrp .olaGrpN {
            margin-left: auto !important; background: var(--nav-hi) !important; border-radius: 9px !important;
            padding: 1px 7px !important; font-size: 10px !important; color: var(--nav-txt) !important;
        }
        /* Severity glyph, not colour alone — ~8% of male agents can't rely on the hue. */
        .olaSev { font-size: 9px !important; line-height: 1 !important; }

        .olaRow {
            display: flex !important; align-items: center !important; gap: 8px !important;
            padding: 6px !important; margin: 0 0 2px 0 !important;
            border-radius: 7px !important; cursor: pointer !important;
        }
        .olaRow:hover { background: var(--nav-hi) !important; }
        .olaRowTxt { min-width: 0 !important; }
        .olaNum { font-size: 12px !important; font-weight: 600 !important; color: var(--nav-txt) !important; }
        .olaWho {
            font-size: 10.5px !important; color: var(--nav-dim) !important;
            white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important;
        }
        .olaRowRight { margin-left: auto !important; display: flex !important; align-items: center !important; gap: 7px !important; flex: 0 0 auto !important; }
        .olaClock {
            font-size: 12.5px !important; font-weight: 700 !important; letter-spacing: 0.01em !important;
            font-variant-numeric: tabular-nums !important; font-feature-settings: "tnum" !important;
        }
        .olaClock.olaCrit { color: var(--crit) !important; }
        .olaClock.olaWarn { color: var(--warn) !important; }
        .olaTakeBtn {
            border: none !important; border-radius: 6px !important;
            background: rgba(74,222,128,0.16) !important; color: #8ee8a6 !important;
            font-size: 10.5px !important; font-weight: 600 !important;
            padding: 5px 9px !important; margin: 0 !important; min-height: 26px !important;
            cursor: pointer !important; white-space: nowrap !important;
            flex: 0 0 auto !important; box-shadow: none !important;
        }
        .olaTakeBtn:hover:not(:disabled) { background: rgba(74,222,128,0.28) !important; }
        .olaTakeBtn:disabled { opacity: 0.5 !important; cursor: default !important; }
        .olaTakeBtn.olaMine { background: rgba(147,197,253,0.14) !important; color: #a8cbf5 !important; }
        .olaRowMsg { font-size: 10.5px !important; color: var(--crit) !important; padding: 0 6px 5px !important; }
        .olaStatus { font-size: 10px !important; color: var(--nav-cap) !important; text-align: center !important; padding: 7px 0 0 !important; }
        .olaStatus.olaErr { color: var(--crit) !important; }
    `);

    // ─── DOM HELPERS ─────────────────────────────────────────────────────────
    // Everything carrying record-derived text goes through these rather than an
    // innerHTML template. A requester controls short_description, and this panel
    // renders on the SNOW origin with a live session, so that text must never reach
    // an HTML parser.
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    // ─── PANEL ───────────────────────────────────────────────────────────────
    let panel = null;
    let muteBtn = null;

    function syncMuteBtn() {
        if (!muteBtn) return;
        const muted = isMuted();
        muteBtn.textContent = muted ? '🔕' : '🔔';
        muteBtn.title = muted ? 'Unmute alerts' : 'Mute sound + notifications for 4h (all tabs)';
    }

    function buildPanel() {
        panel = document.createElement('div');
        panel.id = 'olaPanel';

        const header = el('div', 'olaHeader');
        const title = el('span', 'olaTitle', '⏱ OLA at risk · ');
        const count = el('b', 'olaCount', '0');
        count.id = 'olaCount';
        title.appendChild(count);
        header.appendChild(title);
        const btns = el('div', 'olaHeaderBtns');

        muteBtn = el('button', 'olaIconBtn', '🔔');
        muteBtn.addEventListener('click', () => { toggleMute(); syncMuteBtn(); });
        syncMuteBtn();

        const refreshBtn = el('button', 'olaIconBtn', '⟳');
        refreshBtn.title = 'Refresh now (also reconnects if the session expired)';
        refreshBtn.addEventListener('click', () => { forcePoll(); });

        btns.append(muteBtn, refreshBtn);
        header.appendChild(btns);

        const body = el('div', 'olaBody');
        body.id = 'olaBody';

        const status = el('div', 'olaStatus', 'starting…');
        status.id = 'olaStatus';

        panel.append(header, body, status);
        document.body.appendChild(panel);
    }

    // ─── DOCKING ─────────────────────────────────────────────────────────────
    // Pins left/width/bottom to the REAL Favorites nav container's rect instead
    // of the earlier fixed guess (left:0, PANEL_WIDTH px). aria-label is the
    // stable selector — the class list also carries a per-session hash
    // (`sn-polaris-nav 1b682fe1c3133010cbd77096e940dd18 can-animate`), so
    // matching on that hash would work today and break on the next login.
    // `.sn-polaris-nav` alone is stable too (classList membership, not the full
    // string), but pairing it with the aria-label is the more specific match.
    //
    // .style.setProperty(..., 'important') rather than a plain assignment: the
    // stylesheet rule is itself !important (needed to win against Next
    // Experience's own !important base styles), and only another !important can
    // out-rank that.
    const FAVORITES_NAV_SELECTOR = '.sn-polaris-nav[aria-label="Favorites menu"]';
    function syncPanelDock() {
        if (!panel) return;
        const nav = document.querySelector(FAVORITES_NAV_SELECTOR);
        if (!nav) {
            // Nav not present on this view (or not rendered yet) — fall back to
            // the old assumption rather than leaving stale coordinates in place.
            panel.style.setProperty('left', '0px', 'important');
            panel.style.setProperty('width', `${CONFIG.PANEL_WIDTH}px`, 'important');
            panel.style.setProperty('bottom', '0px', 'important');
            return;
        }
        const rect = nav.getBoundingClientRect();
        panel.style.setProperty('left', `${Math.round(rect.left)}px`, 'important');
        panel.style.setProperty('width', `${Math.round(rect.width)}px`, 'important');
        // Docked to the nav's OWN bottom edge, not the viewport's — a nav that
        // doesn't reach the floor (a footer banner, a collapsed rail state)
        // would otherwise leave the panel floating below where the nav actually
        // ends.
        panel.style.setProperty('bottom', `${Math.round(Math.max(0, window.innerHeight - rect.bottom))}px`, 'important');
    }

    // ─── FAVORITES NAV ENTRY ─────────────────────────────────────────────────
    // A persistent, native-shaped favourite — sibling to the agent's real
    // favourites (Knowledge, Incident - Create New, etc.), appended after the
    // last one — rather than relying solely on the overlay panel's
    // conditional visibility. Its badge always shows the live at-risk count,
    // and clicking it toggles the overlay open regardless of whether
    // anything is currently at risk, so there's a permanent, discoverable
    // entry point even on a quiet day.
    //
    // Structured the way the nav's other single-item favourites are: an
    // <sn-collapsible-list> holding one <ul class="sn-polaris-nav-list-items">
    // with a single <li>, inside an open shadow root. Real favourites get
    // their visual styling from a shadow root the nav's own JS attaches
    // internally, which a userscript has no way to read or reuse — so this
    // ships its OWN <style> inside its OWN shadow root (the overlay panel's
    // dark nav palette) rather than rendering unstyled.
    //
    // `sn-collapsible-list` is very likely a REAL, already-registered custom
    // element in SNOW's own bundle — creating one with that tag name may run
    // SNOW's constructor, which can claim the shadow root before this code
    // gets a chance to. attachShadow throws in that case ("already hosts a
    // shadow tree"); buildFavItem falls back to a plain wrapper rather than
    // silently rendering nothing.
    const FAVORITES_NAV_BODY_SELECTOR = `${FAVORITES_NAV_SELECTOR} .sn-polaris-nav-body`;
    const FAV_ITEM_ID = 'olaWatchFavItem';
    let favItem = null;
    let favBadge = null;
    let favOpenManually = false;

    function buildFavItem() {
        let item, shadow;
        try {
            item = document.createElement('sn-collapsible-list');
            shadow = item.attachShadow({ mode: 'open' });
        } catch (e) {
            console.warn('[OLA Watch] <sn-collapsible-list> already owns a shadow root — using a plain wrapper instead', e);
            item = document.createElement('div');
            item.setAttribute('role', 'listitem');
            shadow = item.attachShadow({ mode: 'open' });
        }
        item.id = FAV_ITEM_ID;
        item.setAttribute('now-id', FAV_ITEM_ID);
        item.setAttribute('component-id', FAV_ITEM_ID);
        item.setAttribute('dir', 'ltr');

        shadow.innerHTML = `
            <style>
                :host { display: block; }
                ul.sn-polaris-nav-list-items { list-style: none; margin: 0; padding: 0; }
                .olaFavRow {
                    display: flex; align-items: center; gap: 8px;
                    width: 100%; border: none; background: transparent; cursor: pointer;
                    padding: 7px 12px; margin: 0; font: inherit;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                    font-size: 13px; color: #e3ebec; text-align: left;
                }
                .olaFavRow:hover { background: rgba(255,255,255,0.08); }
                .olaFavIcon { font-size: 13px; line-height: 1; flex: 0 0 auto; }
                .olaFavLabel { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
                .olaFavBadge {
                    flex: 0 0 auto; min-width: 16px; text-align: center;
                    border-radius: 9px; padding: 1px 6px; font-size: 10.5px; font-weight: 700;
                    background: #ff6b6b; color: #1a1a1a; display: none;
                }
                .olaFavBadge.olaShow { display: inline-block; }
            </style>
            <ul class="sn-polaris-nav-list-items">
                <li>
                    <button type="button" class="olaFavRow" title="Open OLA Watch">
                        <span class="olaFavIcon">⏱</span>
                        <span class="olaFavLabel">OLA Watch</span>
                        <span class="olaFavBadge">0</span>
                    </button>
                </li>
            </ul>
        `;
        shadow.querySelector('.olaFavRow').addEventListener('click', () => {
            favOpenManually = !favOpenManually;
            renderPanel();
        });
        favBadge = shadow.querySelector('.olaFavBadge');
        return item;
    }

    // Re-checked every second, same as syncPanelDock and for the same reason:
    // a Next Experience re-render on navigation would eject any child
    // appended into the real nav, and there's no reliable event to catch
    // that moment, so this just notices it's gone and re-appends.
    function syncFavItem() {
        const navBody = document.querySelector(FAVORITES_NAV_BODY_SELECTOR);
        if (!navBody) return;
        if (!favItem) favItem = buildFavItem();
        if (favItem.parentElement !== navBody) {
            navBody.appendChild(favItem); // after the last existing <sn-collapsible-list>
        }
    }

    // #olaPanel is display:none unless it carries .olaVisible, and the ONLY place
    // that normally adds that class is renderPanel's own
    // `rows.length > 0 || !!state.error` check. Several callers report a problem
    // straight to this status line WITHOUT going through renderPanel first — no
    // user id on the page, a broken session, the very first poll before any
    // shared state exists — and those calls used to write into a panel that was
    // still display:none, so the message went nowhere. An error is always worth
    // surfacing, so it forces the panel open here rather than depending on every
    // call site to remember to do it separately.
    function setStatus(text, isError = false) {
        const s = document.getElementById('olaStatus');
        if (!s) return;
        s.textContent = text;
        s.classList.toggle('olaErr', isError);
        if (isError && panel) panel.classList.add('olaVisible');
    }

    // Rows currently rendered, so the 1s ticker can update clocks without a re-render
    // (a re-render would destroy a Take button mid-click and lose its error message).
    let renderedRows = [];

    // Outcome of a recent take-over attempt, keyed by SLA sys_id and held OUTSIDE the
    // DOM on purpose. A lost race is immediately followed by a refresh poll, and in
    // Tampermonkey a value-change listener fires in the writing tab too — so a message
    // written straight into the row would be wiped by the re-render a moment later.
    // Losing "already taken by X" is exactly the feedback the agent needs to not go
    // and work the ticket anyway.
    const TAKE_MSG_MS = 20000;
    const takeMsgs = new Map(); // slaSysId -> { text, until }
    function setTakeMsg(slaSysId, text) {
        takeMsgs.set(slaSysId, { text, until: Date.now() + TAKE_MSG_MS });
    }
    function getTakeMsg(slaSysId) {
        const m = takeMsgs.get(slaSysId);
        if (!m) return null;
        if (Date.now() > m.until) { takeMsgs.delete(slaSysId); return null; }
        return m.text;
    }

    function renderPanel() {
        if (!panel) return;
        const state = getSharedState();
        const rows = (state.rows || []).slice().sort((a, b) => (msRemaining(a) ?? Infinity) - (msRemaining(b) ?? Infinity));
        renderedRows = rows;

        const body = document.getElementById('olaBody');
        if (!body) return;

        panel.classList.toggle('olaVisible', rows.length > 0 || !!state.error || favOpenManually);
        if (favBadge) favBadge.classList.toggle('olaShow', rows.length > 0);
        if (favBadge) favBadge.textContent = String(rows.length);

        body.replaceChildren();
        const myId = getMyId();

        const isCrit = row => { const p = computePct(row); return p != null && p >= 75; };

        function addGroup(label, cls, glyph, list) {
            if (!list.length) return;
            const grp = el('div', `olaGrp ${cls}`);
            grp.appendChild(el('span', 'olaSev', glyph));
            grp.appendChild(el('span', null, label));
            grp.appendChild(el('span', 'olaGrpN', String(list.length)));
            body.appendChild(grp);
            list.forEach(row => addRow(row, cls));
        }

        function addRow(row, cls) {
            const rowEl = el('div', 'olaRow');
            rowEl.dataset.sla = row.slaSysId;
            rowEl.title = row.shortDesc || '';   // description no longer has a line of
                                                 // its own; the row is 61px because of it
            rowEl.addEventListener('click', e => {
                if (e.target.closest('button')) return;
                window.open(`${location.origin}/${row.table}.do?sys_id=${encodeURIComponent(row.taskSysId)}&sysparm_stack=no`, '_blank');
            });

            const isMine = myId && row.assignee === myId;

            const txt = el('span', 'olaRowTxt');
            txt.appendChild(el('div', 'olaNum', row.number || '(no number)'));
            txt.appendChild(el('div', 'olaWho', isMine ? 'Assigned to you' : (row.assigneeName || 'Unassigned')));
            rowEl.appendChild(txt);

            const right = el('div', 'olaRowRight');
            const clock = el('span', `olaClock ${cls}`, fmtRemaining(msRemaining(row)));
            clock.dataset.clock = '1';
            right.appendChild(clock);

            const takeBtn = el('button', 'olaTakeBtn' + (isMine ? ' olaMine' : ''), isMine ? 'Yours' : 'Take');
            takeBtn.disabled = !!isMine;
            takeBtn.title = isMine ? 'Already assigned to you' : `Reassign ${row.number} to you`;
            const msg = el('div', 'olaRowMsg');
            const held = getTakeMsg(row.slaSysId);
            msg.textContent = held || '';
            msg.style.display = held ? 'block' : 'none';

            takeBtn.addEventListener('click', async () => {
                takeBtn.disabled = true;
                takeBtn.textContent = '…';
                msg.style.display = 'none';
                takesInFlight++;
                try {
                    // The assignee passed here is the one rendered in THIS row, i.e.
                    // the value the agent was looking at when they decided to click.
                    const res = await takeOver(row, row.assignee);
                    if (res.ok) {
                        takeBtn.textContent = 'Yours';
                        takeBtn.classList.add('olaMine');
                        txt.querySelector('.olaWho').textContent = 'Assigned to you';
                        row.assignee = getMyId();
                        row.assigneeName = getMyName();
                    } else {
                        takeBtn.textContent = 'Taken';
                        setTakeMsg(row.slaSysId, `Already taken by ${res.takenBy}`);
                    }
                } catch (e) {
                    takeBtn.disabled = false;
                    takeBtn.textContent = 'Retry';
                    setTakeMsg(row.slaSysId, `❌ ${e.message}`);
                    console.error('[OLA Watch] take-over failed', e);
                } finally {
                    takesInFlight--;
                }
                const m = getTakeMsg(row.slaSysId);
                if (m) { msg.textContent = m; msg.style.display = 'block'; }
                forcePoll();
            });

            right.appendChild(takeBtn);
            rowEl.appendChild(right);
            body.appendChild(rowEl);
            // Sibling, not a child: the row is a single-line flex box now, so the
            // take-over message hangs under it instead of stretching it.
            body.appendChild(msg);
        }

        addGroup('Breaching soon', 'olaCrit', '▲', rows.filter(isCrit));
        addGroup('Watch', 'olaWarn', '●', rows.filter(r => !isCrit(r)));

        const countEl = document.getElementById('olaCount');
        if (countEl) countEl.textContent = String(rows.length);

        if (state.error) {
            setStatus(`Error: ${state.error}`, true);
        } else {
            setStatus(`updated ${state.stamp || '—'}`);
        }
    }

    // Clocks tick locally every second so the countdown stays live between the 30s
    // polls, without re-rendering rows (which would kill an in-flight Take button).
    function tickClocks() {
        if (!panel) return;
        renderedRows.forEach(row => {
            const rowEl = panel.querySelector(`.olaRow[data-sla="${CSS.escape(row.slaSysId)}"]`);
            if (!rowEl) return;
            const clockEl = rowEl.querySelector('[data-clock]');
            if (clockEl) clockEl.textContent = fmtRemaining(msRemaining(row));
        });
    }

    // A poll landing while a take-over is in flight must not re-render the row being
    // clicked — same lesson the assignment dashboard learned. Polls keep fetching;
    // the render is deferred until the panel is idle.
    let takesInFlight = 0;

    // ─── POLL ────────────────────────────────────────────────────────────────
    async function pollOnce() {
        const gid = await resolveGroupSysId();
        const rows = await fetchOlaRows(gid);

        // Only rows past the lowest configured threshold reach the panel; everything
        // else is a healthy ticket and would just be noise.
        const lowest = Math.min(...CONFIG.THRESHOLDS);
        const atRisk = rows.filter(row => {
            const pct = computePct(row);
            return pct != null && pct >= lowest;
        });

        // Fire notifications for newly crossed thresholds. This runs only on the tab
        // that won the poll, and the ledger is shared, so the agent gets exactly one
        // notification per ticket per threshold no matter how many tabs are open.
        const ledger = pruneLedger(getLedger());
        const now = Date.now();
        atRisk.forEach(row => {
            const pct = computePct(row);
            const threshold = crossedThreshold(pct);
            if (threshold == null) return;

            const entry = ledger[row.slaSysId] || { fired: [], lastSeen: now };
            entry.lastSeen = now;

            // Fire every not-yet-fired threshold at or below the current one, so a
            // ticket that jumps past 50 straight to 75 between polls (a long tab
            // sleep, a laptop resuming from suspend) still records both rather than
            // leaving 50 armed to fire later.
            CONFIG.THRESHOLDS.filter(t => t <= threshold && !entry.fired.includes(t))
                .sort((a, b) => a - b)
                .forEach(t => {
                    // The threshold is recorded as fired even when muted — muting
                    // means "stop making noise", not "replay everything at me the
                    // moment I unmute".
                    entry.fired.push(t);
                    if (!isMuted()) notify(row, t, pct);
                });

            ledger[row.slaSysId] = entry;
        });
        // Keep rows that are being tracked but haven't crossed anything alive in the
        // ledger too, so lastSeen stays fresh and TTL pruning doesn't drop them early.
        rows.forEach(row => {
            if (ledger[row.slaSysId]) ledger[row.slaSysId].lastSeen = now;
        });
        setLedger(ledger);

        setSharedState({ rows: atRisk, stamp: new Date().toLocaleTimeString(), error: '' });
        // Render our own panel directly rather than waiting to hear about our own
        // write. Tampermonkey does deliver value-change events to the writing tab,
        // but leaning on that would make the polling tab's own panel hostage to a
        // storage-layer implementation detail — other tabs still update via the
        // listener, this tab just doesn't need to.
        if (takesInFlight === 0) renderPanel();
    }

    // ─── POLL SCHEDULING (shared across SNOW tabs) ──────────────────────────
    // Ported from the ACK monitor, and for the same reasons. Three open SNOW tabs
    // must not mean 3× the API load and three notifications for one ticket.
    //
    // There is no leader and no lease — GM storage holds one timestamp saying when
    // the last poll happened, and any tab volunteers once a poll is overdue. A lease
    // has to expire before anyone else may act, so a hard-killed tab (crash,
    // task-kill, no unload event) stalls polling for the whole expiry window. Here a
    // dead tab simply stops refreshing the timestamp and the next tab to notice
    // picks the work up, degrading to at most one normal poll interval.
    //
    // Polling is deliberately NOT gated on visibility: the case that matters most is
    // the agent looking at something else. Visibility is only a preference — hidden
    // tabs wait a grace period before volunteering so a visible tab takes the round
    // when one exists, because browsers throttle background timers hard and a hidden
    // poller would quietly stretch the real interval for everyone.
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
        if (!last) return true;
        const wait = CONFIG.POLL_MS + (isVisible() ? 0 : CONFIG.HIDDEN_TAB_GRACE_MS);
        return Date.now() - last.ts >= wait;
    }

    let pollInFlight = false;
    async function pollCycle(force = false) {
        if (pollInFlight) return;
        if (!force && !pollIsDue()) return;

        // A tab with a broken session must not stake the poll claim — claiming it
        // makes every other tab stand down, and the fetch would just fail here too.
        // Declining lets a healthy tab take the round. An explicit force (the ⟳
        // button, i.e. "I signed back in, try again") gets one fresh attempt rather
        // than staying parked on the old failure forever.
        if (sessionBroken) {
            if (!force) {
                setStatus('Session expired — click ⟳ to reconnect', true);
                return;
            }
            sessionBroken = false;
        }

        // Never volunteer if this tab can't do the work. Staking the claim makes
        // every other tab stand down, so a tab that then bails would silently
        // suppress polling everywhere.
        if (!getMyId()) {
            setStatus('no user id on this page', true);
            return;
        }

        pollInFlight = true;
        try {
            if (!force) {
                await sleep(Math.floor(Math.random() * 200));
                if (!pollIsDue()) return;   // another tab took this round while we jittered
                markPolled();               // stake the claim up front
                await sleep(150);
                const last = readLastPoll();
                if (!last || last.tabId !== TAB_ID) return; // lost the race
            } else {
                markPolled();
            }

            await pollOnce();
            markPolled(); // measure the next interval from completion
        } catch (e) {
            const prev = getSharedState();
            setSharedState({ ...prev, error: e.message });
            console.error('[OLA Watch] poll failed', e);
            // Without this, the polling tab writes the error to shared storage but
            // never repaints itself — pollOnce's success path renders directly for
            // exactly this reason (a tab can't rely on hearing its own GM storage
            // write back as a value-change event), and this path was missing the
            // same call. On a single-tab session — the common case — that meant an
            // error made the panel go from invisible-because-nothing's-at-risk to
            // invisible-because-broken with zero visible difference: #olaPanel stays
            // display:none because .olaVisible is only ever added inside renderPanel.
            if (takesInFlight === 0) renderPanel();
        } finally {
            pollInFlight = false;
        }
    }

    // Returns the promise so callers can await the refresh — the take-over handler
    // and any test harness need to know when the new state has actually landed.
    function forcePoll() { return pollCycle(true); }

    // ─── CROSS-TAB RENDER ────────────────────────────────────────────────────
    // Only the polling tab fetches; every tab re-renders when the shared state
    // changes, so all tabs show the same panel without any of them polling.
    GM_addValueChangeListener(STATE_KEY, () => {
        if (takesInFlight === 0) renderPanel();
    });
    GM_addValueChangeListener(MUTE_KEY, syncMuteBtn);

    // ─── INIT ────────────────────────────────────────────────────────────────
    buildPanel();
    renderPanel();
    syncPanelDock();
    syncFavItem();
    setInterval(tickClocks, 1000);
    setInterval(() => { if (takesInFlight === 0) renderPanel(); }, 15000); // catch TTL/stale drift
    // On its own timer, not folded into tickClocks: the nav can appear, resize,
    // collapse to a rail, or get ejected-and-rebuilt by a Next Experience
    // re-render at any point independent of the clock/poll cadence, and this is
    // cheap enough (one querySelector + getBoundingClientRect) to just re-check
    // every second rather than trying to catch every event that could move it.
    setInterval(syncPanelDock, 1000);
    setInterval(syncFavItem, 1000);
    window.addEventListener('resize', syncPanelDock);
    setInterval(pollCycle, CONFIG.POLL_TICK_MS);
    pollCycle();

    document.addEventListener('visibilitychange', () => { if (isVisible()) pollCycle(); });

    // ─── DEBUG / SELF-CHECK (console) ────────────────────────────────────────
    window.__olaWatchDebug = {
        forcePoll,
        state: () => getSharedState(),
        ledger: () => getLedger(),
        clearLedger() { GM_deleteValue(LEDGER_KEY); console.log('[OLA Watch] ledger cleared'); },
        sessionStatus() {
            console.log('[OLA Watch] sessionBroken:', sessionBroken, '| have token:', !!sessionToken);
            return { sessionBroken, hasToken: !!sessionToken };
        },

        // Answers "why is the panel in the wrong place / not docked?" — reports
        // whether the Favorites nav was found and what rect the panel is pinned to.
        dock() {
            const nav = document.querySelector(FAVORITES_NAV_SELECTOR);
            const info = {
                navFound: !!nav,
                navRect: nav ? nav.getBoundingClientRect() : null,
                panelStyle: panel ? { left: panel.style.left, width: panel.style.width, bottom: panel.style.bottom } : null
            };
            console.log('[OLA Watch] dock:', info);
            return info;
        },

        // Answers "why isn't the favourite showing up?" — reports whether the
        // nav body was found, whether the fav item is currently attached to
        // it, and whether it fell back to a plain wrapper (sn-collapsible-list
        // was already a real, shadow-owning custom element).
        favStatus() {
            const navBody = document.querySelector(FAVORITES_NAV_BODY_SELECTOR);
            const info = {
                navBodyFound: !!navBody,
                favItemBuilt: !!favItem,
                favItemAttached: !!(favItem && navBody && favItem.parentElement === navBody),
                usedFallbackWrapper: !!(favItem && favItem.tagName !== 'SN-COLLAPSIBLE-LIST')
            };
            console.log('[OLA Watch] fav:', info);
            return info;
        },
        pollStatus() {
            const last = readLastPoll();
            console.log('[OLA Watch] last poll:', last,
                '| age(ms):', last ? Date.now() - last.ts : null,
                '| this tab:', TAB_ID, '| wasMe:', !!last && last.tabId === TAB_ID,
                '| due now:', pollIsDue());
            return last;
        },

        // Answers "why is the panel empty?" — lists every OLA/SLA name currently
        // running on the group's tickets, so a mismatched CONFIG.OLA_NAME is one
        // console call away from being obvious instead of looking like "nothing at risk".
        async listSlaNames() {
            const gid = await resolveGroupSysId();
            const url = `/api/now/table/task_sla?sysparm_query=${encodeURIComponent(`active=true^task.assignment_group=${gid}`)}`
                + `&sysparm_fields=${encodeURIComponent('sla.name,stage,task.number')}&sysparm_display_value=all&sysparm_limit=50`;
            const r = await snFetch(url);
            const rows = (await r.json())?.result || [];
            const names = {};
            rows.forEach(x => {
                const n = fieldDisplay(x, 'sla.name') || '(blank)';
                names[n] = (names[n] || 0) + 1;
            });
            console.table(names);
            return names;
        },

        // Pure-logic self-check: the clock maths and threshold bookkeeping are the
        // parts that silently do the wrong thing, and they're the parts a live
        // instance can't easily be made to demonstrate on demand.
        selfTest() {
            const fails = [];
            const check = (name, cond) => { if (!cond) fails.push(name); };

            const iso = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
            // Fixed calendar points, not "now minus N" — computePct is schedule-aware,
            // so its answer depends on which real calendar days/hours a window falls
            // on. Pinning start/end/now to known dates (and passing nowMs explicitly)
            // keeps the test deterministic instead of it passing or failing depending
            // on what day the suite happens to run.
            const pIso = (y, m, d, hh, mi) => iso(parisLocalToUtc(y, m, d, hh, mi));
            const pMs  = (y, m, d, hh, mi) => parisLocalToUtc(y, m, d, hh, mi);
            const row = (startIso, endIso) => ({ start: startIso, plannedEnd: endIso, serverPct: 0 });

            // Tue 2026-08-04, a plain business day: 10:00–11:00 Paris is a 60
            // business-minute OLA entirely inside the 08:00–19:00 window.
            const sameDay = row(pIso(2026, 8, 4, 10, 0), pIso(2026, 8, 4, 11, 0));
            check('50% midpoint', Math.abs(computePct(sameDay, pMs(2026, 8, 4, 10, 30)) - 50) < 0.5);
            check('75% point', Math.abs(computePct(sameDay, pMs(2026, 8, 4, 10, 45)) - 75) < 0.5);
            // Past the deadline clamps to 100, never above
            check('clamped at 100', computePct(sameDay, pMs(2026, 8, 4, 12, 0)) === 100);
            // Before the start clamps to 0, never negative
            check('clamped at 0', computePct(sameDay, pMs(2026, 8, 4, 9, 0)) === 0);

            // Fri 2026-08-07 18:00 Paris → Mon 2026-08-10 10:00 Paris: 1 business
            // hour left in Friday's window + 2 business hours Monday morning = 3h
            // total. This is the case wall-clock division gets wrong — the window
            // spans a weekend, so most of its raw duration is non-business time.
            const spansWeekend = row(pIso(2026, 8, 7, 18, 0), pIso(2026, 8, 10, 10, 0));
            const atFridayClose = computePct(spansWeekend, pMs(2026, 8, 7, 19, 0)); // Friday's window has just closed: 1 of 3 business hours spent
            check('schedule-aware, not wall-clock (Friday close = 1/3)', Math.abs(atFridayClose - (100 / 3)) < 0.5);
            const midWeekend = computePct(spansWeekend, pMs(2026, 8, 8, 12, 0)); // Saturday afternoon: no business hours have passed since Friday close
            check('weekend adds no business time', Math.abs(midWeekend - atFridayClose) < 0.01);

            // Bastille Day 2026-07-14 (Tuesday) is a French holiday: an OLA window
            // entirely inside it has zero business hours, so computePct falls back
            // to serverPct rather than dividing by zero.
            const onHoliday = { start: pIso(2026, 7, 14, 8, 0), plannedEnd: pIso(2026, 7, 14, 19, 0), serverPct: 42 };
            check('holiday window falls back to serverPct', computePct(onHoliday, pMs(2026, 7, 14, 12, 0)) === 42);

            // Threshold selection returns the MOST severe crossed, not the first
            check('threshold 49 → none', crossedThreshold(49) === null);
            check('threshold 50 → 50', crossedThreshold(50) === 50);
            check('threshold 74 → 50', crossedThreshold(74) === 50);
            check('threshold 99 → 75', crossedThreshold(99) === 75);
            check('threshold null → null', crossedThreshold(null) === null);

            // Countdown floors at BREACHED rather than ticking negative
            check('negative remaining', fmtRemaining(-5000) === 'BREACHED');
            check('formats mm:ss', fmtRemaining(90 * 1000) === '01:30');

            // Timestamps are read as UTC, not local
            check('utc parse', parseSnowUtc('2026-07-20 10:00:00') === Date.UTC(2026, 6, 20, 10, 0, 0));

            // Ledger pruning keeps fresh entries and drops expired ones
            const l = pruneLedger({
                fresh: { fired: [50], lastSeen: Date.now() },
                stale: { fired: [50], lastSeen: Date.now() - CONFIG.LEDGER_TTL_MS - 1000 }
            });
            check('ledger keeps fresh', !!l.fresh);
            check('ledger drops stale', !l.stale);

            if (fails.length) {
                console.error('[OLA Watch] selfTest FAILED:', fails);
                return { ok: false, fails };
            }
            console.log('[OLA Watch] selfTest passed (17 checks)');
            return { ok: true };
        }
    };

    console.log(`[OLA Watch] loaded — group ${CONFIG.ASSIGNMENT_GROUP}, OLA ${CONFIG.OLA_NAME}, thresholds ${CONFIG.THRESHOLDS.join('/')}%`);
})();
