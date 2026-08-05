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

## Adding a case

`harness.js` has the shared pieces: `startSnowPage()` boots a page with the script
loaded, `GM_*` stubbed and routing installed; the handler you pass returns a body per
URL (`json()` / `html()` helpers) or `null` to fall through. `createResults()` is the
assertion collector — `check(name, condition, detail)`.

Keep new cases behavioural. These are worth having because they encode failures that
actually happened in production; a test that only restates the implementation would
not have caught any of them.
