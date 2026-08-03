// ==UserScript==
// @name         SD Monitor - Lead Assignment Dashboard
// @namespace    geodis-sd-monitor
// @version      0.4
// @description  Assign unassigned CORP-SD tickets to agents and track how many you've assigned this shift
// @changelog    0.4 - The away list is now date-stamped like the shift counters, so it clears at
//                     local midnight instead of carrying yesterday's marks into a new day. The
//                     undo bar auto-hides UNDO_WINDOW_MS after an assignment and drops the slot
//                     with it, so a stale button can't yank back a ticket already being worked;
//                     a second assignment replaces the entry and restarts that clock rather than
//                     inheriting the first one's. The status line is derived from the rendered
//                     queue instead of the poll's own tally, so the count falls the moment a row
//                     leaves rather than lagging until the next refresh.
// @changelog    0.3 - Four workflow additions. The queue is sorted oldest-first and each ticket
//                     shows how long it has sat unassigned, red past AGE_WARN_MINUTES — so a
//                     truncated page drops the newest tickets, not the ones nearest a breach.
//                     The roster gains each agent's current open workload (one aggregate query
//                     per table, exact rather than a capped list count), with the lightest
//                     available agent highlighted. Clicking an agent marks them away, removing
//                     their assign buttons — for leave, training or lunch. And the last
//                     assignment can be undone from the panel, which is the only cheap recovery
//                     from a misclick now that assigned rows disappear immediately.
// @changelog    0.2 - Correctness/safety pass, mostly porting fixes the ACK monitor already made.
//                     Ticket and user text is now written with textContent instead of innerHTML
//                     templates, so a ticket's short_description can never be parsed as HTML on
//                     the SNOW origin. CSS goes through GM_addStyle so a host CSP with style-src
//                     but no 'unsafe-inline' can't drop it. Assignments are now verified against
//                     the response body — the Table API answers 200 and silently discards a field
//                     you can't write, which previously looked like success while the ticket never
//                     reached the agent. A poll landing mid-assign no longer tears down the row
//                     being clicked. Shift counts roll over at local midnight, not UTC. The queue
//                     says so when there are more unassigned tickets than one page.
// @match        *://*.service-now.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_addStyle
// @grant        unsafeWindow
// @noframes
// ==/UserScript==

