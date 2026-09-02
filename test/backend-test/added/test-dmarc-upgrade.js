const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { scratchDir } = require("./helpers");

/**
 * Deploying this fork over an existing Uptime Kuma instance.
 */
describe("Upgrading an existing instance", () => {
    const dir = scratchDir("uptime-kuma-test-dmarc-upgrade");
    const dbPath = path.join(dir, "kuma.db");
    const realMigrations = path.resolve(__dirname, "../../../db/knex_migrations");

    let db;

    /**
     * The migrations this fork adds, named rather than pattern-matched.
     */
    const FORK_MIGRATIONS = [
        "2026-09-01-0000-add-dmarc-monitor.js",
        "2026-09-01-0001-add-dmarc-heartbeat-status.js",
        "2026-09-01-0002-add-tlsrpt-rbl-carp.js",
        "2026-09-02-0000-add-multi-user.js",
    ];

    /**
     * Knex migration source exposing everything except this fork's migrations.
     */
    const stockSource = {
        async getMigrations() {
            return fs.readdirSync(realMigrations)
                .filter((f) => f.endsWith(".js") && !FORK_MIGRATIONS.includes(f))
                .sort();
        },
        getMigrationName(migration) {
            return migration;
        },
        async getMigration(migration) {
            return require(path.join(realMigrations, migration));
        },
    };

    before(async () => {
        fs.rmSync(dir, { recursive: true,
            force: true });
        fs.mkdirSync(dir, { recursive: true });

        const onDisk = fs.readdirSync(realMigrations).filter((f) => f.endsWith(".js"));
        for (const name of FORK_MIGRATIONS) {
            assert.ok(onDisk.includes(name), `${name} is listed as a fork migration but is not on disk`);
        }

        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        db = require("knex")({
            client: Dialect,
            connection: { filename: dbPath },
            useNullAsDefault: true,
        });

        const { R } = require("redbean-node");
        R.setup(db);
        await require("../../../db/knex_init_db.js").createTables();
        await db.migrate.latest({ migrationSource: stockSource });
    });

    after(async () => {
        if (db) {
            await db.destroy();
        }
        fs.rmSync(dir, { recursive: true,
            force: true });
    });

    test("a stock database has none of the fork's schema", async () => {
        assert.strictEqual(await db.schema.hasTable("dmarc_report"), false);
        assert.strictEqual(await db.schema.hasColumn("monitor", "dmarc_config"), false);
        assert.strictEqual(await db.schema.hasColumn("heartbeat", "dmarc_status"), false);
    });

    test("upgrading in place keeps every existing row", async () => {
        const [ userID ] = await db("user").insert({ username: "existing",
            password: "hash" });
        const [ monitorID ] = await db("monitor").insert({
            name: "Existing HTTP monitor",
            type: "http",
            url: "https://example.com",
            user_id: userID,
            interval: 60,
        });
        await db("heartbeat").insert([
            { monitor_id: monitorID,
                status: 1,
                msg: "200 - OK",
                time: "2026-08-30 10:00:00.000",
                ping: 42,
                important: true },
            { monitor_id: monitorID,
                status: 0,
                msg: "timeout",
                time: "2026-08-31 10:00:00.000",
                ping: null,
                important: true },
        ]);

        // The upgrade: same database, now with the fork's migrations present.
        await db.migrate.latest({ directory: realMigrations });

        const monitors = await db("monitor").select();
        assert.strictEqual(monitors.length, 1);
        assert.strictEqual(monitors[0].name, "Existing HTTP monitor");
        assert.strictEqual(monitors[0].url, "https://example.com");
        assert.strictEqual(Number(monitors[0].interval), 60);

        const beats = await db("heartbeat").orderBy("id").select();
        assert.strictEqual(beats.length, 2);
        assert.strictEqual(beats[0].msg, "200 - OK");
        assert.strictEqual(Number(beats[0].ping), 42);
        assert.strictEqual(beats[1].msg, "timeout");

        const users = await db("user").select();
        assert.strictEqual(users.length, 1);
        assert.strictEqual(users[0].username, "existing");
    });

    test("the new schema is present after the upgrade", async () => {
        assert.ok(await db.schema.hasTable("dmarc_report"));
        assert.ok(await db.schema.hasTable("dmarc_record"));
        assert.ok(await db.schema.hasColumn("monitor", "dmarc_config"));
        assert.ok(await db.schema.hasColumn("monitor", "dmarc_state"));
        assert.ok(await db.schema.hasColumn("heartbeat", "dmarc_status"));
    });

    test("pre-existing rows get null in the new columns, not garbage", async () => {
        const monitor = await db("monitor").first();
        assert.strictEqual(monitor.dmarc_config, null);
        assert.strictEqual(monitor.dmarc_state, null);

        const beat = await db("heartbeat").first();
        assert.strictEqual(beat.dmarc_status, null);

        const { parseConfig } = require("../../../server/dmarc/config");
        assert.strictEqual(parseConfig(monitor.dmarc_config).domain, "");
        assert.strictEqual(parseConfig(monitor.dmarc_config).imap.port, 993);
    });

    test("running the upgrade again is a no-op", async () => {
        await db.migrate.latest({ directory: realMigrations });
        assert.strictEqual((await db("monitor").select()).length, 1);
        assert.strictEqual((await db("heartbeat").select()).length, 2);
    });

    test("reverting to stock Kuma afterwards would refuse to start", async () => {
        await assert.rejects(
            () => db.migrate.latest({ migrationSource: stockSource }),
            /corrupt|missing/i
        );
    });
});
