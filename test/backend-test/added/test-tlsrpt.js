const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const TestDB = require("../../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../../server/settings");
const { scratchDir } = require("./helpers");

const { parseTlsReport, looksLikeTlsReport } = require("../../../server/tlsrpt/parser");
const { extractDocuments, looksLikeDmarc } = require("../../../server/dmarc/parser");
const store = require("../../../server/tlsrpt/store");

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

const SAMPLE = JSON.stringify({
    "organization-name": "Google Inc.",
    "date-range": {
        "start-datetime": "2026-08-30T00:00:00Z",
        "end-datetime": "2026-08-30T23:59:59Z",
    },
    "contact-info": "smtp-tls-reporting@google.com",
    "report-id": "2026-08-30T00:00:00Z_example.com",
    "policies": [
        {
            policy: {
                "policy-type": "sts",
                "policy-domain": "Example.com",
                "mx-host": [ "*.example.com" ],
            },
            summary: {
                "total-successful-session-count": 980,
                "total-failure-session-count": 20,
            },
            "failure-details": [
                {
                    "result-type": "certificate-expired",
                    "sending-mta-ip": "203.0.113.5",
                    "receiving-mx-hostname": "mx1.example.com",
                    "failed-session-count": 18,
                },
                {
                    "result-type": "starttls-not-supported",
                    "receiving-mx-hostname": "mx2.example.com",
                    "failed-session-count": 2,
                },
            ],
        },
        {
            policy: { "policy-type": "no-policy-found",
                "policy-domain": "shop.example.net" },
            summary: { "total-successful-session-count": 40,
                "total-failure-session-count": 0 },
        },
    ],
});

describe("TLS report parser", () => {
    test("parses one entry per policy", () => {
        const reports = parseTlsReport(Buffer.from(SAMPLE));
        assert.strictEqual(reports.length, 2);
        assert.deepStrictEqual(reports.map((r) => r.domain), [ "example.com", "shop.example.net" ]);
    });

    test("reads the summary, policy and timestamps", () => {
        const [ first ] = parseTlsReport(Buffer.from(SAMPLE));
        assert.strictEqual(first.orgName, "Google Inc.");
        assert.strictEqual(first.policyType, "sts");
        assert.strictEqual(first.successCount, 980);
        assert.strictEqual(first.failureCount, 20);
        assert.strictEqual(first.dateBegin, Math.floor(Date.parse("2026-08-30T00:00:00Z") / 1000));
        // Domains are lowercased so they join with DMARC data.
        assert.strictEqual(first.domain, "example.com");
    });

    test("reads the failure details, which are the actionable part", () => {
        const [ first ] = parseTlsReport(Buffer.from(SAMPLE));
        assert.strictEqual(first.failures.length, 2);
        assert.strictEqual(first.failures[0].resultType, "certificate-expired");
        assert.strictEqual(first.failures[0].receivingMxHostname, "mx1.example.com");
        assert.strictEqual(first.failures[0].failedSessionCount, 18);
        // A failure with no sending IP must not break parsing.
        assert.strictEqual(first.failures[1].sendingMtaIp, "");
    });

    test("tolerates a policy with no failure-details at all", () => {
        const [ , second ] = parseTlsReport(Buffer.from(SAMPLE));
        assert.deepStrictEqual(second.failures, []);
        assert.strictEqual(second.failureCount, 0);
    });

    test("rejects things that are not TLS reports", () => {
        assert.deepStrictEqual(parseTlsReport(Buffer.from("not json")), []);
        assert.deepStrictEqual(parseTlsReport(Buffer.from("{}")), []);
        // Valid JSON with policies but no report id is unusable for de-duplication.
        assert.deepStrictEqual(parseTlsReport(Buffer.from('{"policies":[]}')), []);
        // A DMARC report is XML, not this.
        assert.deepStrictEqual(parseTlsReport(Buffer.from("<feedback></feedback>")), []);
    });

    test("skips a policy with no domain rather than storing a blank one", () => {
        const doc = JSON.stringify({
            "report-id": "x",
            "organization-name": "y",
            policies: [{ policy: { "policy-type": "sts" },
                summary: {} }],
        });
        assert.deepStrictEqual(parseTlsReport(Buffer.from(doc)), []);
    });

    test("the two report types are told apart correctly", () => {
        const tls = Buffer.from(SAMPLE);
        const dmarc = Buffer.from("<?xml version=\"1.0\"?><feedback><report_metadata/></feedback>");
        assert.ok(looksLikeTlsReport(tls) && !looksLikeDmarc(tls));
        assert.ok(looksLikeDmarc(dmarc) && !looksLikeTlsReport(dmarc));
    });

    test("a gzipped TLS report survives the shared attachment path", () => {
        const docs = extractDocuments(zlib.gzipSync(Buffer.from(SAMPLE)));
        assert.strictEqual(docs.length, 1);
        assert.strictEqual(parseTlsReport(docs[0]).length, 2);
    });
});

