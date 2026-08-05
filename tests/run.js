'use strict';
// Runs every suite and exits non-zero if anything failed, so this is usable as a
// pre-push check or a CI step. Run one suite on its own with, e.g.:
//   node tests/acknowledge.test.js

const SUITES = ['session', 'acknowledge', 'popup', 'dock'];

(async () => {
    const only = process.argv[2];
    const names = only ? SUITES.filter(s => s.includes(only)) : SUITES;
    if (!names.length) {
        console.error(`No suite matches "${only}". Available: ${SUITES.join(', ')}`);
        process.exit(2);
    }

    let failures = 0;
    for (const name of names) {
        console.log(`\n── ${name} ──────────────────────────────────`);
        try {
            failures += await require(`./${name}.test.js`).run();
        } catch (e) {
            console.error(`  ERROR  ${name} suite crashed: ${e.message}`);
            failures += 1;
        }
    }

    console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
    process.exit(failures ? 1 : 0);
})();
