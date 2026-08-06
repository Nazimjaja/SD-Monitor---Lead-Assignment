# Tests

Browser tests for `OLA ACK.user.js`. They run the real userscript in a real
Chromium page — there is no way to unit-test it otherwise: it is an IIFE that
expects a browser, Tampermonkey's `GM_*` API, and a ServiceNow hostname.

Every network call is intercepted, so nothing here touches a real instance.

## Running

```sh
cd tests
npm install          # Playwright; skipped if you already have a global install
npm test             # every suite
node run.js popup    # one suite by name
```

Exits non-zero if any check fails, so it works as a pre-push hook or a CI step.

## What each suite covers

| suite | what it protects |
|---|---|
| `session.test.js` | The credential-dialog bug. Asserts a real `X-UserToken` goes out, never an empty one, that a 401 stops the poll instead of re-provoking the browser's login box every 15s, that Reconnect recovers, and that an SSO login page served as HTTP 200 is recognised as a dead session rather than parsed as JSON. |
| `acknowledge.test.js` | The acknowledge path, against six stand-in incident forms: one that submits and navigates, one that saves over AJAX without navigating, one whose button renders late, one that opens a confirmation dialog, one that refuses with a mandatory-field error. Also asserts an Impact that is already set is never overwritten — doing so re-derives Priority from Impact × Urgency and silently moves the incident's SLA — and that both ways the form says nobody has set one (the empty option and `-1` / "Not Set") are filled. |
| `popup.test.js` | What the agent sees: every state in both colour schemes, the countdown format, the progress bar draining with the clock, the overdue and acknowledged states, and the version badge. Writes screenshots to `.screenshots/` (git-ignored) for eyeballing a visual change. |
| `watch.test.js` | OLA Watch tracking two OLA definitions with different lifetimes (INC-RES 1 hour, CTSK-RES 4). Asserts both go out in one `IN` clause rather than two `sla.name=` terms ANDed together — which would match nothing — and that nothing downstream assumes a duration: at the same 75% the two rows show a quarter of an hour and a full hour left, and a 4-hour OLA 45 minutes in stays off screen instead of reading as 75% against a 1-hour window. |
| `dock.test.js` | OLA Watch's ribbon docking into the Polaris nav, against the real header markup (absolutely-positioned `.sn-polaris-tab` children, the pinned Favorites tab sitting at a *smaller* `left` than All, the `#nav-overflow` placeholder). Assertions are measured rectangles, not screenshots: the ribbon overlaps no tab and no header neighbour, sits after the last tab on its baseline, re-places itself when ServiceNow moves a tab, and drops back to the fixed corner when the nav is missing, unusable, or has no room left. Includes the case the real instance actually presents: the nav nested several open shadow roots deep, where a document stylesheet does not reach the ribbon and `offsetParent` returns null. Two earlier attempts at this docking were abandoned for lack of exactly this. |

## Adding a case

`harness.js` has the shared pieces: `startSnowPage()` boots a page with the script
loaded, `GM_*` stubbed and routing installed; the handler you pass returns a body per
URL (`json()` / `html()` helpers) or `null` to fall through. It loads the ACK script by
default — pass `script: 'watch'` for OLA Watch, and `body` to inject page markup the
script is meant to find. Note the two scripts resolve the assignment group over
different APIs: JSONv2 (`/sys_user_group_list.do`, `records`) and the Table API
(`/api/now/table/...`, `result`). `createResults()` is the
assertion collector — `check(name, condition, detail)`.

Keep new cases behavioural. These are worth having because they encode failures that
actually happened in production; a test that only restates the implementation would
not have caught any of them.