describe("TLS report store", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-tlsrpt"));
    let monitorID;

    before(async () => {
        await testDB.create();
        const inserted = await R.knex("monitor").insert({ name: "Mailbox",
            type: "dmarc" });
        monitorID = Array.isArray(inserted) ? inserted[0] : inserted;
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDB.destroy();
    });

    /**
     * Store every policy of the sample report, optionally aged.
     * @param {number} daysAgo How far back to date the report
     * @param {string} id Report id
     * @returns {Promise<number>} How many were newly stored
     */
    async function saveSample(daysAgo = 1, id = "r1") {
        let stored = 0;
        for (const report of parseTlsReport(Buffer.from(SAMPLE))) {
            report.reportId = id;
            report.dateEnd = now - daysAgo * DAY;
            report.dateBegin = report.dateEnd - DAY;
            if (await store.saveReport(monitorID, report)) {
                stored++;
            }
        }
        return stored;
    }

    test("stores one row per policy", async () => {
        assert.strictEqual(await saveSample(), 2);
        const rows = await R.knex("tlsrpt_report").select();
        assert.strictEqual(rows.length, 2);
    });

    test("the same report id for a different domain is not a duplicate", async () => {
        const domains = (await R.knex("tlsrpt_report").select("domain")).map((r) => r.domain).sort();
        assert.deepStrictEqual(domains, [ "example.com", "shop.example.net" ]);
    });

    test("re-reading the same mail is a no-op", async () => {
        assert.strictEqual(await saveSample(), 0);
        const count = await R.knex("tlsrpt_report").count({ n: "id" });
        assert.strictEqual(Number(count[0].n), 2);
    });

    test("summarises sessions for a domain", async () => {
        const summary = await store.getSummary(monitorID, "example.com", 30);
        assert.strictEqual(summary.sessions, 1000);
        assert.strictEqual(summary.succeeded, 980);
        assert.strictEqual(summary.failed, 20);
        assert.strictEqual(summary.reports, 1);
    });

    test("groups failures by what went wrong and where", async () => {
        const failures = await store.getFailures(monitorID, "example.com", 30);
        assert.strictEqual(failures.length, 2);
        // Worst first, so the message names the biggest problem.
        assert.strictEqual(failures[0].resultType, "certificate-expired");
        assert.strictEqual(failures[0].sessions, 18);
        assert.strictEqual(failures[0].receivingMxHostname, "mx1.example.com");
    });

    test("a clean domain reports no failures", async () => {
        const summary = await store.getSummary(monitorID, "shop.example.net", 30);
        assert.strictEqual(summary.failed, 0);
        assert.deepStrictEqual(await store.getFailures(monitorID, "shop.example.net", 30), []);
    });

    test("prunes old reports and cascades to their failures", async () => {
        await saveSample(40, "old");
        const before = Number((await R.knex("tlsrpt_failure").count({ n: "id" }))[0].n);
        assert.strictEqual(await store.prune(monitorID, 30), 2);
        const after = Number((await R.knex("tlsrpt_failure").count({ n: "id" }))[0].n);
        assert.ok(after < before, "failure rows went with their reports");
    });

    test("lists the domains that have sent TLS reports", async () => {
        const domains = (await store.getKnownDomains(monitorID)).map((d) => d.domain).sort();
        assert.deepStrictEqual(domains, [ "example.com", "shop.example.net" ]);
    });
});
