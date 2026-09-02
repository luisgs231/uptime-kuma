const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../../server/settings");

const store = require("../../../server/dmarc/store");
const { scratchDir, makeReport: report, DAY } = require("./helpers");

const now = Math.floor(Date.now() / 1000);

describe("DMARC store", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-dmarc"));
    let monitorID;

    before(async () => {
        await testDB.create();
        const inserted = await R.knex("monitor").insert({ name: "DMARC",
            type: "dmarc" });
        monitorID = Array.isArray(inserted) ? inserted[0] : inserted;
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("migration created the dmarc tables and monitor columns", async () => {
        assert.ok(await R.knex.schema.hasTable("dmarc_report"));
        assert.ok(await R.knex.schema.hasTable("dmarc_record"));
        assert.ok(await R.knex.schema.hasColumn("monitor", "dmarc_config"));
        assert.ok(await R.knex.schema.hasColumn("monitor", "dmarc_state"));
    });

    test("stores a report and computes its totals", async () => {
        const stored = await store.saveReport(monitorID, report({
            id: "100",
            records: [
                [ "203.0.113.10", 480, "none", true, true ],
                [ "198.51.100.77", 20, "quarantine", false, false ],
            ],
        }));
        assert.strictEqual(stored, true);

        const row = await R.knex("dmarc_report").where({ report_id: "100" }).first();
        assert.strictEqual(Number(row.message_count), 500);
        assert.strictEqual(Number(row.pass_count), 480);
        assert.strictEqual(Number(row.fail_count), 20);
        const recs = await R.knex("dmarc_record").where({ dmarc_report_id: row.id }).count({ n: "id" });
        assert.strictEqual(Number(recs[0].n), 2);
    });

    test("re-reading the same mail is a no-op", async () => {
        const again = await store.saveReport(monitorID, report({
            id: "100",
            records: [[ "203.0.113.10", 999, "none", true, true ]],
        }));
        assert.strictEqual(again, false);

        const count = await R.knex("dmarc_report").where({ report_id: "100" }).count({ n: "id" });
        assert.strictEqual(Number(count[0].n), 1);
        // The duplicate must not have added records either.
        const recs = await R.knex("dmarc_record").count({ n: "id" });
        assert.strictEqual(Number(recs[0].n), 2);
    });

    test("the same report id from a different reporter is a different report", async () => {
        assert.strictEqual(await store.saveReport(monitorID, report({
            id: "100",
            org: "Enterprise Outlook",
            records: [[ "203.0.113.10", 30, "none", true, true ]],
        })), true);
    });

    test("summarises per domain with the newest published policy", async () => {
        await store.saveReport(monitorID, report({
            id: "200",
            domain: "shop.example.net",
            p: "none",
            endsDaysAgo: 3,
            records: [[ "203.0.113.20", 900, "none", true, true ]],
        }));
        await store.saveReport(monitorID, report({
            id: "201",
            domain: "shop.example.net",
            p: "quarantine",
            endsDaysAgo: 1,
            records: [[ "203.0.113.20", 100, "none", true, false ]],
        }));

        const summary = await store.getDomainSummary(monitorID, 30);
        const shop = summary.find((s) => s.domain === "shop.example.net");
        assert.strictEqual(shop.messages, 1000);
        assert.strictEqual(shop.passed, 1000);
        assert.strictEqual(shop.reports, 2);
        // Newest report wins, not the first one seen.
        assert.strictEqual(shop.policy.policy_p, "quarantine");

        const ex = summary.find((s) => s.domain === "example.com");
        assert.strictEqual(ex.messages, 530);
        assert.strictEqual(ex.failed, 20);
        // Busiest domain is listed first.
        assert.strictEqual(summary[0].domain, "shop.example.net");
    });

    test("aggregates sources and tracks when each was first seen", async () => {
        const sources = await store.getSources(monitorID, "example.com", 30);
        const good = sources.find((s) => s.sourceIp === "203.0.113.10");
        const bad = sources.find((s) => s.sourceIp === "198.51.100.77");

        assert.strictEqual(good.messages, 510);
        assert.strictEqual(good.failed, 0);
        assert.strictEqual(good.dkimPassed, 510);

        assert.strictEqual(bad.messages, 20);
        assert.strictEqual(bad.passed, 0);
        assert.strictEqual(bad.failed, 20);
        assert.strictEqual(bad.quarantined, 20);
        assert.ok(bad.firstSeen > 0);
        // Busiest source first.
        assert.strictEqual(sources[0].sourceIp, "203.0.113.10");
    });

    test("first-seen ignores the display window", async () => {
        await store.saveReport(monitorID, report({
            id: "300",
            domain: "old.example.org",
            endsDaysAgo: 40,
            records: [[ "192.0.2.9", 5, "none", true, true ]],
        }));
        const wide = await store.getSources(monitorID, "old.example.org", 90);
        assert.strictEqual(wide.length, 1);
        assert.ok(wide[0].firstSeen <= now - 40 * DAY);

        const narrow = await store.getSources(monitorID, "old.example.org", 7);
        assert.strictEqual(narrow.length, 0, "source outside the window is not listed");
    });

    test("buckets a timeline by day", async () => {
        const timeline = await store.getTimeline(monitorID, "shop.example.net", 10);
        assert.strictEqual(timeline.length, 11);
        const withData = timeline.filter((b) => b.messages > 0);
        assert.strictEqual(withData.length, 2);
        assert.strictEqual(withData.reduce((n, b) => n + b.messages, 0), 1000);
        // Ascending order, so a chart can plot it directly.
        for (let i = 1; i < timeline.length; i++) {
            assert.ok(timeline[i].day > timeline[i - 1].day);
        }
    });

    test("lists recent reports newest first", async () => {
        const recent = await store.getRecentReports(monitorID, null, 10);
        assert.ok(recent.length >= 4);
        for (let i = 1; i < recent.length; i++) {
            assert.ok(recent[i].dateEnd <= recent[i - 1].dateEnd);
        }
        assert.strictEqual(typeof recent[0].reportId, "string");
    });

    test("pruning removes old reports and cascades to their records", async () => {
        const before = Number((await R.knex("dmarc_record").count({ n: "id" }))[0].n);
        const removed = await store.prune(monitorID, 30);
        assert.strictEqual(removed, 1, "only the 40-day-old report is dropped");

        assert.strictEqual(
            Number((await R.knex("dmarc_report").where({ report_id: "300" }).count({ n: "id" }))[0].n), 0);
        const after = Number((await R.knex("dmarc_record").count({ n: "id" }))[0].n);
        assert.strictEqual(after, before - 1, "the orphaned record row went with it");

        assert.strictEqual(await store.prune(monitorID, 0), 0, "retention 0 disables pruning");
    });

    test("the heartbeat bean accepts dmarc_status", async () => {
        const bean = R.dispense("heartbeat");
        bean.monitor_id = monitorID;
        bean.status = 1;
        bean.time = R.isoDateTimeMillis(require("dayjs").utc());
        bean.msg = "[OK] all good";
        bean.dmarc_status = "ok";
        await R.store(bean);

        const stored = await R.knex("heartbeat").where("id", bean.id).first("dmarc_status", "msg");
        assert.strictEqual(stored.dmarc_status, "ok");
        assert.strictEqual(stored.msg, "[OK] all good");
    });

    test("an undeclared column on the heartbeat bean is rejected", async () => {
        const bean = R.dispense("heartbeat");
        bean.monitor_id = monitorID;
        bean.status = 1;
        bean.time = R.isoDateTimeMillis(require("dayjs").utc());
        bean.not_a_real_column = "x";
        await assert.rejects(() => R.store(bean));
    });

    test("deleting the monitor cascades away its reports", async () => {
        const doomed = await R.knex("monitor").insert({ name: "Doomed",
            type: "dmarc" });
        const doomedID = Array.isArray(doomed) ? doomed[0] : doomed;
        await store.saveReport(doomedID, report({ id: "900",
            records: [[ "192.0.2.50", 1, "none", true, true ]] }));

        await R.knex("monitor").where("id", doomedID).delete();
        const left = await R.knex("dmarc_report").where("monitor_id", doomedID).count({ n: "id" });
        assert.strictEqual(Number(left[0].n), 0);
    });
});
