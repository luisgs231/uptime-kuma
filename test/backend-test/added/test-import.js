const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const TestDB = require("../../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../../server/settings");
const { UserSettings } = require("../../../server/user-settings");
const users = require("../../../server/user-management");
const sourceReader = require("../../../server/import/source");
const { importAccountOrUndo } = require("../../../server/import/importer");
const { scratchDir } = require("./helpers");

/**
 * Importing an account out of another Uptime Kuma database.
 */

const FORK_MIGRATIONS = [
    "2026-09-01-0000-add-dmarc-monitor.js",
    "2026-09-01-0001-add-dmarc-heartbeat-status.js",
    "2026-09-01-0002-add-tlsrpt-rbl-carp.js",
    "2026-09-02-0000-add-multi-user.js",
];

/**
 * Build a source database on disk and fill it in.
 * @param {string} file Where to put it
 * @param {boolean} stockShaped Withhold this build's migrations, so tag and
 *                              status_page have no owner column
 * @returns {Promise<object>} A knex handle on the new database
 */
async function buildSource(file, stockShaped = false) {
    const migrationDir = path.resolve(__dirname, "../../../db/knex_migrations");

    const Dialect = require("knex/lib/dialects/sqlite3/index.js");
    Dialect.prototype._driver = () => require("@louislam/sqlite3");

    const db = require("knex")({
        client: Dialect,
        connection: { filename: file },
        useNullAsDefault: true,
    });

    const previous = R.knex;
    R.setup(db);
    await require("../../../db/knex_init_db.js").createTables();

    if (stockShaped) {
        await db.migrate.latest({
            migrationSource: {
                async getMigrations() {
                    return fs
                        .readdirSync(migrationDir)
                        .filter((f) => f.endsWith(".js") && !FORK_MIGRATIONS.includes(f))
                        .sort();
                },
                getMigrationName: (m) => m,
                async getMigration(m) {
                    return require(path.join(migrationDir, m));
                },
            },
        });
    } else {
        await db.migrate.latest({ directory: migrationDir });
    }

    R.setup(previous);
    return db;
}

/**
 * Insert a row and return its id.
 * @param {object} db Knex handle
 * @param {string} table Table name
 * @param {object} row Column values
 * @returns {Promise<number>} The new id
 */
async function insert(db, table, row) {
    const inserted = await db(table).insert(row);
    return Array.isArray(inserted) ? inserted[0] : inserted;
}