(function () {
    'use strict';

    // This tool has no "mirror" mode like the ACK monitor (it's an interactive
    // lead-only dashboard), so @match is scoped to service-now.com directly
    // instead of matching everywhere and filtering by hostname.
    const pageWindow = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // ─── CONFIG ─────────────────────────────────────────────────────────────
    const CONFIG = {
        ASSIGNMENT_GROUP: 'CORP-SD',
        TABLES: ['sc_task', 'incident'],
        EXTRA_FILTER: { incident: 'stateNOT IN7' }, // exclude Closed incidents — same reasoning as the ACK monitor
        AGENTS: [
            'Ibtissam EL FEKAK',
            'Fanel MALANDA',
            'Marc Romaire EDOUARD',
            'Nazim FODIL',
            'Yves LOR',
            'Jalel AOUICHI'
        ],
        POLL_MS: 20000,
        // Tickets shown per table. We actually request one more than this so a full
        // page is distinguishable from a truncated one, and say so in the status line
        // rather than silently hiding the tail of the backlog.
        PAGE_LIMIT: 50,
        // sys_created_on has no timezone marker, so we have to be told how to read it.
        // SNOW stores sys_* timestamps in UTC and JSONv2 normally hands them back that
        // way — but an instance can be configured to return user-local instead. If every
        // age is off by exactly your UTC offset (2h in Paris summer), flip this to false.
        CREATED_ON_IS_UTC: true,
        AGE_WARN_MINUTES: 60, // tickets older than this get a red age badge
        UNDO_WINDOW_MS: 10000, // how long the undo bar stays up after an assignment
        PANEL_TOP: 70,
        PANEL_RIGHT: 18,
        PANEL_WIDTH: 340
    };

    // ─── SNOW HELPERS (same approach as the ACK monitor script) ─────────────
    function getCsrfToken() { return pageWindow.g_ck || ''; }

    async function jFetch(table, query, limit = 20) {
        const r = await fetch(`/${table}_list.do?JSONv2&sysparm_action=getRecords&sysparm_query=${query}&sysparm_limit=${limit}`);
        if (!r.ok) throw new Error(`${table}: HTTP ${r.status}`);
        return (await r.json()).records || [];
    }

    async function assignRecord(table, sysId, userId) {
        const r = await fetch(`/api/now/table/${table}/${sysId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserToken': getCsrfToken()
            },
            body: JSON.stringify({ assigned_to: userId })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 120)}`);
        const body = await r.json();

        // The Table API answers 200 and silently drops a field you lack write access
        // to, so a successful-looking response doesn't mean the ticket moved. Without
        // this check the count would tick up and the row would vanish while the agent
        // never actually received anything.
        const written = body?.result?.assigned_to;
        const writtenId = written && typeof written === 'object' ? written.value : written;
        if (!writtenId) {
            throw new Error('Server accepted the update but assigned_to came back empty — check your write access on this table.');
        }
        if (writtenId !== userId) {
            throw new Error(`Server stored a different user (${writtenId}) than requested.`);
        }
        return body;
    }

    // Undo path: put the ticket back in the unassigned queue. Same silent-drop risk as
    // assignRecord, so verify the field actually came back empty.
    async function clearAssignment(table, sysId) {
        const r = await fetch(`/api/now/table/${table}/${sysId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-UserToken': getCsrfToken()
            },
            body: JSON.stringify({ assigned_to: '' })
        });
        if (!r.ok) throw new Error(`HTTP ${r.status} — ${(await r.text()).slice(0, 120)}`);
        const written = (await r.json())?.result?.assigned_to;
        const writtenId = written && typeof written === 'object' ? written.value : written;
        if (writtenId) throw new Error('Server kept the ticket assigned — undo did not take.');
    }

    // Per-agent open workload. The aggregate API groups and counts server-side, so this
    // stays one request per table and can't be wrong the way a capped list query would be.
    // Returns counts keyed by user sys_id.
    async function fetchOpenLoad(groupSysId) {
        const counts = {};
        for (const table of CONFIG.TABLES) {
            let query = `assignment_group=${groupSysId}^active=true^assigned_toISNOTEMPTY`;
            if (CONFIG.EXTRA_FILTER[table]) query += `^${CONFIG.EXTRA_FILTER[table]}`;
            const r = await fetch(
                `/api/now/stats/${table}?sysparm_query=${query}&sysparm_count=true&sysparm_group_by=assigned_to`,
                { headers: { Accept: 'application/json' } }
            );
            if (!r.ok) throw new Error(`load ${table}: HTTP ${r.status}`);
            const rows = (await r.json())?.result || [];
            rows.forEach(row => {
                const field = (row.groupby_fields || []).find(f => f.field === 'assigned_to');
                if (!field || !field.value) return;
                counts[field.value] = (counts[field.value] || 0) + Number(row?.stats?.count || 0);
            });
        }
        return counts;
    }

    // ─── TICKET AGE ──────────────────────────────────────────────────────────
    function parseSnowDate(value) {
        if (!value) return null;
        const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(String(value).trim());
        if (!m) {
            const t = Date.parse(value);
            return Number.isNaN(t) ? null : t;
        }
        const [Y, Mo, D, H, Mi, S] = m.slice(1).map(Number);
        return CONFIG.CREATED_ON_IS_UTC
            ? Date.UTC(Y, Mo - 1, D, H, Mi, S)
            : new Date(Y, Mo - 1, D, H, Mi, S).getTime();
    }

    function ageMinutes(record) {
        const t = parseSnowDate(record.sys_created_on);
        return t == null ? null : Math.max(0, Math.round((Date.now() - t) / 60000));
    }

    function ageLabel(mins) {
        if (mins == null) return null;
        if (mins < 60) return `${mins}m`;
        const h = Math.floor(mins / 60);
        if (h < 24) return `${h}h${String(mins % 60).padStart(2, '0')}`;
        return `${Math.floor(h / 24)}d${h % 24}h`;
    }

    // ─── AGENT NAME PARSING ──────────────────────────────────────────────────
    // Your roster follows "Given [Middle] SURNAME" with the surname in caps
    // (e.g. "Marc Romaire EDOUARD" → given "Marc Romaire", surname "EDOUARD").
    // This is only used to seed the candidate search below — you confirm the
    // actual match by clicking it, so a wrong guess here just widens the list.
    function parseAgentName(fullName) {
        const tokens = fullName.trim().split(/\s+/);
        const isAllCaps = t => t.length > 1 && t === t.toUpperCase();
        let surnameTokens = tokens.filter(isAllCaps);
        let givenTokens = tokens.filter(t => !isAllCaps(t));
        if (surnameTokens.length === 0) {
            surnameTokens = [tokens[tokens.length - 1]];
            givenTokens = tokens.slice(0, -1);
        }
        return {
            full: fullName,
            given: givenTokens.join(' '),
            firstToken: givenTokens[0] || tokens[0],
            surname: surnameTokens.join(' ')
        };
    }

    // ─── AGENT ↔ sys_id RESOLUTION (persisted once you confirm a match) ─────
    const AGENT_MAP_KEY = 'sdAssignTool_agentMap'; // { [fullName]: { sys_id, user_name, display } }
    function getAgentMap() {
        try { return JSON.parse(GM_getValue(AGENT_MAP_KEY, '{}')); } catch { return {}; }
    }
    function setAgentMap(map) { GM_setValue(AGENT_MAP_KEY, JSON.stringify(map)); }

    async function searchUserCandidates(term) {
        const encoded = encodeURIComponent(term);
        const [byLast, byFirst] = await Promise.all([
            jFetch('sys_user', `active=true^last_nameLIKE${encoded}`, 15),
            jFetch('sys_user', `active=true^first_nameLIKE${encoded}`, 15)
        ]);
        const seen = new Map();
        [...byLast, ...byFirst].forEach(r => {
            if (!seen.has(r.sys_id)) {
                seen.set(r.sys_id, {
                    sys_id: r.sys_id,
                    user_name: r.user_name,
                    display: `${r.first_name || ''} ${r.last_name || ''}`.trim() || r.user_name
                });
            }
        });
        return Array.from(seen.values());
    }

    // ─── SHIFT COUNTERS ──────────────────────────────────────────────────────
    // Local to this lead: "how many I've personally assigned today", not a
    // live count from ServiceNow. Rolls over automatically at midnight; the
    // Reset button in the panel covers a shift boundary that isn't midnight.
    const SHIFT_KEY = 'sdAssignTool_shift';
    // Local date, not toISOString() — that's UTC, so counts would have rolled over
    // at 01:00/02:00 local instead of at midnight.
    function todayStr() {
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    function getShiftState() {
        try {
            const s = JSON.parse(GM_getValue(SHIFT_KEY, '{}'));
            if (s.date === todayStr()) return s;
        } catch {}
        return { date: todayStr(), counts: {} };
    }
    function setShiftState(state) { GM_setValue(SHIFT_KEY, JSON.stringify(state)); }
    function incrementShiftCount(agentName, delta = 1) {
        const state = getShiftState();
        state.counts[agentName] = Math.max(0, (state.counts[agentName] || 0) + delta);
        setShiftState(state);
        return state;
    }

    // ─── AWAY LIST ───────────────────────────────────────────────────────────
    // Agents on leave/training/lunch. Same date-stamped shape as the shift counters, so
    // it clears itself at local midnight — you start each day with a full roster and
    // re-flag whoever is actually out, rather than inheriting yesterday's marks.
    const AWAY_KEY = 'sdAssignTool_away'; // { date, names: [] }
    function getAwaySet() {
        try {
            const s = JSON.parse(GM_getValue(AWAY_KEY, '{}'));
            if (s && s.date === todayStr()) return new Set(s.names || []);
        } catch {}
        return new Set();
    }
    function toggleAway(agentName) {
        const away = getAwaySet();
        if (away.has(agentName)) away.delete(agentName); else away.add(agentName);
        GM_setValue(AWAY_KEY, JSON.stringify({ date: todayStr(), names: [...away] }));
    }
    function resetShiftCounts() { setShiftState({ date: todayStr(), counts: {} }); }

    // ─── PANEL POSITION + LOCK (persisted so it stays put across reloads) ───
    const PANEL_POS_KEY = 'sdAssignTool_panelPos';   // { left, top }
    const PANEL_LOCK_KEY = 'sdAssignTool_panelLocked'; // boolean
    const PANEL_COLLAPSED_KEY = 'sdAssignTool_panelCollapsed'; // boolean
    function getSavedPosition() {
        try { return JSON.parse(GM_getValue(PANEL_POS_KEY, 'null')); } catch { return null; }
    }
    function savePosition(pos) { GM_setValue(PANEL_POS_KEY, JSON.stringify(pos)); }
    function isPanelLocked() { return GM_getValue(PANEL_LOCK_KEY, false) === true; }
    function setPanelLocked(v) { GM_setValue(PANEL_LOCK_KEY, v); }
    function isPanelCollapsed() { return GM_getValue(PANEL_COLLAPSED_KEY, false) === true; }
    function setPanelCollapsed(v) { GM_setValue(PANEL_COLLAPSED_KEY, v); }

    // ─── ASSIGNMENT GROUP sys_id (cached after first lookup) ────────────────
    let groupSysId = null;
    async function resolveGroupSysId() {
        if (groupSysId) return groupSysId;
        const records = await jFetch('sys_user_group', `name=${encodeURIComponent(CONFIG.ASSIGNMENT_GROUP)}`, 1);
        if (!records.length) throw new Error(`Group "${CONFIG.ASSIGNMENT_GROUP}" not found — check CONFIG.ASSIGNMENT_GROUP.`);
        groupSysId = records[0].sys_id;
        return groupSysId;
    }

    // ─── DOM HELPERS ─────────────────────────────────────────────────────────
    // Everything carrying record-derived text (ticket numbers, descriptions, user
    // names) is built through these instead of an innerHTML template. A requester
    // controls short_description, and this panel runs on the SNOW origin with a live
    // session, so that text must never reach an HTML parser.
    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    }

    function iconBtn(className, title, label) {
        const b = el('button', className, label);
        b.title = title;
        return b;
    }

    // ─── STYLES ──────────────────────────────────────────────────────────────
    // Injected via GM_addStyle rather than a manual <style> element: SNOW ships a
    // Content-Security-Policy whose style-src has no 'unsafe-inline', which drops an
    // inline stylesheet and leaves the panel unstyled.
    GM_addStyle(`
        #sdaPanel, #sdaPanel * { box-sizing: border-box !important; }
        .sdaPanel {
            position: fixed !important;
            width: ${CONFIG.PANEL_WIDTH}px !important;
            max-height: 82vh !important;
            display: flex !important;
            flex-direction: column !important;
            background: rgba(255, 255, 255, 0.72) !important;
            backdrop-filter: blur(20px) saturate(180%) !important;
            -webkit-backdrop-filter: blur(20px) saturate(180%) !important;
            border: 1px solid rgba(255, 255, 255, 0.45) !important;
            border-radius: 14px !important;
            box-shadow: 0 8px 32px rgba(0,0,0,0.18), 0 1px 2px rgba(0,0,0,0.06) !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            color: #1a1a2e !important;
            z-index: 999997 !important;
            overflow: hidden !important;
        }
        .sdaHeader { display: flex !important; justify-content: space-between !important; align-items: center !important; padding: 12px 14px !important; border-bottom: 1px solid rgba(0,0,0,0.06) !important; cursor: grab !important; margin: 0 !important; transition: background 0.2s ease, border-color 0.2s ease; }
        .sdaHeader:active { cursor: grabbing !important; }
        .sdaHeader.sdaLocked { cursor: default !important; }
        .sdaHeader.sdaHasPending { background: rgba(229,72,77,0.12) !important; border-bottom-color: rgba(229,72,77,0.35) !important; }
        .sdaPanel.sdaHasPending { border-color: rgba(229,72,77,0.5) !important; box-shadow: 0 8px 32px rgba(229,72,77,0.28), 0 1px 2px rgba(0,0,0,0.06) !important; }
        .sdaHeaderLeft { display: flex !important; align-items: center !important; min-width: 0 !important; overflow: hidden !important; flex: 1 1 auto !important; margin-right: 8px !important; }
        .sdaHeaderBadge { background: #e5484d !important; color: #fff !important; font-size: 10px !important; font-weight: 700 !important; border-radius: 10px !important; padding: 1px 7px !important; margin-left: 7px !important; flex: 0 0 auto !important; display: none; }
        .sdaTitle { font-size: 14px !important; font-weight: 600 !important; letter-spacing: -0.01em !important; white-space: nowrap !important; overflow: hidden !important; text-overflow: ellipsis !important; min-width: 0 !important; }
        .sdaHeaderBtns { display: flex !important; gap: 6px !important; flex: 0 0 auto !important; }
        .sdaIconBtn {
            background: rgba(0,0,0,0.05) !important;
            border: none !important;
            border-radius: 6px !important;
            width: 26px !important;
            height: 26px !important;
            min-width: 26px !important;
            padding: 0 !important;
            margin: 0 !important;
            cursor: pointer !important;
            font-size: 13px !important;
            line-height: 1 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            box-shadow: none !important;
        }
        .sdaIconBtn:hover { background: rgba(0,0,0,0.1) !important; }
        .sdaBody { padding: 10px 14px 14px !important; overflow-y: auto !important; }
        .sdaSection { margin-bottom: 14px !important; }
        .sdaSectionHead { display: flex !important; justify-content: space-between !important; align-items: center !important; font-size: 12px !important; font-weight: 600 !important; color: rgba(26,26,46,0.7) !important; margin-bottom: 6px !important; }
        .sdaLinkBtn { background: none !important; border: none !important; color: #3b82f6 !important; font-size: 11px !important; cursor: pointer !important; padding: 0 !important; }
        .sdaRosterRow { display: flex !important; justify-content: space-between !important; align-items: center !important; font-size: 12.5px !important; padding: 3px 0 !important; cursor: pointer !important; }
        .sdaRosterRow:hover { background: rgba(0,0,0,0.03) !important; }
        .sdaRosterRow.sdaUnresolved { color: #b3261e !important; }
        .sdaRosterRow.sdaAway { opacity: 0.45 !important; text-decoration: line-through !important; }
        .sdaRosterCount { font-weight: 700 !important; }
        .sdaRosterRight { display: flex !important; align-items: center !important; gap: 7px !important; flex: 0 0 auto !important; }
        .sdaRosterLoad { font-size: 11px !important; color: rgba(26,26,46,0.6) !important; background: rgba(0,0,0,0.05) !important; border-radius: 5px !important; padding: 0 5px !important; }
        .sdaRosterLoad.sdaLightest { background: rgba(46,125,50,0.16) !important; color: #1f6b28 !important; font-weight: 700 !important; }
        .sdaAge { font-size: 11px !important; color: rgba(26,26,46,0.55) !important; }
        .sdaAge.sdaAgeWarn { color: #b3261e !important; font-weight: 700 !important; }
        .sdaUndoBar { display: none; align-items: center !important; justify-content: space-between !important; gap: 8px !important; font-size: 11.5px !important; background: rgba(59,130,246,0.10) !important; border-radius: 8px !important; padding: 6px 9px !important; margin-bottom: 8px !important; }
        .sdaUndoText { overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
        .sdaUndoBtn { border: none !important; border-radius: 6px !important; background: #3b82f6 !important; color: #fff !important; font-size: 11px !important; padding: 3px 9px !important; margin: 0 !important; cursor: pointer !important; flex: 0 0 auto !important; box-shadow: none !important; }
        .sdaUndoBtn:disabled { opacity: 0.5 !important; cursor: default !important; }
        .sdaEmpty { font-size: 12px !important; color: rgba(26,26,46,0.55) !important; padding: 6px 0 !important; }
        .sdaTicketRow { border: 1px solid rgba(0,0,0,0.06) !important; border-radius: 10px !important; padding: 8px 10px !important; margin-bottom: 8px !important; background: rgba(255,255,255,0.4) !important; }
        .sdaTicketHead { display: flex !important; justify-content: space-between !important; align-items: center !important; font-size: 12.5px !important; font-weight: 600 !important; }
        .sdaTicketHeadRight { display: flex !important; align-items: center !important; gap: 5px !important; }
        .sdaPriority { background: rgba(229,72,77,0.15) !important; color: #b3261e !important; border-radius: 6px !important; padding: 1px 6px !important; font-size: 11px !important; }
        .sdaOpenBtn {
            background: rgba(59,130,246,0.12) !important;
            color: #2563eb !important;
            border: none !important;
            border-radius: 6px !important;
            width: 20px !important;
            height: 20px !important;
            min-width: 20px !important;
            padding: 0 !important;
            margin: 0 !important;
            font-size: 11px !important;
            line-height: 1 !important;
            cursor: pointer !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            box-shadow: none !important;
        }
        .sdaOpenBtn:hover { background: rgba(59,130,246,0.22) !important; }
        .sdaTicketDesc { font-size: 11.5px !important; color: rgba(26,26,46,0.7) !important; margin: 3px 0 6px !important; overflow: hidden !important; text-overflow: ellipsis !important; white-space: nowrap !important; }
        .sdaAssignRow { display: flex !important; flex-wrap: wrap !important; gap: 5px !important; }
        .sdaAssignBtn { font-size: 11px !important; padding: 4px 8px !important; margin: 0 !important; border: none !important; border-radius: 6px !important; background: rgba(46,125,50,0.12) !important; color: #1f6b28 !important; cursor: pointer !important; box-shadow: none !important; }
        .sdaAssignBtn:hover:not(:disabled) { background: rgba(46,125,50,0.22) !important; }
        .sdaAssignBtn:disabled { opacity: 0.4 !important; cursor: default !important; }
        .sdaRowError { color: #b3261e !important; font-size: 11px !important; margin-top: 5px !important; }
        .sdaStatusLine { font-size: 11px !important; color: rgba(26,26,46,0.55) !important; text-align: center !important; margin-top: 4px !important; }
        .sdaStatusLine.sdaError { color: #b3261e !important; }

        #sdaResolveOverlay { position: fixed !important; inset: 0 !important; background: rgba(0,0,0,0.35) !important; z-index: 999999 !important; display: flex !important; align-items: center !important; justify-content: center !important; }
        #sdaResolveOverlay, #sdaResolveOverlay * { box-sizing: border-box !important; }
        .sdaResolvePanel { background: #fff !important; border-radius: 14px !important; padding: 20px !important; width: 420px !important; max-height: 80vh !important; overflow-y: auto !important; box-shadow: 0 12px 40px rgba(0,0,0,0.3) !important; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important; }
        .sdaResolvePanel h3 { margin: 0 0 12px !important; font-size: 15px !important; }
        .sdaResolveRow { border-bottom: 1px solid rgba(0,0,0,0.08) !important; padding: 10px 0 !important; }
        .sdaResolveRow.sdaResolved { color: #1f6b28 !important; }
        .sdaResolveName { font-size: 13px !important; font-weight: 600 !important; margin-bottom: 6px !important; }
        .sdaResolveCandidates { display: flex !important; flex-wrap: wrap !important; gap: 6px !important; margin-bottom: 6px !important; font-size: 12px !important; }
        .sdaCandidateBtn { padding: 4px 8px !important; margin: 0 !important; border: 1px solid rgba(0,0,0,0.15) !important; border-radius: 6px !important; background: #f4f4f6 !important; cursor: pointer !important; font-size: 11.5px !important; box-shadow: none !important; }
        .sdaCandidateBtn:hover { background: #e8e8ec !important; }
        .sdaResolveManual { display: flex !important; gap: 6px !important; }
        .sdaResolveManual input { flex: 1 !important; padding: 5px 8px !important; margin: 0 !important; border: 1px solid rgba(0,0,0,0.15) !important; border-radius: 6px !important; font-size: 12px !important; }
        .sdaResolveManual button { padding: 5px 10px !important; margin: 0 !important; border: none !important; border-radius: 6px !important; background: #3b82f6 !important; color: #fff !important; font-size: 12px !important; cursor: pointer !important; box-shadow: none !important; }
        .sdaResolveDone { margin-top: 10px !important; width: 100% !important; padding: 9px !important; border: none !important; border-radius: 8px !important; background: #2e7d32 !important; color: #fff !important; font-weight: 600 !important; cursor: pointer !important; box-shadow: none !important; }
        .sdaResolveDone:disabled { background: rgba(150,150,150,0.5) !important; cursor: default !important; }
    `);

    // ─── AGENT RESOLUTION UI ─────────────────────────────────────────────────
    function buildResolutionOverlay() {
        const overlay = document.createElement('div');
        overlay.id = 'sdaResolveOverlay';
        overlay.innerHTML = `
            <div class="sdaResolvePanel">
                <h3>Match agents to ServiceNow users</h3>
                <div class="sdaResolveList" id="sdaResolveList"></div>
                <button class="sdaResolveDone" id="sdaResolveDone" disabled>Done</button>
            </div>
        `;
        document.body.appendChild(overlay);
        return overlay;
    }

    function renderResolveRow(agentName, listEl, onResolved) {
        const row = document.createElement('div');
        row.className = 'sdaResolveRow';
        const parsed = parseAgentName(agentName);

        row.appendChild(el('div', 'sdaResolveName', agentName));
        const candidatesEl = el('div', 'sdaResolveCandidates', 'Searching…');
        row.appendChild(candidatesEl);

        const manual = el('div', 'sdaResolveManual');
        const input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'Search a different name…';
        manual.appendChild(input);
        manual.appendChild(el('button', 'sdaResolveSearchBtn', 'Search'));
        row.appendChild(manual);

        listEl.appendChild(row);

        async function loadCandidates(term) {
            candidatesEl.textContent = 'Searching…';
            try {
                const candidates = await searchUserCandidates(term);
                candidatesEl.innerHTML = '';
                if (!candidates.length) {
                    candidatesEl.textContent = 'No matches — try the search box below.';
                    return;
                }
                candidates.forEach(c => {
                    const btn = document.createElement('button');
                    btn.className = 'sdaCandidateBtn';
                    btn.textContent = `${c.display} (${c.user_name})`;
                    btn.addEventListener('click', () => {
                        const currentMap = getAgentMap();
                        currentMap[agentName] = { sys_id: c.sys_id, user_name: c.user_name, display: c.display };
                        setAgentMap(currentMap);
                        row.classList.add('sdaResolved');
                        row.replaceChildren(
                            el('div', 'sdaResolveName', `✅ ${agentName} → ${c.display} (${c.user_name})`)
                        );
                        onResolved();
                    });
                    candidatesEl.appendChild(btn);
                });
            } catch (e) {
                candidatesEl.textContent = `Search error: ${e.message}`;
            }
        }

        row.querySelector('.sdaResolveSearchBtn').addEventListener('click', () => {
            const term = row.querySelector('input').value.trim();
            if (term) loadCandidates(term);
        });

        loadCandidates(parsed.surname);
    }

    function showAgentResolutionPanel(agentNames) {
        return new Promise(resolve => {
            const overlay = buildResolutionOverlay();
            const listEl = overlay.querySelector('#sdaResolveList');
            const doneBtn = overlay.querySelector('#sdaResolveDone');

            function checkDone() {
                const map = getAgentMap();
                const remaining = agentNames.filter(n => !map[n]).length;
                doneBtn.disabled = remaining > 0;
                doneBtn.textContent = remaining > 0 ? `${remaining} remaining…` : 'Done';
            }

            agentNames.forEach(name => renderResolveRow(name, listEl, checkDone));
            checkDone();

            doneBtn.addEventListener('click', () => {
                overlay.remove();
                renderRoster();
                pollUnassigned();
                resolve(getAgentMap());
            });
        });
    }

    async function ensureAgentsResolved() {
        const map = getAgentMap();
        const unresolved = CONFIG.AGENTS.filter(name => !map[name]);
        if (unresolved.length === 0) return map;
        return showAgentResolutionPanel(unresolved);
    }

    // ─── PANEL SHELL ─────────────────────────────────────────────────────────
    function buildPanelShell() {
        const panel = document.createElement('div');
        panel.className = 'sdaPanel';
        panel.id = 'sdaPanel';
        panel.innerHTML = `
            <div class="sdaHeader">
                <div class="sdaHeaderLeft">
                    <span class="sdaTitle">📋 Assignment Dashboard</span>
                    <span class="sdaHeaderBadge" id="sdaHeaderBadge" style="display:none;">0</span>
                </div>
                <div class="sdaHeaderBtns">
                    <button class="sdaIconBtn" id="sdaRefreshBtn" title="Refresh now">⟳</button>
                    <button class="sdaIconBtn" id="sdaGearBtn" title="Re-match agents">⚙</button>
                    <button class="sdaIconBtn" id="sdaLockBtn" title="Lock position">🔓︎</button>
                    <button class="sdaIconBtn" id="sdaCollapseBtn" title="Collapse">▾</button>
                </div>
            </div>
            <div class="sdaBody" id="sdaBody">
                <div class="sdaSection">
                    <div class="sdaSectionHead">
                        <span>Assigned today (<span id="sdaShiftDate"></span>)</span>
                        <button class="sdaLinkBtn" id="sdaResetBtn">Reset</button>
                    </div>
                    <div id="sdaRosterList"></div>
                </div>
                <div class="sdaSection">
                    <div class="sdaSectionHead"><span>Unassigned queue</span></div>
                    <div class="sdaUndoBar" id="sdaUndoBar">
                        <span class="sdaUndoText" id="sdaUndoText"></span>
                        <button class="sdaUndoBtn" id="sdaUndoBtn">Undo</button>
                    </div>
                    <div id="sdaQueueList"></div>
                </div>
                <div class="sdaStatusLine" id="sdaStatus">Loading…</div>
            </div>
        `;
        const saved = getSavedPosition();
        const left = saved ? saved.left : (window.innerWidth - CONFIG.PANEL_WIDTH - CONFIG.PANEL_RIGHT);
        const top = saved ? saved.top : CONFIG.PANEL_TOP;
        panel.style.left = `${Math.max(0, left)}px`;
        panel.style.top = `${Math.max(0, top)}px`;

        document.body.appendChild(panel);

        panel.querySelector('#sdaRefreshBtn').addEventListener('click', pollUnassigned);
        panel.querySelector('#sdaUndoBtn').addEventListener('click', undoLastAssign);
        panel.querySelector('#sdaGearBtn').addEventListener('click', () => showAgentResolutionPanel(CONFIG.AGENTS));
        panel.querySelector('#sdaResetBtn').addEventListener('click', () => {
            if (confirm("Reset today's assigned counts to zero?")) {
                resetShiftCounts();
                renderRoster();
            }
        });
        panel.querySelector('#sdaCollapseBtn').addEventListener('click', () => {
            const body = panel.querySelector('#sdaBody');
            const collapsed = body.style.display === 'none';
            body.style.display = collapsed ? '' : 'none';
            panel.querySelector('#sdaCollapseBtn').textContent = collapsed ? '▾' : '▸';
            setPanelCollapsed(!collapsed);
        });

        panel.querySelector('#sdaLockBtn').addEventListener('click', () => {
            setPanelLocked(!isPanelLocked());
            updateLockUI(panel);
        });
        updateLockUI(panel);
        makeDraggable(panel);

        if (isPanelCollapsed()) {
            panel.querySelector('#sdaBody').style.display = 'none';
            panel.querySelector('#sdaCollapseBtn').textContent = '▸';
        }
    }

    function updateLockUI(panel) {
        const locked = isPanelLocked();
        const btn = panel.querySelector('#sdaLockBtn');
        btn.textContent = locked ? '🔒︎' : '🔓︎';
        btn.title = locked ? 'Unlock position' : 'Lock position';
        panel.querySelector('.sdaHeader').classList.toggle('sdaLocked', locked);
    }

    // ─── DRAG-TO-MOVE (from the header only, so ticket/agent buttons stay clickable) ──
    function makeDraggable(panel) {
        const header = panel.querySelector('.sdaHeader');
        let dragging = false;
        let offsetX = 0;
        let offsetY = 0;

        header.addEventListener('mousedown', e => {
            if (isPanelLocked()) return;
            if (e.target.closest('button')) return; // clicking a header button shouldn't start a drag
            dragging = true;
            const rect = panel.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            document.body.style.userSelect = 'none';
        });

        window.addEventListener('mousemove', e => {
            if (!dragging) return;
            const maxLeft = window.innerWidth - panel.offsetWidth;
            const maxTop = window.innerHeight - 40; // keep at least the header on-screen
            const newLeft = Math.min(Math.max(0, e.clientX - offsetX), Math.max(0, maxLeft));
            const newTop = Math.min(Math.max(0, e.clientY - offsetY), Math.max(0, maxTop));
            panel.style.left = `${newLeft}px`;
            panel.style.top = `${newTop}px`;
        });

        window.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            document.body.style.userSelect = '';
            savePosition({ left: parseInt(panel.style.left, 10), top: parseInt(panel.style.top, 10) });
        });
    }

    // ─── RENDERING ───────────────────────────────────────────────────────────
    // Last poll's results, kept so the roster's away-toggle can re-render the queue
    // without waiting for the next poll. openLoad stays null until the first
    // successful aggregate call, so the roster simply omits the column if it fails.
    let lastTickets = [];
    let openLoad = null;

    function renderRoster() {
        const rosterEl = document.getElementById('sdaRosterList');
        if (!rosterEl) return;
        const state = getShiftState();
        const agentMap = getAgentMap();
        const away = getAwaySet();
        rosterEl.replaceChildren();

        // Lightest current workload among agents who are actually available — that's
        // the "give the next one to…" hint, so away agents can't win it.
        const loadOf = name => {
            const info = agentMap[name];
            return openLoad && info ? (openLoad[info.sys_id] || 0) : null;
        };
        const availableLoads = CONFIG.AGENTS
            .filter(n => !away.has(n) && agentMap[n] && loadOf(n) != null)
            .map(loadOf);
        const lightest = availableLoads.length ? Math.min(...availableLoads) : null;

        CONFIG.AGENTS.forEach(agentName => {
            const count = state.counts[agentName] || 0;
            const resolved = !!agentMap[agentName];
            const isAway = away.has(agentName);
            const load = loadOf(agentName);

            const row = el('div', 'sdaRosterRow'
                + (resolved ? '' : ' sdaUnresolved')
                + (isAway ? ' sdaAway' : ''));
            row.title = isAway ? 'Click to mark available' : 'Click to mark away';
            row.appendChild(el('span', 'sdaRosterName', `${resolved ? '' : '⚠️ '}${agentName}`));

            const right = el('div', 'sdaRosterRight');
            if (load != null) {
                const isLightest = !isAway && lightest != null && load === lightest;
                const loadEl = el('span', 'sdaRosterLoad' + (isLightest ? ' sdaLightest' : ''), `${load} open`);
                loadEl.title = 'Tickets currently open and assigned to them in this group';
                right.appendChild(loadEl);
            }
            right.appendChild(el('span', 'sdaRosterCount', count));
            row.appendChild(right);

            row.addEventListener('click', () => {
                toggleAway(agentName);
                renderRoster();
                // Same reason the poll defers: re-rendering mid-assign would destroy
                // the row being worked on. The next poll picks the change up.
                if (assignsInFlight === 0) renderQueue(lastTickets);
            });
            rosterEl.appendChild(row);
        });
        const dateEl = document.getElementById('sdaShiftDate');
        if (dateEl) dateEl.textContent = state.date;
    }

    function ticketIcon(table) { return table === 'incident' ? '🚨' : '🎫'; }

    function updateHeaderIndicator(count) {
        const panel = document.getElementById('sdaPanel');
        if (!panel) return;
        const header = panel.querySelector('.sdaHeader');
        const badge = panel.querySelector('#sdaHeaderBadge');
        if (badge) {
            badge.textContent = count;
            badge.style.display = count > 0 ? 'inline-block' : 'none';
        }
        panel.classList.toggle('sdaHasPending', count > 0);
        header.classList.toggle('sdaHasPending', count > 0);
    }

    function renderQueue(tickets) {
        updateHeaderIndicator(tickets.length);
        const container = document.getElementById('sdaQueueList');
        if (!container) return;
        container.replaceChildren();
        if (!tickets.length) {
            container.appendChild(el('div', 'sdaEmpty', 'No unassigned tickets 🎉'));
            return;
        }
        const agentMap = getAgentMap();
        const away = getAwaySet();
        tickets.forEach(t => {
            const row = el('div', 'sdaTicketRow');

            const head = el('div', 'sdaTicketHead');
            head.appendChild(el('span', 'sdaTicketNum', `${ticketIcon(t._table)} ${t.number}`));
            const headRight = el('div', 'sdaTicketHeadRight');
            const mins = ageMinutes(t);
            const label = ageLabel(mins);
            if (label) {
                const ageEl = el('span', 'sdaAge' + (mins >= CONFIG.AGE_WARN_MINUTES ? ' sdaAgeWarn' : ''), label);
                ageEl.title = `Unassigned for ${label} (created ${t.sys_created_on})`;
                headRight.appendChild(ageEl);
            }
            if (t.priority) headRight.appendChild(el('span', 'sdaPriority', `P${t.priority}`));
            const openBtn = iconBtn('sdaOpenBtn', 'Open ticket', '🔗');
            openBtn.addEventListener('click', () => {
                window.open(`${location.origin}/${t._table}.do?sys_id=${encodeURIComponent(t.sys_id)}&sysparm_stack=no`, '_blank');
            });
            headRight.appendChild(openBtn);
            head.appendChild(headRight);
            row.appendChild(head);

            row.appendChild(el('div', 'sdaTicketDesc', t.short_description || '(no description)'));

            const assignRow = el('div', 'sdaAssignRow');
            row.appendChild(assignRow);
            const errorEl = el('div', 'sdaRowError');
            errorEl.style.display = 'none';
            row.appendChild(errorEl);
            CONFIG.AGENTS.forEach(agentName => {
                if (away.has(agentName)) return; // away agents don't get a button at all
                const info = agentMap[agentName];
                const btn = document.createElement('button');
                btn.className = 'sdaAssignBtn';
                btn.textContent = parseAgentName(agentName).firstToken;
                btn.title = info ? agentName : `${agentName} — not resolved yet (click ⚙)`;
                if (!info) btn.disabled = true;
                btn.addEventListener('click', () => handleAssign(t._table, t.sys_id, t.number, agentName, info && info.sys_id, row));
                assignRow.appendChild(btn);
            });
            container.appendChild(row);
        });
    }

    // A poll landing while an assign is in flight used to wipe the queue container,
    // destroying the row mid-request — including the error message you needed to read
    // when it failed. Polls keep fetching, but defer the re-render until the panel is
    // idle again.
    let assignsInFlight = 0;

    // ─── UNDO (one slot, in memory) ──────────────────────────────────────────
    // Deliberately not persisted: after a reload the ticket may have been worked or
    // reassigned, and an undo button that silently rips it back would be worse than
    // no undo. Covers the real case — the misclick you notice immediately.
    let lastAssign = null; // { table, sysId, number, agentName }
    let undoTimer = null;

    // One slot: a new assignment replaces whatever was there and restarts the clock.
    // Passing null clears it. The bar auto-hides after UNDO_WINDOW_MS because an undo
    // is only ever for the misclick you spot immediately — a stale button sitting there
    // an hour later is an invitation to yank back a ticket someone is already working.
    function setLastAssign(entry) {
        clearTimeout(undoTimer);
        undoTimer = null;
        lastAssign = entry;
        renderUndoBar();
        if (entry) {
            undoTimer = setTimeout(() => {
                lastAssign = null;
                renderUndoBar();
            }, CONFIG.UNDO_WINDOW_MS);
        }
    }

    function renderUndoBar() {
        const bar = document.getElementById('sdaUndoBar');
        if (!bar) return;
        const textEl = document.getElementById('sdaUndoText');
        const btn = document.getElementById('sdaUndoBtn');
        if (!lastAssign) {
            bar.style.display = 'none';
            return;
        }
        bar.style.display = 'flex';
        textEl.textContent = `${lastAssign.number} → ${parseAgentName(lastAssign.agentName).firstToken}`;
        btn.disabled = false;
        btn.textContent = 'Undo';
    }

    async function undoLastAssign() {
        if (!lastAssign) return;
        const { table, sysId, number, agentName } = lastAssign;
        const btn = document.getElementById('sdaUndoBtn');
        const textEl = document.getElementById('sdaUndoText');
        // Stop the auto-hide from pulling the bar out from under an in-flight undo —
        // a failure needs to stay on screen.
        clearTimeout(undoTimer);
        undoTimer = null;
        btn.disabled = true;
        btn.textContent = '…';
        assignsInFlight++;
        try {
            await clearAssignment(table, sysId);
            incrementShiftCount(agentName, -1);
            setLastAssign(null);
            renderRoster();
        } catch (e) {
            textEl.textContent = `❌ ${number}: ${e.message}`;
            btn.disabled = false;
            btn.textContent = 'Retry';
            console.error('[Assign Dashboard] undo failed', e);
        } finally {
            assignsInFlight--;
        }
        pollUnassigned();
    }

    async function handleAssign(table, sysId, ticketNumber, agentName, agentSysId, rowEl) {
        if (!agentSysId) return;
        const errorEl = rowEl.querySelector('.sdaRowError');
        rowEl.querySelectorAll('button').forEach(b => { b.disabled = true; });
        errorEl.style.display = 'none';
        assignsInFlight++;
        try {
            await assignRecord(table, sysId, agentSysId);
            incrementShiftCount(agentName);
            setLastAssign({ table, sysId, number: ticketNumber, agentName });
            renderRoster();
            rowEl.remove();
            // Drop it from the cached poll results too, or the next away-toggle
            // re-render (which replays lastTickets) resurrects the row we just cleared.
            lastTickets = lastTickets.filter(x => x.sys_id !== sysId);
            // renderQueue owns the badge, but it's deferred while assigns are in
            // flight — keep the count honest for rows removed in the meantime.
            const remaining = document.querySelectorAll('#sdaQueueList .sdaTicketRow').length;
            updateHeaderIndicator(remaining);
            renderQueueStatus();
            if (remaining === 0) {
                const container = document.getElementById('sdaQueueList');
                if (container) container.replaceChildren(el('div', 'sdaEmpty', 'No unassigned tickets 🎉'));
            }
        } catch (e) {
            errorEl.textContent = `❌ ${ticketNumber}: ${e.message}`;
            errorEl.style.display = 'block';
            rowEl.querySelectorAll('button').forEach(b => { b.disabled = false; });
            console.error('[Assign Dashboard]', e);
        } finally {
            assignsInFlight--;
        }
    }

    // Status line is derived from what's actually on screen rather than from the poll's
    // own tally, so removing a row updates it immediately instead of showing a stale
    // count until the next refresh. The truncation flag and timestamp still come from
    // the last poll — they're properties of the fetch, not of the current DOM.
    let lastPollMeta = { truncated: false, stamp: '' };
    function renderQueueStatus() {
        const n = document.querySelectorAll('#sdaQueueList .sdaTicketRow').length;
        setPanelStatus(
            `${n}${lastPollMeta.truncated ? '+' : ''} unassigned · updated ${lastPollMeta.stamp}` +
            (lastPollMeta.truncated ? ` · showing first ${CONFIG.PAGE_LIMIT} per table` : '')
        );
    }

    function setPanelStatus(text, isError = false) {
        const statusEl = document.getElementById('sdaStatus');
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.classList.toggle('sdaError', isError);
    }

    // ─── POLL ────────────────────────────────────────────────────────────────
    async function pollUnassigned() {
        setPanelStatus('Refreshing…');
        try {
            const gid = await resolveGroupSysId();
            let tickets = [];
            let truncated = false;
            for (const table of CONFIG.TABLES) {
                let query = `assignment_group=${gid}^assigned_toISEMPTY^active=true`;
                if (CONFIG.EXTRA_FILTER[table]) query += `^${CONFIG.EXTRA_FILTER[table]}`;
                // Oldest first, so when the backlog is deeper than one page the tickets
                // we drop are the newest — the ones with the most clock left.
                query += '^ORDERBYsys_created_on';
                // One over the display cap: if we get the extra record back, there are
                // more waiting than we're showing, and the status line should say so.
                const records = await jFetch(table, query, CONFIG.PAGE_LIMIT + 1);
                if (records.length > CONFIG.PAGE_LIMIT) {
                    truncated = true;
                    records.length = CONFIG.PAGE_LIMIT;
                }
                records.forEach(r => { r._table = table; });
                tickets = tickets.concat(records);
            }

            // Each table came back sorted, but the merge interleaves them — re-sort so
            // the oldest ticket across both is genuinely on top. Unparseable dates sink.
            tickets.sort((a, b) =>
                (parseSnowDate(a.sys_created_on) ?? Infinity) - (parseSnowDate(b.sys_created_on) ?? Infinity));
            lastTickets = tickets;

            // Workload is a nice-to-have: if the aggregate endpoint is blocked, the
            // roster just drops the column rather than taking the whole poll down.
            try {
                openLoad = await fetchOpenLoad(gid);
            } catch (e) {
                openLoad = null;
                console.warn('[Assign Dashboard] open-load lookup failed', e);
            }
            renderRoster();

            const stamp = new Date().toLocaleTimeString();
            if (assignsInFlight > 0) {
                setPanelStatus(`Assigning… list refreshes when done (${stamp})`);
                return;
            }
            renderQueue(tickets);
            lastPollMeta = { truncated, stamp };
            renderQueueStatus();
        } catch (e) {
            setPanelStatus(`Error: ${e.message}`, true);
            console.error('[Assign Dashboard] poll failed', e);
        }
    }

    // ─── CROSS-TAB REFRESH (same browser profile, e.g. two SNOW tabs open) ──
    GM_addValueChangeListener(SHIFT_KEY, () => renderRoster());
    GM_addValueChangeListener(AGENT_MAP_KEY, () => renderRoster());

    // ─── INIT ────────────────────────────────────────────────────────────────
    (async function init() {
        buildPanelShell();
        renderRoster();
        setPanelStatus('Resolving agents…');
        await ensureAgentsResolved();
        renderRoster();
        await pollUnassigned();
        setInterval(pollUnassigned, CONFIG.POLL_MS);
    })();

    // ─── DEBUG HELPERS (console) ─────────────────────────────────────────────
    window.__sdAssignDebug = {
        forcePoll: pollUnassigned,
        resetShift() { resetShiftCounts(); renderRoster(); },
        reresolveAgents() { return showAgentResolutionPanel(CONFIG.AGENTS); }
    };
})();