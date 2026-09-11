const fs = require("fs");
const os = require("os");
const path = require("path");

const DAY = 86400;

/**
 * Pick a scratch directory for a test database.
 * @param {string} name Directory name to create under the scratch root
 * @returns {string} Absolute or relative path to use as the data dir
 */
function scratchDir(name) {
    for (const base of [ process.env.KUMA_TEST_TMPDIR, "/dev/shm", os.tmpdir() ]) {
        if (!base) {
            continue;
        }
        try {
            fs.accessSync(base, fs.constants.W_OK);
            const st = fs.statfsSync ? fs.statfsSync(base) : null;
            // Skip a candidate that can't hold a small database.
            if (st && st.bsize * st.bavail < 64 * 1024 * 1024) {
                continue;
            }
            return path.join(base, name);
        } catch (e) {
            // not usable, try the next candidate
        }
    }
    return path.join("./data", name);
}

/**
 * Build a report in the shape parseAggregateReport() returns.
 * @param {object} opts Overrides: domain, org, id, p, endsDaysAgo, records
 * @returns {object} Report object
 */
function makeReport(opts) {
    const now = Math.floor(Date.now() / 1000);
    const end = now - (opts.endsDaysAgo ?? 1) * DAY;
    return {
        orgName: opts.org ?? "google.com",
        orgEmail: "noreply@google.com",
        reportId: opts.id ?? "r1",
        dateBegin: end - DAY,
        dateEnd: end,
        domain: opts.domain ?? "example.com",
        policy: {
            p: opts.p ?? "reject",
            sp: "reject",
            pct: 100,
            adkim: "r",
            aspf: "r",
        },
        records: (opts.records ?? []).map((r) => ({
            sourceIp: r[0],
            count: r[1],
            disposition: r[2] ?? "none",
            dkimAligned: !!r[3],
            spfAligned: !!r[4],
            headerFrom: opts.domain ?? "example.com",
            envelopeFrom: "",
            dkimResults: [],
            spfResults: [],
        })),
    };
}

module.exports = { scratchDir,
    makeReport,
    DAY };