describe("Importing an account from another Uptime Kuma", () => {
    const dir = scratchDir("uptime-kuma-test-import");
    const testDB = new TestDB(path.join(dir, "dest"));

    let src;
    let srcFile;
    let sourceUser;
    let otherSourceUser;
    let srcParent;
    let srcChild;
    let srcProxy;

    let existingUser;

    before(async () => {
        fs.rmSync(dir, { recursive: true,
            force: true });
        fs.mkdirSync(dir, { recursive: true });

        await testDB.create();

        existingUser = await users.createUser({ username: "resident",
            password: "x",
            isAdmin: true });
        for (const name of [ "resident-a", "resident-b", "resident-c" ]) {
            await insert(R.knex, "monitor", { name,
                type: "http",
                user_id: existingUser });
        }

        await insert(R.knex, "proxy", { user_id: existingUser,
            protocol: "http",
            host: "resident-proxy.example",
            port: 8080,
            active: 1,
            auth: 0,
            default: 0 });
        await insert(R.knex, "tag", { name: "resident-tag",
            color: "#0000ff",
            user_id: existingUser });
        await insert(R.knex, "notification", { name: "resident-notify",
            config: "{}",
            user_id: existingUser });
        await insert(R.knex, "status_page", { slug: "resident-page",
            title: "Resident",
            icon: "/icon.svg",
            theme: "light",
            user_id: existingUser });

        // --- the source ---
        srcFile = path.join(dir, "source.db");
        src = await buildSource(srcFile);

        sourceUser = await insert(src, "user", { username: "imported",
            password: "$2a$10$sourcehashvalue",
            active: 1,
            twofa_secret: "SECRET123",
            twofa_status: 1 });
        otherSourceUser = await insert(src, "user", { username: "somebody-else",
            password: "x",
            active: 1 });

        srcProxy = await insert(src, "proxy", { user_id: sourceUser,
            protocol: "http",
            host: "proxy.example",
            port: 3128,
            active: 1,
            auth: 0,
            default: 0 });
        const otherProxy = await insert(src, "proxy", { user_id: otherSourceUser,
            protocol: "http",
            host: "not-mine.example",
            port: 3128,
            active: 1,
            auth: 0,
            default: 0 });

        const notification = await insert(src, "notification", { name: "mail",
            config: "{}",
            user_id: sourceUser });
        const tag = await insert(src, "tag", { name: "prod",
            color: "#ff0000",
            user_id: sourceUser });

        srcParent = await insert(src, "monitor", { name: "group-one",
            type: "group",
            user_id: sourceUser });
        srcChild = await insert(src, "monitor", {
            name: "child-http",
            type: "http",
            user_id: sourceUser,
            parent: srcParent,
            proxy_id: srcProxy,
        });
        const lone = await insert(src, "monitor", { name: "lone-http",
            type: "http",
            user_id: sourceUser });

        // Belongs to the other account, and points at their proxy.
        await insert(src, "monitor", { name: "not-mine",
            type: "http",
            user_id: otherSourceUser,
            proxy_id: otherProxy });

        await insert(src, "monitor_tag", { monitor_id: srcChild,
            tag_id: tag,
            value: "" });
        await insert(src, "monitor_notification", { monitor_id: srcChild,
            notification_id: notification });

        for (const monitorID of [ srcChild, lone ]) {
            for (const msg of [ "first", "second" ]) {
                await insert(src, "heartbeat", { monitor_id: monitorID,
                    status: 1,
                    msg,
                    time: "2026-01-01 00:00:00.000",
                    important: 0 });
            }
        }

        const page = await insert(src, "status_page", { slug: "imported-page",
            title: "Imported",
            icon: "/icon.svg",
            theme: "light",
            user_id: sourceUser });
        const group = await insert(src, "group", { name: "Services",
            status_page_id: page,
            public: 1,
            active: 1,
            weight: 1 });
        await insert(src, "monitor_group", { monitor_id: srcChild,
            group_id: group });
        await insert(src, "incident", { title: "outage",
            content: "x",
            status_page_id: page });

        await insert(src, "api_key", { key: "abc",
            name: "script",
            user_id: sourceUser,
            active: 1,
            expires: null });

        // Instance settings, which must never come across.
        await insert(src, "setting", { key: "trustProxy",
            value: "true",
            type: "general" });
        await insert(src, "setting", { key: "primaryBaseURL",
            value: '"http://old-instance"',
            type: "general" });
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        if (src) {
            await src.destroy();
        }
        await testDB.destroy();
        fs.rmSync(dir, { recursive: true,
            force: true });
    });

    test("the source is recognised and its accounts listed", async () => {
        const result = await sourceReader.inspect({ type: "sqlite",
            path: srcFile });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.users.length, 2);

        const mine = result.users.find((u) => u.username === "imported");
        assert.strictEqual(mine.monitors, 3, "three of the four monitors are theirs");
    });

    test("something that is not an Uptime Kuma database is refused", async () => {
        const notKuma = path.join(dir, "empty.db");
        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");
        const db = require("knex")({ client: Dialect,
            connection: { filename: notKuma },
            useNullAsDefault: true });
        await db.schema.createTable("something_else", (t) => t.increments("id"));
        await db.destroy();

        const result = await sourceReader.inspect({ type: "sqlite",
            path: notKuma });
        assert.strictEqual(result.ok, false);
        assert.match(result.msg, /does not look like an Uptime Kuma database/);
    });

    test("a file that is not there is refused rather than crashing", async () => {
        const result = await sourceReader.inspect({ type: "sqlite",
            path: path.join(dir, "nope.db") });
        assert.strictEqual(result.ok, false);
        assert.match(result.msg, /could not be found/);
    });

    test("the summary counts what would come across", async () => {
        const db = sourceReader.connect({ type: "sqlite",
            path: srcFile });
        const counts = await sourceReader.summarise(db, sourceUser);
        await db.destroy();

        assert.strictEqual(counts.monitor, 3);
        assert.strictEqual(counts.heartbeat, 4);
        assert.strictEqual(counts.tag, 1);
        assert.strictEqual(counts.notification, 1);
        assert.strictEqual(counts.proxy, 1, "the other account's proxy is not counted");
    });

    describe("after importing", () => {
        let newUserID;
        let counts;

        before(async () => {
            newUserID = await users.createUser({ username: "imported",
                password: "placeholder",
                isAdmin: false });

            const handle = sourceReader.connect({ type: "sqlite",
                path: srcFile });
            try {
                counts = await importAccountOrUndo({
                    source: handle,
                    dest: R.knex,
                    sourceUserID: sourceUser,
                    newUserID,
                });
            } finally {
                await handle.destroy();
            }
        });

        test("the monitors came across, and only theirs", async () => {
            const imported = await R.knex("monitor").where({ user_id: newUserID }).orderBy("name");
            assert.deepStrictEqual(
                imported.map((m) => m.name),
                [ "child-http", "group-one", "lone-http" ]
            );
            assert.strictEqual(counts.monitor, 3);
        });

        test("the parent link points at the new monitor, not the old id", async () => {
            const parent = await R.knex("monitor").where({ user_id: newUserID,
                name: "group-one" }).first();
            const child = await R.knex("monitor").where({ user_id: newUserID,
                name: "child-http" }).first();

            assert.strictEqual(child.parent, parent.id);
            assert.notStrictEqual(child.parent, srcParent, "must not be the source's id");
        });

        test("the proxy was remapped to the imported one", async () => {
            const child = await R.knex("monitor").where({ user_id: newUserID,
                name: "child-http" }).first();
            const proxy = await R.knex("proxy").where({ user_id: newUserID }).first();

            assert.strictEqual(child.proxy_id, proxy.id);
            assert.strictEqual(proxy.host, "proxy.example");

            const pointedAt = await R.knex("proxy").where({ id: child.proxy_id }).first();
            assert.strictEqual(pointedAt.user_id, newUserID, "must not point at the resident's proxy");
        });

        test("only the account's own proxy came across", async () => {
            const all = await R.knex("proxy").where({ user_id: newUserID });
            assert.strictEqual(all.length, 1);
            assert.strictEqual((await R.knex("proxy").where({ host: "not-mine.example" })).length, 0);
        });

        test("heartbeats are attached to the right monitors", async () => {
            const child = await R.knex("monitor").where({ user_id: newUserID,
                name: "child-http" }).first();
            const beats = await R.knex("heartbeat").where({ monitor_id: child.id }).orderBy("msg");

            assert.deepStrictEqual(beats.map((b) => b.msg), [ "first", "second" ]);
            assert.strictEqual(counts.heartbeat, 4);
        });

        test("tags and notifications are linked to the right monitor", async () => {
            const child = await R.knex("monitor").where({ user_id: newUserID,
                name: "child-http" }).first();

            const tagLink = await R.knex("monitor_tag").where({ monitor_id: child.id }).first();
            const tag = await R.knex("tag").where({ id: tagLink.tag_id }).first();
            assert.strictEqual(tag.name, "prod");
            assert.strictEqual(tag.user_id, newUserID);

            const notifyLink = await R.knex("monitor_notification").where({ monitor_id: child.id }).first();
            const notification = await R.knex("notification").where({ id: notifyLink.notification_id }).first();
            assert.strictEqual(notification.name, "mail");
            assert.strictEqual(notification.user_id, newUserID);
        });

        test("the status page, its group and its incident came across", async () => {
            const page = await R.knex("status_page").where({ user_id: newUserID }).first();
            assert.strictEqual(page.slug, "imported-page");

            const group = await R.knex("group").where({ status_page_id: page.id }).first();
            assert.strictEqual(group.name, "Services");

            const child = await R.knex("monitor").where({ user_id: newUserID,
                name: "child-http" }).first();
            const link = await R.knex("monitor_group").where({ group_id: group.id }).first();
            assert.strictEqual(link.monitor_id, child.id);

            const incident = await R.knex("incident").where({ status_page_id: page.id }).first();
            assert.strictEqual(incident.title, "outage");
        });

        test("the password and 2FA came across so they log in as before", async () => {
            const row = await R.knex("user").where({ id: newUserID }).first();
            assert.strictEqual(row.password, "$2a$10$sourcehashvalue");
            assert.strictEqual(row.twofa_secret, "SECRET123");
            assert.ok(row.twofa_status);
        });

        test("the role is this instance's decision, not the source's", async () => {
            const row = await R.knex("user").where({ id: newUserID }).first();
            assert.ok(!row.is_admin, "created as a regular account, and the import must not change that");
        });

        test("instance settings were not imported", async () => {
            const trustProxy = await R.knex("setting").where({ key: "trustProxy" }).first();
            const baseURL = await R.knex("setting").where({ key: "primaryBaseURL" }).first();
            assert.ok(!trustProxy, "trustProxy must not have been imported");
            assert.ok(!baseURL, "primaryBaseURL must not have been imported");
        });

        test("the resident account is untouched", async () => {
            const theirs = await R.knex("monitor").where({ user_id: existingUser }).orderBy("name");
            assert.deepStrictEqual(theirs.map((m) => m.name), [ "resident-a", "resident-b", "resident-c" ]);
            assert.strictEqual((await R.knex("heartbeat").whereIn("monitor_id", theirs.map((m) => m.id))).length, 0);
        });

        test("nothing points outside the account that owns it", async () => {
            const monitors = await R.knex("monitor").select();
            for (const monitor of monitors) {
                if (monitor.parent) {
                    const parent = await R.knex("monitor").where({ id: monitor.parent }).first();
                    assert.strictEqual(parent.user_id, monitor.user_id, `${monitor.name} has a foreign parent`);
                }
                if (monitor.proxy_id) {
                    const proxy = await R.knex("proxy").where({ id: monitor.proxy_id }).first();
                    assert.strictEqual(proxy.user_id, monitor.user_id, `${monitor.name} has a foreign proxy`);
                }
            }
        });
    });
});

