import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Run the backend suite, minus the files that need a Docker service container.
 *
 * Those are recognised by their own import of testcontainers rather than by a
 * list kept here, so one written tomorrow is left out without anybody
 * remembering to add it. Everything else runs, upstream's tests included.
 */

const ROOT = "test/backend-test";

/**
 * Files that assert against live third-party data rather than against this
 * code: test-domain.js fetches a real domain's real expiry date over RDAP and
 * compares it to a date written into the test. It passes alone and fails under
 * the load of the full run, and nothing here can make it deterministic, so it
 * is named rather than detected. `npm run test-backend` still runs it.
 */
const NEEDS_THE_INTERNET = [ "test-domain.js" ];

/**
 * Every test file under a directory, recursively.
 * @param {string} dir Directory to walk
 * @returns {string[]} Paths of test files
 */
function collect(dir) {
    const found = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
            found.push(...collect(full));
            continue;
        }
        // Helpers and mocks sit beside the tests and define none of their own.
        if (!/^test-.*\.js$/.test(entry) && !/\.test\.js$/.test(entry)) {
            continue;
        }
        found.push(full);
    }
    return found;
}

const all = collect(ROOT).sort();
const files = all.filter(
    (file) =>
        !readFileSync(file, "utf8").includes("testcontainers") &&
        !NEEDS_THE_INTERNET.includes(path.basename(file))
);
const skipped = all.length - files.length;

console.log(`Running ${files.length} test files (${skipped} skipped: they need Docker or the live internet)`);

const child = spawn("node", [ "--test", ...process.argv.slice(2), ...files ], { stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
