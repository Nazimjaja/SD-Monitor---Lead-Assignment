// ==UserScript==
// @name         SD Monitor - OLA Breach Warning
// @namespace    geodis-sd-monitor
// @version      0.1
// @description  Warns every SD agent when a group ticket's resolution OLA crosses 50% and 75%, and lets whoever is free take it over on the spot
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
        OLA_NAME: 'INC_OLA_RES_SD',

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
        // and survives.
        PANEL_WIDTH: 248
    };

    const TAB_ID = Date.now() + '-' + Math.random().toString(36).slice(2);

    // ─── SNOW HELPERS ────────────────────────────────────────────────────────
    function getCsrfToken() { return pageWindow.g_ck || ''; }
    function getMyId()      { return pageWindow.NOW?.user?.userID || pageWindow.g_user_id || ''; }
    function getMyName()    { return pageWindow.NOW?.user?.fullName || pageWindow.g_user_name || 'You'; }

    async function jFetch(table, query, limit = 20) {
        const r = await fetch(`/${table}_list.do?JSONv2&sysparm_action=getRecords&sysparm_query=${query}&sysparm_limit=${limit}`);
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

        const r = await fetch(url, { headers: { Accept: 'application/json' } });
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
    // ponytail: wall-clock, not schedule-aware. planned_end_time already accounts
    // for the OLA's schedule, but elapsed time here doesn't — so a ticket that
    // spans a non-working boundary (opened 17:50 against a schedule closing at
    // 18:00) will read high. Harmless for a 24/7 or long-window schedule, which is
    // the normal service-desk case. If it bites, fall back to serverPct and accept
    // the lag, or pull business_time_left.
    function computePct(row) {
        const s = parseSnowUtc(row.start);
        const e = parseSnowUtc(row.plannedEnd);
        if (s == null || e == null || e <= s) return row.serverPct || null;
        const pct = ((Date.now() - s) / (e - s)) * 100;
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
        const r = await fetch(
            `/api/now/table/${table}/${encodeURIComponent(sysId)}?sysparm_fields=assigned_to&sysparm_display_value=all`,
            { headers: { Accept: 'application/json' } }
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
        const r = await fetch(`/api/now/table/${table}/${encodeURIComponent(sysId)}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserToken': getCsrfToken()
            },
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
        refreshBtn.title = 'Refresh now';
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

    function setStatus(text, isError = false) {
        const s = document.getElementById('olaStatus');
        if (!s) return;
        s.textContent = text;
        s.classList.toggle('olaErr', isError);
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

        panel.classList.toggle('olaVisible', rows.length > 0 || !!state.error);

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
    setInterval(tickClocks, 1000);
    setInterval(() => { if (takesInFlight === 0) renderPanel(); }, 15000); // catch TTL/stale drift
    setInterval(pollCycle, CONFIG.POLL_TICK_MS);
    pollCycle();

    document.addEventListener('visibilitychange', () => { if (isVisible()) pollCycle(); });

    // ─── DEBUG / SELF-CHECK (console) ────────────────────────────────────────
    window.__olaWatchDebug = {
        forcePoll,
        state: () => getSharedState(),
        ledger: () => getLedger(),
        clearLedger() { GM_deleteValue(LEDGER_KEY); console.log('[OLA Watch] ledger cleared'); },
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
            const r = await fetch(url, { headers: { Accept: 'application/json' } });
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
            const mk = (startMsAgo, totalMin) => ({
                start: iso(Date.now() - startMsAgo),
                plannedEnd: iso(Date.now() - startMsAgo + totalMin * 60000),
                serverPct: 0
            });

            // 60-min OLA, 30 min elapsed → 50%
            const half = computePct(mk(30 * 60000, 60));
            check('50% midpoint', Math.abs(half - 50) < 1.5);

            // 45 min elapsed → 75%
            const threeQ = computePct(mk(45 * 60000, 60));
            check('75% point', Math.abs(threeQ - 75) < 1.5);

            // Past the deadline clamps to 100, never above
            check('clamped at 100', computePct(mk(90 * 60000, 60)) === 100);
            // Before the start clamps to 0, never negative
            check('clamped at 0', computePct(mk(-10 * 60000, 60)) === 0);

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
            console.log('[OLA Watch] selfTest passed (13 checks)');
            return { ok: true };
        }
    };

    console.log(`[OLA Watch] loaded — group ${CONFIG.ASSIGNMENT_GROUP}, OLA ${CONFIG.OLA_NAME}, thresholds ${CONFIG.THRESHOLDS.join('/')}%`);
})();
