// Aggregator so the literal command `node --test tests/` works.
//
// Node's test runner treats positional arguments as glob patterns; a bare
// directory matches itself and is loaded as a module, which resolves to this
// index.js. Importing every *.test.js here registers all suites in one
// process. `node --test` (no args) and `node --test 'tests/*.test.js'` still
// run the individual files directly.
import './zoom-ladder.test.js';
import './geometry.test.js';
import './screen-keys.test.js';
import './url-rules.test.js';
import './storage.test.js';
import './sync-scheduler.test.js';
import './badge.test.js';
import './message-router.test.js';
import './zoom-engine.test.js';
import './service-worker.test.js';
