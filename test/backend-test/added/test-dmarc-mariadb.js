const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const { makeReport } = require("./helpers");

/**
 * The DMARC storage layer against MariaDB.
 */
const CONNECTION = process.env.TEST_MYSQL;

describe("DMARC storage on MariaDB", { skip: CONNECTION ? false : "TEST_MYSQL not set" }, () => {
    let db;
    let store;
    let monitorID;

    before(async () => {
        const KumaColumnCompiler = require("../../../server/utils/knex/lib/dialects/mysql2/schema/mysql2-columncompiler");
        const { getDialectByNameOrAlias } = require("knex/lib/dialects");
        const mysql2 = getDialectByNameOrAlias("mysql2");
        mysql2.prototype.columnCompiler = function () {
            return new KumaColumnCompiler(this, ...arguments);
        };

        db = require("knex")({
            client: "mysql2",
            connection: CONNECTION,
            pool: { min: 0,
                max: 5 },
        });

        // Start from nothing so a rerun is not polluted by the previous one.
        const [ tables ] = await db.raw("SHOW TABLES");
        await db.raw("SET FOREIGN_KEY_CHECKS = 0");
        for (const row of tables) {
            await db.raw(`DROP TABLE IF EXISTS \`${Object.values(row)[0]}\``);
        }
        await db.raw("SET FOREIGN_KEY_CHECKS = 1");

        const { R } = require("redbean-node");
        R.setup(db);
        await require("../../../db/knex_init_db.js").createTables();
        await db.migrate.latest({ directory: require("path").resolve(__dirname, "../../../db/knex_migrations") });

        store = require("../../../server/dmarc/store");

        const inserted = await db("monitor").insert({ name: "DMARC",
            type: "dmarc" });
        monitorID = Array.isArray(inserted) ? inserted[0] : inserted;
    });

    after(async () => {
        if (db) {
            await db.destroy();
        }
    });

    test("the migration applies", async () => {
        assert.ok(await db.schema.hasTable("dmarc_report"));
        assert.ok(await db.schema.hasTable("dmarc_record"));
        assert.ok(await db.schema.hasColumn("monitor", "dmarc_config"));
        assert.ok(await db.schema.hasColumn("heartbeat", "dmarc_status"));
    });

    test("date columns are wide enough to outlive 2038", async () => {
        const [ columns ] = await db.raw("SHOW COLUMNS FROM dmarc_report");
        const begin = columns.find((c) => c.Field === "date_begin");
        assert.match(String(begin.Type).toLowerCase(), /bigint/);
    });

    test("stores reports and de-duplicates them", async () => {
        const stored = await store.saveReport(monitorID, makeReport({
            id: "100",
            records: [
                [ "203.0.113.10", 480, "none", true, true ],
                [ "198.51.100.77", 20, "quarantine", false, false ],
            ],
        }));
        assert.strictEqual(stored, true);
        // The unique index has to behave the same way it does on SQLite.
        assert.strictEqual(await store.saveReport(monitorID, makeReport({ id: "100",
            records: [] })), false);
    });

    test("aggregates per domain, including the newest published policy", async () => {
        await store.saveReport(monitorID, makeReport({
            id: "200",
            domain: "shop.example.net",
            p: "none",
            endsDaysAgo: 3,
            records: [[ "203.0.113.20", 900, "none", true, true ]],
        }));
        await store.saveReport(monitorID, makeReport({
            id: "201",
            domain: "shop.example.net",
            p: "quarantine",
            endsDaysAgo: 1,
            records: [[ "203.0.113.20", 100, "none", true, false ]],
        }));

        const summary = await store.getDomainSummary(monitorID, 30);
        const shop = summary.find((s) => s.domain === "shop.example.net");
        assert.strictEqual(shop.messages, 1000);
        assert.strictEqual(shop.reports, 2);
        // The correlated NOT EXISTS subquery that picks the newest policy.
        assert.strictEqual(shop.policy.policy_p, "quarantine");

        const example = summary.find((s) => s.domain === "example.com");
        assert.strictEqual(example.messages, 500);
        assert.strictEqual(example.failed, 20);
    });

    test("aggregates sources with the SUM/CASE expressions", async () => {
        const sources = await store.getSources(monitorID, "example.com", 30);
        const good = sources.find((s) => s.sourceIp === "203.0.113.10");
        const bad = sources.find((s) => s.sourceIp === "198.51.100.77");

        assert.strictEqual(good.messages, 480);
        assert.strictEqual(good.passed, 480);
        assert.strictEqual(good.dkimPassed, 480);
        assert.strictEqual(bad.failed, 20);
        assert.strictEqual(bad.quarantined, 20);
        assert.ok(bad.firstSeen > 0);
    });

    test("buckets a timeline", async () => {
        const timeline = await store.getTimeline(monitorID, "shop.example.net", 10);
        assert.strictEqual(timeline.length, 11);
        assert.strictEqual(timeline.reduce((n, b) => n + b.messages, 0), 1000);
    });

    test("prunes and cascades", async () => {
        await store.saveReport(monitorID, makeReport({
            id: "300",
            domain: "old.example.org",
            endsDaysAgo: 40,
            records: [[ "192.0.2.9", 5, "none", true, true ]],
        }));
        const before = Number((await db("dmarc_record").count({ n: "id" }))[0].n);

        assert.strictEqual(await store.prune(monitorID, 30), 1);
        const after = Number((await db("dmarc_record").count({ n: "id" }))[0].n);
        // InnoDB enforces ON DELETE CASCADE without needing a pragma.
        assert.strictEqual(after, before - 1);
    });

    test("deleting the monitor cascades away its reports", async () => {
        const inserted = await db("monitor").insert({ name: "Doomed",
            type: "dmarc" });
        const doomedID = Array.isArray(inserted) ? inserted[0] : inserted;
        await store.saveReport(doomedID, makeReport({ id: "900",
            records: [[ "192.0.2.50", 1, "none", true, true ]] }));

        await db("monitor").where("id", doomedID).delete();
        const left = await db("dmarc_report").where("monitor_id", doomedID).count({ n: "id" });
        assert.strictEqual(Number(left[0].n), 0);
    });

    test("a long report id survives a round trip intact", async () => {
        const big = "18234567890123456789";
        await store.saveReport(monitorID, makeReport({ id: big,
            domain: "big.example.com",
            records: [[ "192.0.2.77", 1, "none", true, true ]] }));
        const rows = await store.getRecentReports(monitorID, "big.example.com", 5);
        assert.strictEqual(rows[0].reportId, big);
    });
});