describe("Importing from a stock single-account instance", () => {
    const dir = scratchDir("uptime-kuma-test-import-stock");
    const testDB = new TestDB(path.join(dir, "dest"));

    let src;
    let srcFile;
    let sourceUser;

    before(async () => {
        fs.rmSync(dir, { recursive: true,
            force: true });
        fs.mkdirSync(dir, { recursive: true });
        await testDB.create();

        srcFile = path.join(dir, "stock.db");
        src = await buildSource(srcFile, true);

        sourceUser = await insert(src, "user", { username: "solo",
            password: "$2a$10$stock",
            active: 1 });
        await insert(src, "monitor", { name: "stock-monitor",
            type: "http",
            user_id: sourceUser });

        // No user_id column on either of these in a stock database.
        await insert(src, "tag", { name: "stock-tag",
            color: "#00ff00" });
        await insert(src, "status_page", { slug: "stock-page",
            title: "Stock",
            icon: "/icon.svg",
            theme: "light" });
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        if (src) {
            await src.destroy();
        }
        await testDB.destroy();
        fs.rmSync(dir, { recursive: true,
            force: true });
    });

    test("the stock source really has no owner columns", async () => {
        assert.strictEqual(await src.schema.hasColumn("tag", "user_id"), false);
        assert.strictEqual(await src.schema.hasColumn("status_page", "user_id"), false);
        assert.strictEqual(await src.schema.hasColumn("user", "is_admin"), false);
    });

    test("unowned rows are taken as the single account's", async () => {
        const newUserID = await users.createUser({ username: "solo",
            password: "placeholder" });

        const handle = sourceReader.connect({ type: "sqlite",
            path: srcFile });
        try {
            await importAccountOrUndo({
                source: handle,
                dest: R.knex,
                sourceUserID: sourceUser,
                newUserID,
            });
        } finally {
            await handle.destroy();
        }

        assert.strictEqual((await R.knex("monitor").where({ user_id: newUserID })).length, 1);

        const tag = await R.knex("tag").where({ name: "stock-tag" }).first();
        assert.strictEqual(tag.user_id, newUserID, "the tag now belongs to the imported account");

        const page = await R.knex("status_page").where({ slug: "stock-page" }).first();
        assert.strictEqual(page.user_id, newUserID);
    });
});

describe("An import that fails leaves nothing behind", () => {
    const dir = scratchDir("uptime-kuma-test-import-rollback");
    const testDB = new TestDB(path.join(dir, "dest"));

    before(async () => {
        fs.rmSync(dir, { recursive: true,
            force: true });
        fs.mkdirSync(dir, { recursive: true });
        await testDB.create();
        await users.createUser({ username: "keeper",
            password: "x",
            isAdmin: true });
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
        fs.rmSync(dir, { recursive: true,
            force: true });
    });

    test("the half-created account is removed", async () => {
        const newUserID = await users.createUser({ username: "doomed",
            password: "placeholder" });

        const broken = () => {
            throw new Error("the source went away mid-import");
        };
        broken.schema = {
            hasTable: async () => {
                throw new Error("the source went away mid-import");
            },
        };

        await assert.rejects(
            () => importAccountOrUndo({ source: broken,
                dest: R.knex,
                sourceUserID: 1,
                newUserID }),
            /went away/
        );

        assert.strictEqual(
            (await R.knex("user").where({ id: newUserID })).length,
            0,
            "the account must not survive a failed import"
        );
    });
});
