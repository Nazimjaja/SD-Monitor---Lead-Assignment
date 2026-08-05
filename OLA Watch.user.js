// ==UserScript==
// @name         SD Monitor - OLA Breach Warning
// @namespace    geodis-sd-monitor
// @version      0.13
// @description  Warns every SD agent when a group ticket's resolution OLA crosses 75%, and lets whoever is free take it over on the spot
// @homepageURL  https://github.com/Nazimjaja/SD-Monitor---Lead-Assignment
// @updateURL    https://raw.githubusercontent.com/Nazimjaja/SD-Monitor---Lead-Assignment/main/OLA%20Watch.user.js
// @downloadURL  https://raw.githubusercontent.com/Nazimjaja/SD-Monitor---Lead-Assignment/main/OLA%20Watch.user.js
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

    // Read back from the installed script's own metadata, same reasoning as the
    // ACK monitor's SCRIPT_VERSION: with the script auto-updating, "which
    // version is this tab actually running" stops being answerable from memory,
    // and a stale tab keeps running old code until it reloads. The load line
    // below used to omit this entirely, which is exactly the ambiguity that
    // made "did the reinstall actually take" impossible to answer from the
    // console alone.
    const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info?.script?.version) || '?';

    // ─── CONFIG ─────────────────────────────────────────────────────────────
    const CONFIG = {
        ASSIGNMENT_GROUP: 'CORP-SD',

        // The OLA definition name in contract_sla. A task carries several SLA/OLA/UC
        // instances at once (response, resolution, underpinning contracts), so this
        // name is what narrows task_sla down to the single clock we care about.
        // If the panel reports 0 rows on a ticket you know is running, this string is
        // the first thing to check — see __olaWatchDebug.listSlaNames().
        OLA_NAME: 'INC-RES-CORP-SD',

        // The business schedule to assume for OLAs whose clock actually pauses:
        // (Geo) FR, Mon–Fri 08:00–19:00, Europe/Paris (CET/CEST — handled below via
        // Intl, not a fixed UTC offset), excluding French public holidays.
        //
        // This is NOT applied to every row. Whether a given OLA's clock pauses at
        // all is decided per row by clockPauses() from the SLA's own duration and
        // timestamps — see the comment there. Applying this schedule unconditionally
        // is what made a 24/7 OLA opened at 18:32 read as 75% consumed 21 minutes
        // later: only the 28 minutes before the 19:00 close were counted as its
        // window, so 21 minutes of a 60-minute OLA divided by 28 rather than 60.
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

        // Percent-of-OLA-consumed points controlling three independent behaviors —
        // deliberately split apart, since "worth listing", "genuinely urgent" and
        // "worth interrupting someone for" are different bars and used to all be
        // driven off the same two-element array:
        //   SHOW_AT   — lowest pct at which a ticket enters the panel at all (Watch)
        //   CRIT_AT   — pct at which a ticket is relabeled "Breaching soon" (red)
        //   NOTIFY_AT — pct(s) at which a sound + OS notification actually fires.
        //               A list, not a single number, so a later "one last call
        //               before breach" point (e.g. 90) can be added without
        //               restructuring anything that reads it.
        SHOW_AT: 25,
        CRIT_AT: 50,
        NOTIFY_AT: [75],

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

        // Where the ribbon lives. Two earlier attempts docked it into the real
        // Polaris nav — both worked in a local Chromium, neither could be
        // confirmed to find anything on the real instance, and the script was
        // moved to a fixed corner that has no DOM dependency at all.
        //
        // Docking is back because the actual markup is now known rather than
        // guessed (`.sn-polaris-navigation.polaris-header-menu[role=menu]`,
        // holding absolutely-positioned `.sn-polaris-tab` children — All,
        // Favorites, History, the ⋮ overflow). What is different this time is
        // that nothing depends on the attempt succeeding: tryDock() proves the
        // ribbon is really on screen, really on top and really clear of the
        // other tabs before keeping it there, and falls back to the same fixed
        // corner as before if it can't. The corner is still the floor.
        DOCK: {
            ENABLED: true,

            // Tried in order, in the light DOM and in any open shadow root.
            // The first is the exact container the tabs live in; the rest are
            // progressively looser in case a Polaris release renames the
            // decorative class but keeps the structural one.
            HOST_SELECTORS: [
                '.sn-polaris-navigation.polaris-header-menu[role="menu"]',
                '.polaris-header-menu[role="menu"]',
                '.sn-polaris-navigation[role="menu"]'
            ],
            // What counts as one of the nav's own tabs, for "put mine after
            // the last one" and for the overlap check.
            TAB_SELECTOR: '.sn-polaris-tab',

            // Gap between the ⋮ overflow tab and the ribbon, and the breathing
            // room left after the ribbon when the host's min-width is widened
            // to actually reserve the space (see layoutRibbon).
            GAP_PX: 10,
            TAIL_PX: 8,

            // The nav is built by ServiceNow's own JS well after DOMContentLoaded,
            // so the host is polled for rather than read once. Giving up just
            // means the corner, which is a working UI, so this waits minutes
            // rather than seconds — a slow instance shouldn't cost the dock.
            POLL_MS: 500,
            MAX_WAIT_MS: 120000
        },

        // The fixed corner: both the fallback when docking can't be verified and
        // the layout the ribbon keeps on any page with no Polaris nav at all.
        // top:64px clears ServiceNow's own global header bar; left:12px sits
        // clear of the nav without needing to know anything about it.
        PANEL_TOP: 64,
        PANEL_LEFT: 12,
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
        // The three fields clockPauses() needs to decide whether this OLA's clock
        // runs continuously or pauses outside a schedule. `sla.duration` is the
        // primary signal (compared against the row's own start→planned_end span);
        // `sla.schedule` / `sla.schedule_source` are the fallback for a definition
        // whose duration doesn't parse. An instance that doesn't have
        // schedule_source simply omits it from the response — fieldVal returns ''
        // and the fallback still works off the schedule reference alone.
        'sla.duration', 'sla.schedule', 'sla.schedule_source',
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
            slaDuration: fieldVal(rec, 'sla.duration'),
            slaSchedule: fieldVal(rec, 'sla.schedule'),
            scheduleSource: fieldVal(rec, 'sla.schedule_source'),
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

    // A glide_duration `value` is a datetime offset from the 1970-01-01 epoch —
    // "1970-01-01 01:00:00" is one hour, "1970-01-02 03:00:00" is 27. Some
    // instances hand back the bare clock form instead, so both are accepted.
    const DURATION_EPOCH = Date.UTC(1970, 0, 1);
    function parseSnowDuration(value) {
        if (!value) return null;
        const raw = String(value).trim();
        const asDate = parseSnowUtc(raw);
        if (asDate != null) {
            const ms = asDate - DURATION_EPOCH;
            return ms > 0 ? ms : null;
        }
        const m = /^(?:(\d+)\s+days?[, ]\s*)?(\d+):(\d{2}):(\d{2})$/.exec(raw);
        if (!m) return null;
        const ms = ((+(m[1] || 0) * 24 + +m[2]) * 3600 + +m[3] * 60 + +m[4]) * 1000;
        return ms > 0 ? ms : null;
    }

    // Does this OLA's clock stop outside business hours, or does it run straight
    // through? Everything downstream — the percentage, the countdown, and therefore
    // the "Breaching soon" label and the notification — depends on the answer, and
    // this script used to never ask the question: it applied CONFIG.SCHEDULE to
    // every row unconditionally. On a 24/7 OLA that inflates the percentage by
    // shrinking the window it divides by, which is what put a 21-minute-old ticket
    // on screen at 75%.
    //
    // The primary signal is the row's own arithmetic, which needs no assumption
    // about WHICH schedule is in force and works even for one this script can't
    // model (24/5, a second site's hours, a schedule attached to the task rather
    // than the definition):
    //
    //   planned_end_time − start_time  ==  the SLA definition's duration
    //     → the clock ran continuously across that span; no non-working time was
    //       inserted, so wall-clock math is exact.
    //   planned_end_time − start_time  >   duration
    //     → the SLA engine pushed the deadline out to skip non-working time. The
    //       clock pauses, and CONFIG.SCHEDULE is our model of when.
    //
    // Tolerance is a minute: the engine's own timestamps can disagree by a second
    // or two, while a real schedule gap is never smaller than the break it skips.
    //
    // If duration doesn't parse, fall back to the definition's schedule reference —
    // no schedule means no pauses. That reference is only trustworthy when the
    // schedule comes from the definition; schedule_source of 'task' means it's read
    // off a task field this query never sees, so an empty sla.schedule proves
    // nothing and we keep the (conservative) schedule-aware reading.
    const SCHEDULE_GAP_TOLERANCE_MS = 60 * 1000;
    function clockPauses(row) {
        const s = parseSnowUtc(row.start);
        const e = parseSnowUtc(row.plannedEnd);
        if (s == null || e == null || e <= s) return null;

        const durationMs = parseSnowDuration(row.slaDuration);
        if (durationMs != null) return (e - s) > durationMs + SCHEDULE_GAP_TOLERANCE_MS;

        const fromDefinition = !row.scheduleSource || row.scheduleSource === 'sla_definition';
        return !(fromDefinition && !row.slaSchedule);
    }

    // Percentage is derived here rather than read from task_sla.percentage because
    // that field is a snapshot written by the SLA engine on task update and by a
    // scheduled job — it can lag by minutes. Against a 60-minute OLA a few minutes
    // of staleness is several percent of the whole window, which is enough to skip
    // a threshold entirely. planned_end_time is a fixed timestamp, so the live
    // number can be computed exactly.
    //
    // Measured in whichever time base this row's clock actually runs on, per
    // clockPauses(). For an OLA that pauses, both the total window and the elapsed
    // time are business milliseconds (CONFIG.SCHEDULE) via businessMsBetween:
    // wall-clock division would read a ticket opened 18:50 on Friday against a
    // Monday deadline as barely started when its whole window is nearly spent. For
    // an OLA that doesn't pause, it is plain wall-clock division, because business
    // math on a clock that never stops is what inflated the percentage of anything
    // opened near the 19:00 close. nowMs is a parameter (defaulting to Date.now())
    // purely so the self-test below can pin it rather than racing real time.
    function computePct(row, nowMs = Date.now()) {
        const s = parseSnowUtc(row.start);
        const e = parseSnowUtc(row.plannedEnd);
        // Missing/unparseable timestamps on a row SNOW already reports as
        // active/in_progress is a transient read gap, not real state — start_time
        // is written synchronously when the SLA clock starts, so a null here means
        // the API response's dot-walk hasn't resolved yet, not that the ticket has
        // no start. Trusting task_sla.percentage in that gap is what let a
        // just-created ticket flash straight to "breaching soon" while its own
        // countdown still showed the OLA nearly untouched: percentage is a snapshot
        // that can lag or carry a stale value from before a reset, and there was
        // nothing here checking it against anything before showing it. Returning
        // null instead just excludes the row until the next poll (≤30s) resolves it.
        if (s == null || e == null || e <= s) return null;

        // A clock that never stops: elapsed and total are the same wall-clock span
        // the SLA engine itself used to place planned_end_time.
        if (clockPauses(row) === false) {
            return clampPct(((Math.min(nowMs, e) - s) / (e - s)) * 100);
        }

        const totalBusinessMs = businessMsBetween(s, e);
        // Zero business hours in the window (e.g. entirely inside a holiday) is a
        // real, stable state rather than a transient gap — serverPct is the only
        // information available here, and there is no "wait for the next poll" that
        // would ever produce a better answer.
        if (totalBusinessMs <= 0) return row.serverPct || null;
        const elapsedBusinessMs = businessMsBetween(s, Math.min(nowMs, e));
        return clampPct((elapsedBusinessMs / totalBusinessMs) * 100);
    }

    function clampPct(pct) {
        return Math.min(100, Math.max(0, pct));
    }

    // Counted on the same time base as computePct, deliberately. These two numbers
    // sit next to each other on every row, so measuring them differently makes the
    // panel contradict itself: the percentage said an OLA was three-quarters gone
    // while the countdown beside it read 39 minutes, because one was schedule-aware
    // and the other was raw subtraction. For a paused clock the answer is the
    // business time left, which is also why the countdown correctly stops moving
    // overnight instead of draining through hours nobody is working.
    function msRemaining(row, nowMs = Date.now()) {
        const e = parseSnowUtc(row.plannedEnd);
        if (e == null) return null;
        // Past the deadline the overshoot is real elapsed time either way, and a
        // negative value is what fmtRemaining reads as BREACHED.
        if (nowMs >= e) return e - nowMs;
        return clockPauses(row) ? businessMsBetween(nowMs, e) : e - nowMs;
    }

    // Business-time-aware OLAs routinely have hours (or, spanning a weekend,
    // more than a day) left — the old mm:ss-only format had no hours field at
    // all, so a 5h47m remainder rendered as the unreadable, overflowing
    // "347:23" rather than clamping or wrapping.
    function fmtRemaining(ms) {
        if (ms == null) return '—';
        if (ms <= 0) return 'BREACHED';
        const totalSec = Math.floor(ms / 1000);
        const days = Math.floor(totalSec / 86400);
        const hours = Math.floor((totalSec % 86400) / 3600);
        const mins = Math.floor((totalSec % 3600) / 60);
        const secs = totalSec % 60;
        if (days > 0) return `${days}d ${String(hours).padStart(2, '0')}h`;
        if (hours > 0) return `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    // Highest configured NOTIFY_AT point this row has reached, or null. Sorted
    // descending so the answer is the most severe one crossed, not the first.
    function crossedThreshold(pct) {
        if (pct == null) return null;
        const sorted = [...CONFIG.NOTIFY_AT].sort((a, b) => b - a);
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
    //
    // Split in two because a document stylesheet does not cross a shadow
    // boundary. The nav the ribbon docks into is nested several open shadow
    // roots deep, so once the ribbon is appended in there, nothing in the
    // document's <head> styles it any more — it renders as unstyled inline
    // text, measures ~0 high, and fails its own dock verification. RIBBON_CSS is
    // therefore also injected into whichever root the ribbon ends up in (see
    // adoptRibbonStyles). PANEL_CSS never needs this: the list stays on
    // document.body precisely so it can't be clipped or unstyled by the header.
    const RIBBON_CSS = `
        #olaRibbon, #olaRibbon * { box-sizing: border-box !important; }

        /* The ribbon and the list are two separate nodes, because the ribbon has
           to live INSIDE ServiceNow's nav container while the list must not:
           anchoring the list to document.body keeps it clear of whatever
           overflow/clipping the header chrome applies to its own children. The
           palette below is repeated in PANEL_CSS rather than shared in one
           selector — these two blocks are injected into different roots, so a
           rule naming both nodes would only ever match one of them. */
        #olaRibbon {
            /* Polaris nav palette. --nav-dim is #a8bcbe (6.1:1 on --nav); the more
               obvious #8fa3a5 measures 4.0:1 and fails AA for the 10.5px text. */
            --nav: #293e40; --nav-hi: #33494b; --nav-line: rgba(255,255,255,0.13);
            --nav-txt: #e3ebec; --nav-dim: #a8bcbe; --nav-cap: #93a9ab;
            --crit: #ff6b6b; --warn: #f5b544;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            color: var(--nav-txt) !important;
            /* Above the ACK monitor's #sdmStatusIndicator (999998). Docked, this
               also has to clear the header's own stacking context so the ribbon
               isn't painted under a neighbouring tab. */
            z-index: 999999 !important;
        }

        /* Always mounted and always visible in one of two modes — there is no
           display:none gate. .olaDocked is the ribbon sitting in the Polaris nav
           beside All / Favorites / History; .olaCorner is the standalone fixed
           corner it falls back to. */
        #olaRibbon {
            display: flex !important; align-items: center !important; gap: 5px !important;
            margin: 0 !important;
            font-size: 10px !important; letter-spacing: 0.08em !important; text-transform: uppercase !important;
            color: var(--nav-cap) !important;
            cursor: pointer !important;
            white-space: nowrap !important;
        }

        /* Docked: a compact pill, absolutely positioned like every other tab in
           that container. left/top/height are written by layoutRibbon from the
           real tabs' measured geometry — never assumed here, because the nav
           positions its own children with inline styles it recomputes. */
        #olaRibbon.olaDocked {
            position: absolute !important;
            padding: 0 9px !important;
            border-radius: 7px !important;
            background: rgba(255,255,255,0.09) !important;
            border: 1px solid var(--nav-line) !important;
        }
        #olaRibbon.olaDocked:hover { background: rgba(255,255,255,0.17) !important; }
        /* Expanded reads as pressed, the way an open menu tab does. */
        #olaRibbon.olaDocked.olaExpanded { background: rgba(255,255,255,0.17) !important; }

        /* Corner: the original standalone header, unchanged. */
        #olaRibbon.olaCorner {
            position: fixed !important;
            top: ${CONFIG.PANEL_TOP}px !important;
            left: ${CONFIG.PANEL_LEFT}px !important;
            width: ${CONFIG.PANEL_WIDTH}px !important;
            padding: 9px 10px !important;
            background: var(--nav) !important;
            border: 1px solid var(--nav-line) !important;
            border-radius: 10px !important;
            box-shadow: 0 6px 20px -4px rgba(0,0,0,0.45) !important;
        }
        #olaRibbon.olaCorner:hover { background: var(--nav-hi) !important; }
        /* Corner mode anchors the list flush underneath, so the two nodes have to
           read as one box: the seam between them loses its radius. */
        #olaRibbon.olaCorner.olaExpanded {
            border-bottom: 1px solid var(--nav-line) !important;
            border-radius: 10px 10px 0 0 !important;
        }

        /* Ribbon contents. These ride with RIBBON_CSS because they only ever
           appear inside the ribbon, and so have to reach the same root it does. */
        .olaChevron { font-size: 9px !important; color: var(--nav-dim) !important; flex: 0 0 auto !important; }
        .olaTitle { font-size: 10px !important; letter-spacing: 0.08em !important; flex: 1 1 auto !important; }
        .olaCount { font-weight: 700 !important; color: var(--nav-txt) !important; }
        .olaHeaderBtns { display: flex !important; gap: 4px !important; flex: 0 0 auto !important; }
        .olaIconBtn {
            background: transparent !important; border: none !important; border-radius: 4px !important;
            padding: 3px !important; margin: 0 !important; cursor: pointer !important;
            color: var(--nav-dim) !important; font-size: 11px !important; line-height: 1 !important;
            box-shadow: none !important;
        }
        .olaIconBtn:hover { background: var(--nav-hi) !important; color: var(--nav-txt) !important; }
    `;

    const PANEL_CSS = `
        #olaPanel, #olaPanel * { box-sizing: border-box !important; }
        #olaPanel {
            --nav: #293e40; --nav-hi: #33494b; --nav-line: rgba(255,255,255,0.13);
            --nav-txt: #e3ebec; --nav-dim: #a8bcbe; --nav-cap: #93a9ab;
            --crit: #ff6b6b; --warn: #f5b544;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            color: var(--nav-txt) !important;
            z-index: 999999 !important;

            position: fixed !important;
            display: none !important;
            flex-direction: column !important;
            width: ${CONFIG.PANEL_WIDTH}px !important;
            padding: 0 !important;
            background: var(--nav) !important;
            border: 1px solid var(--nav-line) !important;
            border-radius: 10px !important;
            box-shadow: 0 6px 20px -4px rgba(0,0,0,0.45) !important;
        }
        #olaPanel.olaExpanded { display: flex !important; }
        #olaPanel.olaUnderCorner { border-radius: 0 0 10px 10px !important; border-top: none !important; }

        /* Collapsed to just the ribbon by default; .olaExpanded (toggled by
           clicking the ribbon, or forced on by setStatus on an error) reveals
           the list and status line, which live in #olaPanel and are shown by the
           #olaPanel.olaExpanded rule above. */
        .olaBody {
            max-height: min(46vh, 380px) !important;
            overflow-y: auto !important;
            overscroll-behavior: contain !important;
            padding: 6px 8px 0 8px !important;
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
        .olaStatus { font-size: 10px !important; color: var(--nav-cap) !important; text-align: center !important; padding: 7px 8px 9px !important; }
        .olaStatus.olaErr { color: var(--crit) !important; }
    `;

    GM_addStyle(RIBBON_CSS + PANEL_CSS);

    // Gets RIBBON_CSS into whichever root the ribbon is living in. For the
    // document that is already done above; for a shadow root it is not, and
    // without it the ribbon is unstyled markup in there — no size, no position,
    // no colours — which its own verification then correctly rejects.
    //
    // A constructed stylesheet rather than a <style> element: SNOW's CSP has no
    // 'unsafe-inline' in style-src, which drops a <style> we build ourselves
    // (the same reason this script uses GM_addStyle at all). Constructed sheets
    // aren't parsed from markup and aren't subject to it. The <style> path stays
    // as a fallback for anything without adoptedStyleSheets.
    const styledRoots = new WeakSet();
    function adoptRibbonStyles(root) {
        if (!root || root === document || root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
        if (styledRoots.has(root)) return;
        styledRoots.add(root);
        try {
            if ('adoptedStyleSheets' in root && typeof CSSStyleSheet === 'function') {
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(RIBBON_CSS);
                root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
                return;
            }
        } catch (e) {
            console.warn('[OLA Watch] adoptedStyleSheets refused, falling back to <style>', e);
        }
        const style = document.createElement('style');
        style.textContent = RIBBON_CSS;
        root.appendChild(style);
    }

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
    // Two nodes: the ribbon (always visible, docked into ServiceNow's nav when
    // that can be verified, otherwise a fixed corner) and the panel holding the
    // list + status, which always hangs off document.body and is positioned
    // under the ribbon at runtime.
    let panel = null;
    let ribbon = null;
    let muteBtn = null;

    function syncMuteBtn() {
        if (!muteBtn) return;
        const muted = isMuted();
        muteBtn.textContent = muted ? '🔕' : '🔔';
        muteBtn.title = muted ? 'Unmute alerts' : 'Mute sound + notifications for 4h (all tabs)';
    }

    // Starts collapsed, expands on click (the header itself is the toggle —
    // clicking anywhere on it except the icon buttons flips panelExpanded)
    // or automatically when there's an error to show. Plain user control
    // otherwise: nothing here forces it back open once the agent has seen an
    // at-risk ticket and collapsed it, since GM_notification + the alert
    // sound are the actual alerting mechanism — this panel is a convenience
    // view on top of that, not the thing responsible for getting attention.
    let panelExpanded = false;

    function buildPanel() {
        panel = document.createElement('div');
        panel.id = 'olaPanel';

        // Starts in corner mode. tryDock() promotes it into the nav only once
        // it has proved the result is visible and unobstructed, so the worst case
        // is the layout this script already had.
        ribbon = document.createElement('div');
        ribbon.id = 'olaRibbon';
        ribbon.className = 'olaCorner';
        // role/tabindex so it reads as what it is once it's sitting in a
        // role="menu" container alongside ServiceNow's own menuitems.
        ribbon.setAttribute('role', 'menuitem');
        ribbon.setAttribute('tabindex', '0');
        ribbon.setAttribute('aria-label', 'OLA Watch');
        ribbon.setAttribute('aria-haspopup', 'true');

        const header = ribbon;
        header.title = 'Click to expand/collapse';
        const chevron = el('span', 'olaChevron', '▸');
        chevron.id = 'olaChevron';
        header.appendChild(chevron);
        const title = el('span', 'olaTitle', '⏱ OLA Watch · ');
        const count = el('b', 'olaCount', '0');
        count.id = 'olaCount';
        title.appendChild(count);
        header.appendChild(title);
        const btns = el('div', 'olaHeaderBtns');

        muteBtn = el('button', 'olaIconBtn', '🔔');
        muteBtn.addEventListener('click', e => { e.stopPropagation(); toggleMute(); syncMuteBtn(); });
        syncMuteBtn();

        const refreshBtn = el('button', 'olaIconBtn', '⟳');
        refreshBtn.title = 'Refresh now (also reconnects if the session expired)';
        refreshBtn.addEventListener('click', e => { e.stopPropagation(); forcePoll(); });

        btns.append(muteBtn, refreshBtn);
        header.appendChild(btns);

        const toggle = e => {
            if (e.target.closest('button')) return;
            panelExpanded = !panelExpanded;
            renderPanel();
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            toggle(e);
        });

        const body = el('div', 'olaBody');
        body.id = 'olaBody';

        const status = el('div', 'olaStatus', 'starting…');
        status.id = 'olaStatus';

        panel.append(body, status);
        document.body.append(ribbon, panel);
        positionPanel();
    }

    // ─── DOCKING INTO THE POLARIS NAV ────────────────────────────────────────
    // The nav container holds absolutely-positioned `.sn-polaris-tab` children
    // whose `left` ServiceNow computes and recomputes itself (they animate, they
    // shuffle when one is pinned, and they carry an `unpinnedleft` attribute for
    // the position they return to). Nothing here hard-codes any of that: the
    // ribbon is placed after the measured right edge of the last real tab, and
    // re-placed whenever the nav moves anything.
    let dockHost = null;
    let dockMode = 'corner';           // 'docked' | 'corner'
    let dockNote = 'not attempted yet';
    let dockHostMinWidth = null;       // the host's own inline min-width, to restore
    let dockObservers = [];
    let applyingLayout = false;        // our own writes must not re-trigger the observers
    // Set once a found-but-unusable nav has been rejected for good. Without it the
    // startup poller keeps re-attempting every POLL_MS, and since each attempt
    // appends the ribbon before it can verify anything, the agent watches it flick
    // between the nav and the corner twice a second for two minutes.
    let dockGaveUp = false;
    let dockPending = false;           // one attempt chain at a time

    // querySelector that also descends into open shadow roots. Polaris is a
    // web-component UI, so the nav can legitimately sit inside one — and a plain
    // document.querySelector would report "not on this page" for a node that is
    // very much on this page. Closed roots stay invisible, which is what the
    // corner fallback is for.
    function deepQuery(root, selector, depth = 0) {
        const direct = root.querySelector && root.querySelector(selector);
        if (direct) return direct;
        if (depth > 12) return null;
        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const node of all) {
            if (!node.shadowRoot) continue;
            const hit = deepQuery(node.shadowRoot, selector, depth + 1);
            if (hit) return hit;
        }
        return null;
    }

    function findDockHost() {
        for (const selector of CONFIG.DOCK.HOST_SELECTORS) {
            const host = deepQuery(document, selector);
            if (host) return { host, selector };
        }
        return null;
    }

    // The x (in the tabs' own coordinate space) of the first position that clears
    // every existing tab. Pure arithmetic over measured rects, kept separate from
    // the DOM so the self-test can exercise the no-overlap rule directly.
    // Zero-width tabs are skipped: `#nav-overflow` is an `is-placeholder` when the
    // menus fit, and a placeholder that reserves 40px of gap it isn't using would
    // leave the ribbon floating away from the row.
    function firstFreeX(originX, tabRects, gap) {
        let right = 0;
        for (const r of tabRects) {
            if (!r || r.width <= 0) continue;
            right = Math.max(right, r.right - originX);
        }
        return Math.round(right + gap);
    }

    // The x that `left: 0` would put an absolutely-positioned child at — i.e. the
    // origin of the coordinate space the nav writes its tabs' inline `left` in.
    //
    // Derived from a real tab (measured x minus its own declared left) rather
    // than from ribbon.offsetParent, which is not reliable here: offsetParent is
    // specified to return null across a shadow boundary, and this nav sits
    // several open shadow roots deep. Reading it from a tab needs no guess about
    // which ancestor establishes the containing block — whatever it is, the tabs
    // are already positioned against it, and so is the ribbon beside them.
    // Falls back to the host's own left edge when no tab declares an inline left.
    function tabOriginX(host, hostLeft) {
        for (const tab of host.querySelectorAll(CONFIG.DOCK.TAB_SELECTOR)) {
            if (tab === ribbon || ribbon.contains(tab)) continue;
            const declared = parseFloat(tab.style.left);
            if (!Number.isFinite(declared)) continue;
            const rect = tab.getBoundingClientRect();
            if (rect.width <= 0) continue;
            return rect.left - declared;
        }
        return hostLeft;
    }

    function tabRectsIn(host) {
        return [...host.querySelectorAll(CONFIG.DOCK.TAB_SELECTOR)]
            .filter(t => t !== ribbon && !ribbon.contains(t))
            .map(t => t.getBoundingClientRect());
    }

    function rectsOverlap(a, b) {
        // 1px of tolerance: sub-pixel layout routinely leaves neighbouring boxes
        // sharing a fractional edge, and that is touching, not overlapping.
        return a.left < b.right - 1 && b.left < a.right - 1
            && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    }

    // Places the ribbon after the last tab and widens the host to actually
    // reserve that space. The min-width matters: the tabs are absolutely
    // positioned, so they take no width of their own, and without it the ribbon
    // would be drawn over whatever the header puts to the right of the menu
    // instead of pushing it along.
    function layoutRibbon() {
        if (dockMode !== 'docked' || !ribbon || !dockHost || !dockHost.isConnected) return;
        const originRect = dockHost.getBoundingClientRect();
        const rects = tabRectsIn(dockHost);
        const originX = tabOriginX(dockHost, originRect.left);
        const left = firstFreeX(originX, rects, CONFIG.DOCK.GAP_PX);

        // Vertical geometry is copied from a real tab rather than guessed — the
        // tabs set no `top` at all, so matching one is the only way to sit on
        // their baseline whatever the header's height turns out to be.
        const ref = rects.find(r => r.height > 0);
        const top = ref ? Math.round(ref.top - originRect.top) : null;
        const height = ref ? Math.round(ref.height) : null;
        const needed = Math.ceil(left + ribbon.offsetWidth + CONFIG.DOCK.TAIL_PX);

        // Writing values that are already there is not free: widening the host is
        // a change to ServiceNow's own layout, which can move the tabs, which
        // brings us back here. Bailing on a no-op is what stops that settling
        // into a loop instead of settling.
        const unchanged = ribbon.style.left === left + 'px'
            && (top === null || ribbon.style.top === top + 'px')
            && (height === null || ribbon.style.height === height + 'px')
            && Math.ceil(parseFloat(dockHost.style.minWidth) || 0) === needed;
        if (unchanged) return;

        applyingLayout = true;
        try {
            ribbon.style.left = left + 'px';
            if (ref) {
                ribbon.style.top = top + 'px';
                ribbon.style.height = height + 'px';
            }
            dockHost.style.minWidth = needed + 'px';
        } finally {
            applyingLayout = false;
        }

        // Placement is only as good as the room available. If the nav's own tabs
        // have grown far enough right that clearing them puts the ribbon past the
        // edge of the window, there is no position in that container that works,
        // and staying docked would mean a ribbon the agent can't see or click.
        const r = ribbon.getBoundingClientRect();
        if (r.left >= window.innerWidth - 8 || r.right <= 0) {
            dockGaveUp = true;
            undock('corner fallback — no room left in the nav for the ribbon');
            console.warn(`[OLA Watch] ${dockNote}`);
            renderPanel();
            return;
        }
        positionPanel();
    }

    let layoutQueued = false;
    function scheduleLayout() {
        if (applyingLayout || layoutQueued) return;
        layoutQueued = true;
        requestAnimationFrame(() => { layoutQueued = false; layoutRibbon(); });
    }

    // elementFromPoint stops at a shadow host, so a hit test that doesn't
    // recurse would report the ribbon as "covered" by the very component it
    // lives inside.
    function topmostAt(x, y) {
        let node = document.elementFromPoint(x, y);
        while (node && node.shadowRoot) {
            const inner = node.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === node) break;
            node = inner;
        }
        return node;
    }

    // The check the two earlier docking attempts never had: does the ribbon
    // actually end up on screen, unobstructed, and clear of the nav's own tabs?
    // Returns null when the dock is good, or a human-readable reason to abandon
    // it. Everything here is measured after layout, never assumed.
    function verifyDock() {
        if (!ribbon.isConnected) return 'ribbon did not stay attached';
        const r = ribbon.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return 'ribbon has no size in the nav';
        if (r.right <= 0 || r.bottom <= 0 || r.left >= window.innerWidth || r.top >= window.innerHeight) {
            return 'ribbon landed off-screen';
        }
        for (const tabRect of tabRectsIn(dockHost)) {
            if (tabRect.width > 0 && rectsOverlap(r, tabRect)) return 'ribbon overlaps a nav tab';
        }
        // Hit-test near the left edge rather than the centre: the centre can land
        // on the title text, which is a child and reports as itself.
        const hit = topmostAt(Math.round(r.left + Math.min(6, r.width / 2)), Math.round(r.top + r.height / 2));
        if (!hit) return 'nothing hit-tests where the ribbon is';
        if (hit !== ribbon && !ribbon.contains(hit)) {
            return `ribbon is painted under <${String(hit.tagName || '?').toLowerCase()}>`;
        }
        return null;
    }

    function disconnectDockObservers() {
        dockObservers.forEach(o => { try { o.disconnect(); } catch { /* already gone */ } });
        dockObservers = [];
    }

    // Back to the corner, leaving the host exactly as it was found — including
    // its own inline min-width, which we may have widened.
    function undock(reason) {
        disconnectDockObservers();
        if (dockHost && dockHostMinWidth !== null) {
            if (dockHostMinWidth) dockHost.style.minWidth = dockHostMinWidth;
            else dockHost.style.removeProperty('min-width');
        }
        dockHost = null;
        dockHostMinWidth = null;
        dockMode = 'corner';
        if (ribbon) {
            ribbon.style.removeProperty('left');
            ribbon.style.removeProperty('top');
            ribbon.style.removeProperty('height');
            ribbon.className = 'olaCorner' + (panelExpanded ? ' olaExpanded' : '');
            document.body.appendChild(ribbon);
        }
        if (reason) dockNote = reason;
        positionPanel();
    }

    function observeDock() {
        disconnectDockObservers();
        if (!dockHost) return;
        // The nav rewrites its children's inline `left` (and `unpinnedleft`) as
        // tabs pin, unpin and animate; anything that moves a tab has to move the
        // ribbon too, or the gap it was placed in stops being free.
        const mo = new MutationObserver(records => {
            if (applyingLayout) return;
            if (records.every(rec => rec.target === ribbon || ribbon.contains(rec.target))) return;
            scheduleLayout();
        });
        mo.observe(dockHost, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ['style', 'class', 'unpinnedleft']
        });
        dockObservers.push(mo);

        if (typeof ResizeObserver === 'function') {
            const ro = new ResizeObserver(() => scheduleLayout());
            ro.observe(dockHost);
            dockObservers.push(ro);
        }
        // `can-animate` on the tabs means their final position arrives one
        // transition later than the mutation that started it.
        const onTransition = e => { if (e.target !== ribbon) scheduleLayout(); };
        dockHost.addEventListener('transitionend', onTransition, true);
        dockObservers.push({ disconnect: () => dockHost && dockHost.removeEventListener('transitionend', onTransition, true) });
    }

    // One docking attempt. Verification is deferred by two frames because the
    // nav animates: measuring in the same tick as the append reads a tab
    // mid-transition and would reject a dock that settles fine a frame later.
    // A rejected attempt restores everything before falling back.
    function tryDock(attempt = 0) {
        if (!CONFIG.DOCK.ENABLED || !ribbon || dockMode === 'docked' || dockGaveUp) return;
        if (attempt === 0 && dockPending) return;
        const found = findDockHost();
        if (!found) { dockNote = 'nav container not found yet'; return; }

        dockPending = true;
        dockHost = found.host;
        dockHostMinWidth = dockHost.style.minWidth || '';
        dockMode = 'docked';
        ribbon.className = 'olaDocked' + (panelExpanded ? ' olaExpanded' : '');
        dockHost.appendChild(ribbon);
        // Before any measuring: inside a shadow root the ribbon has no styles
        // until this runs, so laying out or verifying first would measure an
        // unstyled box and reject a dock that is actually fine.
        adoptRibbonStyles(ribbon.getRootNode());
        layoutRibbon();

        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (dockMode !== 'docked') { dockPending = false; return; }
            layoutRibbon();
            const problem = verifyDock();
            if (!problem) {
                dockPending = false;
                dockNote = `docked into ${found.selector}`;
                observeDock();
                renderPanel();
                console.log(`[OLA Watch] ribbon ${dockNote}`);
                return;
            }
            // Two more tries before giving up: the nav can still be settling.
            if (attempt < 2) {
                undock(`retrying dock — ${problem}`);
                setTimeout(() => tryDock(attempt + 1), 400);
                return;
            }
            // Found the nav, can't use it. Retrying that forever would just be a
            // flicker, so this is final until __olaWatchDebug.dock() asks again.
            // (A nav rebuilt under a working dock is a different path, and
            // ensurePanelAttached still re-docks for that one.)
            dockPending = false;
            dockGaveUp = true;
            undock(`corner fallback — ${problem}`);
            console.warn(`[OLA Watch] ${dockNote}`);
            renderPanel();
        }));
    }

    // The nav is built by ServiceNow's own JS long after this script runs, so the
    // host is polled for rather than read once. Giving up costs only the dock —
    // the corner is a working UI — so this waits minutes, not seconds.
    function startDocking() {
        if (!CONFIG.DOCK.ENABLED) { dockNote = 'disabled in CONFIG'; return; }
        const deadline = Date.now() + CONFIG.DOCK.MAX_WAIT_MS;
        const timer = setInterval(() => {
            if (dockMode === 'docked' || dockGaveUp || Date.now() > deadline) {
                clearInterval(timer);
                if (dockMode !== 'docked' && !dockGaveUp) {
                    dockNote = 'corner fallback — nav container never appeared';
                }
                return;
            }
            tryDock();
        }, CONFIG.DOCK.POLL_MS);
        tryDock();
    }

    // The list hangs off document.body rather than the nav, so it can't be
    // clipped by the header's own overflow — which means its position has to be
    // written from the ribbon's measured box every time either one moves.
    function positionPanel() {
        if (!panel || !ribbon) return;
        const docked = dockMode === 'docked';
        panel.classList.toggle('olaUnderCorner', !docked);
        const r = ribbon.getBoundingClientRect();
        // Corner mode keeps the two boxes flush, so they read as the single panel
        // this used to be; docked, the list is a dropdown clear of the nav.
        const top = r.bottom + (docked ? 6 : 0);
        // Left-aligned with the ribbon by default; right-aligned to it when that
        // would run off the edge. Docked, the ribbon sits at the right-hand end
        // of the nav, so left-aligning a 248px list there routinely overflows —
        // and a list that just slides left until it fits reads as detached from
        // the thing it belongs to. Clamping is the last resort, for a viewport
        // too narrow for either.
        const overflowsLeftAligned = r.left + CONFIG.PANEL_WIDTH > window.innerWidth - 6;
        const preferred = overflowsLeftAligned ? r.right - CONFIG.PANEL_WIDTH : r.left;
        const maxLeft = window.innerWidth - CONFIG.PANEL_WIDTH - 6;
        const left = Math.max(6, Math.min(preferred, Math.max(6, maxLeft)));
        panel.style.left = Math.round(left) + 'px';
        panel.style.top = Math.round(top) + 'px';
    }

    // A detached ribbon or panel is the one failure a fixed corner couldn't have
    // (a full page teardown/rebuild, an extension conflict) — and, docked, the
    // nav being rebuilt under us. Re-checked every second.
    function ensurePanelAttached() {
        if (panel && !panel.isConnected) document.body.appendChild(panel);
        if (!ribbon) return;
        if (dockMode === 'docked') {
            if (!ribbon.isConnected || !dockHost || !dockHost.isConnected) {
                // The nav was replaced: re-dock against the new one rather than
                // leaving the ribbon stranded in a container nobody can see.
                undock('nav was rebuilt — re-docking');
                tryDock();
            } else {
                layoutRibbon();
            }
        } else if (!ribbon.isConnected) {
            document.body.appendChild(ribbon);
        }
    }


    // The panel itself is always mounted and visible now (no more
    // display:none gate) — collapsed to just its header by default, expanded
    // by a user click. An error is worth overriding that: it forces
    // panelExpanded open here rather than depending on every call site to
    // remember to do it, so a genuine problem is never sitting collapsed and
    // unseen behind a manual toggle the agent hasn't touched yet.
    function setStatus(text, isError = false) {
        // Queried through panel, not document.getElementById: a panel that's
        // been detached (however briefly, before the next ensurePanelAttached
        // tick re-attaches it) still has a live subtree — document.getElementById
        // only finds connected nodes, so it would silently no-op on exactly
        // the tab that most needs a visible message.
        if (!panel) return;
        const s = panel.querySelector('#olaStatus');
        if (!s) return;
        s.textContent = text;
        s.classList.toggle('olaErr', isError);
        if (isError) {
            panelExpanded = true;
            panel.classList.add('olaExpanded');
            if (ribbon) ribbon.classList.add('olaExpanded');
            positionPanel();
        }
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

        // Same reasoning as setStatus: query through panel, not
        // document.getElementById, so a briefly-detached panel still renders
        // instead of silently no-op'ing on `!body`.
        const body = panel.querySelector('#olaBody');
        if (!body) return;

        panel.classList.toggle('olaExpanded', panelExpanded);
        ribbon.classList.toggle('olaExpanded', panelExpanded);
        ribbon.setAttribute('aria-expanded', String(panelExpanded));
        const chevron = ribbon.querySelector('#olaChevron');
        if (chevron) chevron.textContent = panelExpanded ? '▾' : '▸';
        positionPanel();

        body.replaceChildren();
        const myId = getMyId();

        const isCrit = row => { const p = computePct(row); return p != null && p >= CONFIG.CRIT_AT; };

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

        const countEl = ribbon.querySelector('#olaCount');
        if (countEl) countEl.textContent = String(rows.length);
        // The ribbon's own width changes with the count (1 → 12 rows), and docked
        // that width is what the reserved space in the nav is measured from.
        if (dockMode === 'docked') scheduleLayout();

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

        // Only rows past SHOW_AT reach the panel; everything else is a healthy
        // ticket (or a row computePct couldn't yet trust) and would just be noise.
        const atRisk = rows.filter(row => {
            const pct = computePct(row);
            return pct != null && pct >= CONFIG.SHOW_AT;
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

            // Fire every not-yet-fired NOTIFY_AT point at or below the current one,
            // so a ticket that jumps past an earlier point straight to a later one
            // between polls (a long tab sleep, a laptop resuming from suspend)
            // still records all of them rather than leaving the earlier one armed
            // to fire later.
            CONFIG.NOTIFY_AT.filter(t => t <= threshold && !entry.fired.includes(t))
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

    // Persists an error into SHARED state, not just a local setStatus call.
    // renderPanel rewrites the status line's TEXT from state.error on every
    // run (`if (state.error) setStatus('Error: ' + state.error) else
    // setStatus('updated ...')`), and it's called on a bare 15s catch-up
    // timer independent of anything that just happened locally — so an
    // error that only ever touched setStatus() directly, without also
    // landing in state.error, would have its message overwritten back to
    // "updated —" the next time that timer fires, even though panelExpanded
    // itself would stay true (nothing else resets it). Also repaints THIS
    // tab immediately, for the same reason pollOnce does: a tab can't rely
    // on hearing its own GM storage write echoed back as a value-change
    // event.
    function reportError(message) {
        setSharedState({ ...getSharedState(), error: message });
        if (takesInFlight === 0) renderPanel();
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
                reportError('Session expired — click ⟳ to reconnect');
                return;
            }
            sessionBroken = false;
        }

        // Never volunteer if this tab can't do the work. Staking the claim makes
        // every other tab stand down, so a tab that then bails would silently
        // suppress polling everywhere.
        if (!getMyId()) {
            reportError('No user id on this page');
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
            console.error('[OLA Watch] poll failed', e);
            reportError(e.message);
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
    startDocking();
    // Docked, the ribbon moves with the header; either way the list is a fixed
    // box that has to be re-anchored when anything moves under it. Capture-phase
    // scroll so a scroll inside SNOW's own containers counts, not just the window.
    window.addEventListener('resize', () => { scheduleLayout(); positionPanel(); });
    window.addEventListener('scroll', () => positionPanel(), true);
    setInterval(tickClocks, 1000);
    setInterval(() => { if (takesInFlight === 0) renderPanel(); }, 15000); // catch TTL/stale drift
    setInterval(ensurePanelAttached, 1000);
    setInterval(pollCycle, CONFIG.POLL_TICK_MS);
    pollCycle();

    document.addEventListener('visibilitychange', () => { if (isVisible()) pollCycle(); });

    // ─── DEBUG / SELF-CHECK (console) ────────────────────────────────────────
    // Assigned to pageWindow (== unsafeWindow), not the bare `window` above it.
    // A non-"none" @grant runs this script in Tampermonkey's isolated sandbox,
    // where `window` is a DIFFERENT object from the real page's — the exact
    // reason pageWindow exists at all (to reach g_ck/g_user_id on the real
    // page). window.__olaWatchDebug = {...} was reachable from code running
    // IN the sandbox, but invisible to anything typed directly into DevTools,
    // which always evaluates against the real page's window. Also kept on
    // `window` for a hypothetical @grant none run, where they're the same object.
    const debugApi = {
        version: SCRIPT_VERSION,
        forcePoll,
        state: () => getSharedState(),
        ledger: () => getLedger(),
        clearLedger() { GM_deleteValue(LEDGER_KEY); console.log('[OLA Watch] ledger cleared'); },
        sessionStatus() {
            console.log('[OLA Watch] sessionBroken:', sessionBroken, '| have token:', !!sessionToken);
            return { sessionBroken, hasToken: !!sessionToken };
        },

        // Answers both "why can't I see the panel?" and "why didn't it dock?".
        // `dock` is the reason in words — the nav never appeared, or it appeared
        // and the ribbon failed verification (off-screen, covered, overlapping a
        // tab), each of which sends it back to the corner rather than leaving a
        // ribbon nobody can see. If attached+rect look right here and it is STILL
        // not on screen, that points at something outside this script's logic
        // (another element painted on top, a page-level CSS transform).
        panelStatus() {
            const info = {
                attached: !!(panel && panel.isConnected),
                ribbonAttached: !!(ribbon && ribbon.isConnected),
                expanded: panelExpanded,
                mode: dockMode,
                dock: dockNote,
                dockHostFound: !!findDockHost(),
                ribbonRect: ribbon ? ribbon.getBoundingClientRect() : null,
                rect: panel ? panel.getBoundingClientRect() : null,
                overlapsATab: dockMode === 'docked' && ribbon
                    ? tabRectsIn(dockHost).some(t => t.width > 0 && rectsOverlap(ribbon.getBoundingClientRect(), t))
                    : false
            };
            console.log('[OLA Watch] panel:', info);
            return info;
        },

        // Force the ribbon between the two layouts without reloading — for
        // checking the corner fallback still looks right, or for retrying the
        // dock after the nav has finished building.
        dock() { dockGaveUp = false; if (dockMode !== 'docked') tryDock(); return dockNote; },
        undock() { dockGaveUp = true; undock('corner forced from the console'); renderPanel(); return dockNote; },
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

        // Why is THAT ticket showing THAT number? Prints the inputs behind every
        // row's percentage and countdown — including which time base clockPauses()
        // picked and why — so a disagreement with ServiceNow's own percentage can
        // be read off directly instead of inferred. `span` and `duration` being
        // equal is what makes a row continuous; a `span` much larger than
        // `duration` is the engine having skipped non-working time.
        async explain() {
            const rows = await fetchOlaRows(await resolveGroupSysId());
            const mins = ms => (ms == null ? '—' : (ms / 60000).toFixed(0) + 'm');
            const table = rows.map(r => {
                const s = parseSnowUtc(r.start), e = parseSnowUtc(r.plannedEnd);
                const pauses = clockPauses(r);
                const pct = computePct(r);
                return {
                    ticket: r.number,
                    start: r.start,
                    plannedEnd: r.plannedEnd,
                    span: s != null && e != null ? mins(e - s) : '—',
                    duration: mins(parseSnowDuration(r.slaDuration)),
                    schedule: r.slaSchedule ? (r.scheduleSource || 'sla_definition') : '(none)',
                    clock: pauses == null ? 'unknown' : (pauses ? 'pauses' : 'continuous'),
                    pct: pct == null ? '—' : pct.toFixed(1) + '%',
                    serverPct: r.serverPct + '%',
                    left: fmtRemaining(msRemaining(r))
                };
            });
            console.table(table);
            return table;
        },

        // Pure-logic self-check: the clock maths and threshold bookkeeping are the
        // parts that silently do the wrong thing, and they're the parts a live
        // instance can't easily be made to demonstrate on demand.
        selfTest() {
            const fails = [];
            let ran = 0;
            // Counted rather than hard-coded in the "passed (N checks)" line below,
            // which otherwise silently goes stale every time a check is added.
            const check = (name, cond) => { ran++; if (!cond) fails.push(name); };

            const iso = ms => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
            // Fixed calendar points, not "now minus N" — computePct is schedule-aware,
            // so its answer depends on which real calendar days/hours a window falls
            // on. Pinning start/end/now to known dates (and passing nowMs explicitly)
            // keeps the test deterministic instead of it passing or failing depending
            // on what day the suite happens to run.
            const pIso = (y, m, d, hh, mi) => iso(parisLocalToUtc(y, m, d, hh, mi));
            const pMs  = (y, m, d, hh, mi) => parisLocalToUtc(y, m, d, hh, mi);
            // Rows carry whichever of the clockPauses() signals the case is about.
            // PAUSING marks an OLA whose definition has a schedule (so the clock
            // stops outside it); a `slaDuration` matching the row's own span marks
            // one that runs continuously.
            const PAUSING = { slaSchedule: 'e'.repeat(32) };
            const row = (startIso, endIso, extra) => ({ start: startIso, plannedEnd: endIso, serverPct: 0, ...extra });

            // Tue 2026-08-04, a plain business day: 10:00–11:00 Paris is a 60
            // business-minute OLA entirely inside the 08:00–19:00 window.
            const sameDay = row(pIso(2026, 8, 4, 10, 0), pIso(2026, 8, 4, 11, 0), PAUSING);
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
            const spansWeekend = row(pIso(2026, 8, 7, 18, 0), pIso(2026, 8, 10, 10, 0), PAUSING);
            const atFridayClose = computePct(spansWeekend, pMs(2026, 8, 7, 19, 0)); // Friday's window has just closed: 1 of 3 business hours spent
            check('schedule-aware, not wall-clock (Friday close = 1/3)', Math.abs(atFridayClose - (100 / 3)) < 0.5);
            const midWeekend = computePct(spansWeekend, pMs(2026, 8, 8, 12, 0)); // Saturday afternoon: no business hours have passed since Friday close
            check('weekend adds no business time', Math.abs(midWeekend - atFridayClose) < 0.01);

            // Bastille Day 2026-07-14 (Tuesday) is a French holiday: an OLA window
            // entirely inside it has zero business hours, so computePct falls back
            // to serverPct rather than dividing by zero.
            const onHoliday = row(pIso(2026, 7, 14, 8, 0), pIso(2026, 7, 14, 19, 0), { ...PAUSING, serverPct: 42 });
            check('holiday window falls back to serverPct', computePct(onHoliday, pMs(2026, 7, 14, 12, 0)) === 42);

            // A row with a missing/unparseable start_time (the just-created-ticket
            // race that let a fresh SLA flash straight to "breaching soon" on a
            // stale serverPct) must NOT fall back to serverPct — it should read as
            // unknown (null, excluded from the panel) until the next poll resolves it.
            const missingStart = { start: '', plannedEnd: pIso(2026, 8, 4, 11, 0), serverPct: 80 };
            check('missing start_time does not trust serverPct', computePct(missingStart, pMs(2026, 8, 4, 10, 1)) === null);
            const missingEnd = { start: pIso(2026, 8, 4, 10, 0), plannedEnd: '', serverPct: 80 };
            check('missing planned_end_time does not trust serverPct', computePct(missingEnd, pMs(2026, 8, 4, 10, 1)) === null);

            // ── The 18:32 ticket ────────────────────────────────────────────────
            // The case this whole branch exists for, with its real numbers: a
            // 1-hour OLA opened at 18:32 on a business day, deadline 19:32 — a
            // wall-clock hour later, so the SLA engine inserted no non-working
            // time and this clock plainly does not pause at 19:00. 21 minutes in
            // it is 35% consumed, not 75%: applying CONFIG.SCHEDULE to it counted
            // only the 28 minutes before the close as its window (21/28), which
            // both crossed CRIT_AT and fired the 75% notification on a ticket
            // with 39 minutes still on the clock.
            const HOUR = 60 * 60 * 1000;
            const continuous = row(pIso(2026, 8, 4, 18, 32), pIso(2026, 8, 4, 19, 32), { slaDuration: '1970-01-01 01:00:00' });
            const at1853 = pMs(2026, 8, 4, 18, 53);
            check('24/7 OLA across the close reads 35%', Math.abs(computePct(continuous, at1853) - 35) < 0.5);
            check('24/7 OLA across the close is not critical', computePct(continuous, at1853) < CONFIG.CRIT_AT);
            check('24/7 OLA across the close does not notify', crossedThreshold(computePct(continuous, at1853)) === null);
            // Same row, the countdown: 39 minutes, and now agreeing with the 35%
            // beside it rather than contradicting it.
            check('24/7 countdown is wall-clock', Math.abs(msRemaining(continuous, at1853) - 39 * 60 * 1000) < 1000);

            // A pausing OLA's countdown is business time, not the raw gap: Friday
            // 19:00 with a Monday 10:00 deadline has 2 working hours left, not the
            // 63 wall-clock hours the old subtraction reported.
            check('pausing countdown is business time', Math.abs(msRemaining(spansWeekend, pMs(2026, 8, 7, 19, 0)) - 2 * HOUR) < 1000);
            check('breached countdown goes negative', msRemaining(sameDay, pMs(2026, 8, 4, 11, 30)) < 0);

            // ── clockPauses signals ─────────────────────────────────────────────
            // Span equal to the definition's duration → the clock ran straight
            // through; span longer → the engine skipped non-working time.
            check('span == duration → continuous', clockPauses(continuous) === false);
            check('span > duration → pauses', clockPauses(row(pIso(2026, 8, 4, 18, 32), pIso(2026, 8, 5, 8, 32), { slaDuration: '1970-01-01 01:00:00' })) === true);
            // Duration wins over the schedule reference — a definition can carry a
            // schedule that inserted no gap into THIS row's window.
            check('duration outranks schedule ref', clockPauses({ ...continuous, ...PAUSING }) === false);
            // Fallback when duration is unreadable: no schedule means no pauses,
            // but a schedule that comes from the task is invisible here, so an
            // empty sla.schedule proves nothing and the schedule-aware reading stands.
            const noDuration = (extra) => clockPauses(row(pIso(2026, 8, 4, 18, 32), pIso(2026, 8, 4, 19, 32), extra));
            check('no duration, no schedule → continuous', noDuration({}) === false);
            check('no duration, definition schedule → pauses', noDuration(PAUSING) === true);
            check('no duration, task-sourced schedule → pauses', noDuration({ scheduleSource: 'task' }) === true);
            check('unparseable timestamps → unknown', clockPauses({ start: '', plannedEnd: '' }) === null);

            // glide_duration is an offset from the epoch, in either the datetime
            // form the Table API returns or the bare clock form some instances do.
            check('duration 1h', parseSnowDuration('1970-01-01 01:00:00') === HOUR);
            check('duration 27h', parseSnowDuration('1970-01-02 03:00:00') === 27 * HOUR);
            check('duration bare clock', parseSnowDuration('01:00:00') === HOUR);
            check('duration days form', parseSnowDuration('1 day 02:00:00') === 26 * HOUR);
            check('duration empty', parseSnowDuration('') === null);
            check('duration zero', parseSnowDuration('1970-01-01 00:00:00') === null);
            check('duration junk', parseSnowDuration('not a duration') === null);

            // ── Ribbon placement ────────────────────────────────────────────────
            // firstFreeX is the whole no-overlap rule: the ribbon goes after the
            // right edge of the furthest-right tab, in the tabs' own coordinate
            // space, never at a hard-coded offset. Rects here are the real ones
            // from the Polaris nav (All/Favorites/History/⋮ at left 332/320/378/458
            // in a container starting at x=100), so a regression in the arithmetic
            // shows up as a number, not as a screenshot nobody looks at.
            const rect = (left, width) => ({ left, right: left + width, width, top: 0, bottom: 32, height: 32 });
            const navTabs = [rect(432, 30), rect(420, 62), rect(478, 48), rect(558, 24)];
            check('ribbon clears the last tab', firstFreeX(100, navTabs, 10) === 492);
            // A zero-width tab is the ⋮ overflow sitting as `is-placeholder`; it
            // reserves nothing, so it must not push the ribbon out past a gap of air.
            check('zero-width tabs reserve nothing', firstFreeX(100, [rect(432, 30), rect(600, 0)], 10) === 372);
            check('no tabs at all → just the gap', firstFreeX(100, [], 10) === 10);
            check('ribbon never lands left of the origin', firstFreeX(100, [rect(0, 0)], 10) === 10);
            // Order doesn't matter — it's the furthest right edge that counts, and
            // the nav's inline `left` values are not in visual order (Favorites is
            // pinned at 320 while All sits at 332).
            check('placement is order-independent', firstFreeX(100, [...navTabs].reverse(), 10) === firstFreeX(100, navTabs, 10));

            // Sharing an edge is touching, not overlapping — sub-pixel layout does
            // this constantly and a false positive here would reject a good dock.
            check('adjacent rects do not overlap', rectsOverlap(rect(0, 100), rect(100, 50)) === false);
            check('overlapping rects are caught', rectsOverlap(rect(0, 100), rect(50, 50)) === true);
            check('a rect inside another overlaps', rectsOverlap(rect(0, 100), rect(20, 10)) === true);
            check('vertically clear rects do not overlap',
                rectsOverlap({ left: 0, right: 100, top: 0, bottom: 10 }, { left: 0, right: 100, top: 20, bottom: 30 }) === false);

            // Threshold selection returns the MOST severe NOTIFY_AT point crossed,
            // not the first. NOTIFY_AT is [75] by default.
            check('threshold 74 → none', crossedThreshold(74) === null);
            check('threshold 75 → 75', crossedThreshold(75) === 75);
            check('threshold 99 → 75', crossedThreshold(99) === 75);
            check('threshold null → null', crossedThreshold(null) === null);

            // Countdown floors at BREACHED rather than ticking negative
            check('negative remaining', fmtRemaining(-5000) === 'BREACHED');
            check('formats mm:ss', fmtRemaining(90 * 1000) === '01:30');
            check('formats h:mm:ss', fmtRemaining(5400 * 1000) === '1:30:00');
            check('formats Nd HHh', fmtRemaining(90000 * 1000) === '1d 01h');

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
            console.log(`[OLA Watch] selfTest passed (${ran} checks)`);
            return { ok: true };
        }
    };
    pageWindow.__olaWatchDebug = debugApi;
    window.__olaWatchDebug = debugApi;

    console.log(`[OLA Watch] v${SCRIPT_VERSION} loaded on ${location.hostname} — group ${CONFIG.ASSIGNMENT_GROUP}, OLA ${CONFIG.OLA_NAME}, show@${CONFIG.SHOW_AT}% crit@${CONFIG.CRIT_AT}% notify@${CONFIG.NOTIFY_AT.join('/')}%`);
})();
