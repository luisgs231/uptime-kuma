const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");

/**
 * The multi-user work against MariaDB.
 */
const CONNECTION = process.env.TEST_MYSQL;

describe("Multiple accounts on MariaDB", { skip: CONNECTION ? false : "TEST_MYSQL not set" }, () => {
    let db;
    let users;
    let UserSettings;
    let Settings;
    let own;
    let clearOldData;
    let buildRobotsTxt;

    /**
     * Insert a row and return its id.
     * @param {string} table Table name
     * @param {object} row Column values
     * @returns {Promise<number>} The new id
     */
    async function insert(table, row) {
        const inserted = await db(table).insert(row);
        return Array.isArray(inserted) ? inserted[0] : inserted;
    }

    before(async () => {
        const KumaColumnCompiler = require("../../../server/utils/knex/lib/dialects/mysql2/schema/mysql2-columncompiler");
        const { getDialectByNameOrAlias } = require("knex/lib/dialects");
        const mysql2 = getDialectByNameOrAlias("mysql2");
        mysql2.prototype.columnCompiler = function () {
            return new KumaColumnCompiler(this, ...arguments);
        };

        const url = new URL(CONNECTION);
        const ownDatabase = `${url.pathname.replace(/^\//, "") || "kuma_test"}_multiuser`;

        const withoutDatabase = new URL(CONNECTION);
        withoutDatabase.pathname = "/";
        const admin = require("knex")({ client: "mysql2",
            connection: withoutDatabase.toString() });
        await admin.raw(`CREATE DATABASE IF NOT EXISTS \`${ownDatabase}\` CHARACTER SET utf8mb4`);
        await admin.destroy();

        url.pathname = `/${ownDatabase}`;
        db = require("knex")({
            client: "mysql2",
            connection: url.toString(),
            pool: { min: 0,
                max: 5 },
        });

        const [ tables ] = await db.raw("SHOW TABLES");
        await db.raw("SET FOREIGN_KEY_CHECKS = 0");
        for (const row of tables) {
            await db.raw(`DROP TABLE IF EXISTS \`${Object.values(row)[0]}\``);
        }
        await db.raw("SET FOREIGN_KEY_CHECKS = 1");

        const { R } = require("redbean-node");
        R.setup(db);
        await require("../../../db/knex_init_db.js").createTables();
        await db.migrate.latest({ directory: path.resolve(__dirname, "../../../db/knex_migrations") });

        users = require("../../../server/user-management");
        UserSettings = require("../../../server/user-settings").UserSettings;
        Settings = require("../../../server/settings").Settings;
        own = require("../../../server/ownership");
        clearOldData = require("../../../server/jobs/clear-old-data").clearOldData;
        buildRobotsTxt = require("../../../server/robots").buildRobotsTxt;

        // The retention job asks the database layer what dialect it is on.
        const Database = require("../../../server/database");
        Database.dbConfig = { type: "mysql" };
    });

    after(async () => {
        Settings?.stopCacheCleaner();
        UserSettings?.stopCacheCleaner();
        if (db) {
            await db.destroy();
        }
    });

    test("the migration applies", async () => {
        assert.ok(await db.schema.hasColumn("user", "is_admin"));
        assert.ok(await db.schema.hasTable("user_setting"));
        assert.ok(await db.schema.hasColumn("tag", "user_id"));
        assert.ok(await db.schema.hasColumn("status_page", "user_id"));
    });

    test("is_admin is a boolean MySQL can actually store", async () => {
        const [ columns ] = await db.raw("SHOW COLUMNS FROM `user`");
        const column = columns.find((c) => c.Field === "is_admin");
        assert.ok(column, "is_admin should exist");
        assert.match(String(column.Type).toLowerCase(), /tinyint/);
    });

    test("the unique index on user_setting was accepted", async () => {
        const [ indexes ] = await db.raw("SHOW INDEX FROM user_setting");
        assert.ok(
            indexes.some((i) => i.Key_name === "user_setting_unique"),
            "the unique index should exist"
        );
    });

    test("a reserved word as a column name round-trips", async () => {
        const alice = await users.createUser({ username: "alice",
            password: "x",
            isAdmin: true });

        await UserSettings.set(alice, "tlsExpiryNotifyDays", [ 3, 9 ]);
        assert.deepStrictEqual(await UserSettings.get(alice, "tlsExpiryNotifyDays"), [ 3, 9 ]);

        const all = await UserSettings.getSettings(alice);
        assert.deepStrictEqual(all.tlsExpiryNotifyDays, [ 3, 9 ]);

        // Writing the same key twice must update rather than violate the index.
        await UserSettings.set(alice, "tlsExpiryNotifyDays", [ 1 ]);
        const rows = await db("user_setting").where({ user_id: alice,
            key: "tlsExpiryNotifyDays" });
        assert.strictEqual(rows.length, 1);
    });

    test("TINYINT is_admin still reads as a role", async () => {
        const list = await users.listUsers();
        const alice = list.find((u) => u.username === "alice");
        assert.strictEqual(alice.isAdmin, true, "must be a real boolean by the time it leaves the server");
        assert.strictEqual(alice.active, true);

        const { checkAdmin } = require("../../../server/util-server");
        assert.ok(await checkAdmin({ userID: alice.id }));

        const bob = await users.createUser({ username: "bob",
            password: "x" });
        await assert.rejects(() => checkAdmin({ userID: bob }), /permission/);
    });

    test("the last-admin rule counts correctly", async () => {
        const list = await users.listUsers();
        const alice = list.find((u) => u.username === "alice");
        await assert.rejects(() => users.updateUser(alice.id, { isAdmin: false }), /only administrator/);
    });

    test("ownership checks work", async () => {
        const list = await users.listUsers();
        const alice = list.find((u) => u.username === "alice").id;
        const bob = list.find((u) => u.username === "bob").id;

        const aliceMonitor = await insert("monitor", { name: "alice",
            type: "http",
            user_id: alice });

        assert.ok(await own.requireOwnedMonitor(aliceMonitor, alice));
        await assert.rejects(() => own.requireOwnedMonitor(aliceMonitor, bob), /Not found/);
        await own.requireAllOwned("monitor", [ aliceMonitor ], alice);
        await assert.rejects(() => own.requireAllOwned("monitor", [ aliceMonitor ], bob), /Not found/);
    });

    test("retention deletes per owner with a subquery", async () => {
        const list = await users.listUsers();
        const alice = list.find((u) => u.username === "alice").id;
        const bob = list.find((u) => u.username === "bob").id;

        const aliceMonitor = await db("monitor").where("user_id", alice).first("id");
        const bobMonitor = await insert("monitor", { name: "bob",
            type: "http",
            user_id: bob });

        for (const monitorID of [ aliceMonitor.id, bobMonitor ]) {
            await insert("heartbeat", { monitor_id: monitorID,
                status: 1,
                msg: "old",
                time: "2020-01-01 00:00:00.000",
                important: 0 });
        }

        await UserSettings.set(alice, "keepDataPeriodDays", 30);
        await UserSettings.set(bob, "keepDataPeriodDays", 100000);

        await clearOldData();

        assert.strictEqual((await db("heartbeat").where("monitor_id", aliceMonitor.id)).length, 0);
        assert.strictEqual((await db("heartbeat").where("monitor_id", bobMonitor)).length, 1);
    });

    test("robots.txt is assembled from the accounts", async () => {
        const list = await users.listUsers();
        const alice = list.find((u) => u.username === "alice").id;

        await insert("status_page", { slug: "alice-page",
            title: "Alice",
            icon: "/icon.svg",
            theme: "light",
            published: 1,
            user_id: alice });

        assert.strictEqual(await buildRobotsTxt(), "User-agent: *\nDisallow: /");

        await UserSettings.set(alice, "searchEngineIndex", true);
        assert.strictEqual(await buildRobotsTxt(), "User-agent: *\nDisallow:");
    });

    test("deleting an account cascades, including the table called `group`", async () => {
        const list = await users.listUsers();
        const alice = list.find((u) => u.username === "alice").id;

        const page = await db("status_page").where("user_id", alice).first("id");
        await insert("group", { name: "Services",
            status_page_id: page.id });
        await insert("incident", { title: "outage",
            content: "x",
            status_page_id: page.id });
        await insert("tag", { name: "alice-tag",
            color: "#fff",
            user_id: alice });

        // Another admin, so the last-admin rule does not block the delete.
        await users.createUser({ username: "second-admin",
            password: "x",
            isAdmin: true });

        await users.deleteUser(alice);

        assert.strictEqual((await db("user").where("id", alice)).length, 0);
        assert.strictEqual((await db("monitor").where("user_id", alice)).length, 0);
        assert.strictEqual((await db("status_page").where("user_id", alice)).length, 0);
        assert.strictEqual((await db("tag").where("user_id", alice)).length, 0);
        assert.strictEqual((await db("user_setting").where("user_id", alice)).length, 0);
        assert.strictEqual((await db("group")).length, 0);
        assert.strictEqual((await db("incident")).length, 0);
        assert.strictEqual((await db("monitor").whereNull("user_id")).length, 0, "no orphaned monitors");
    });
});
