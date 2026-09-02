const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../../server/settings");
const { UserSettings } = require("../../../server/user-settings");
const users = require("../../../server/user-management");
const { checkAdmin } = require("../../../server/util-server");
const { scratchDir } = require("./helpers");

/**
 * Remove every account, so each test starts from a known instance.
 * @returns {Promise<void>} Promise
 */
async function clearUsers() {
    await R.knex("user_setting").delete();
    await R.knex("user").delete();
}

describe("Managing accounts", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-user-management"));

    before(async () => {
        await testDB.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    beforeEach(async () => {
        await clearUsers();
    });

    test("an account can be created, and comes back in the list", async () => {
        const id = await users.createUser({ username: "alice",
            password: "hunter2",
            isAdmin: true });

        const list = await users.listUsers();
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].id, id);
        assert.strictEqual(list[0].username, "alice");
        assert.strictEqual(list[0].isAdmin, true);
        assert.strictEqual(list[0].active, true);
    });

    test("the list never carries password hashes", async () => {
        await users.createUser({ username: "alice",
            password: "hunter2",
            isAdmin: true });

        const list = await users.listUsers();
        assert.ok(!("password" in list[0]), "a password hash must not leave the server");
    });

    test("the password is hashed, not stored", async () => {
        await users.createUser({ username: "alice",
            password: "hunter2" });
        const row = await R.knex("user").where("username", "alice").first();
        assert.notStrictEqual(row.password, "hunter2");
        assert.ok(row.password.length > 20);
    });

    test("a username cannot be blank or taken", async () => {
        await users.createUser({ username: "alice",
            password: "x" });

        await assert.rejects(() => users.createUser({ username: "alice",
            password: "x" }), /already taken/);
        await assert.rejects(() => users.createUser({ username: "  ",
            password: "x" }), /input a username/);
        await assert.rejects(() => users.createUser({ username: "bob",
            password: "" }), /input a password/);
    });

    test("a username is compared after trimming", async () => {
        await users.createUser({ username: "alice",
            password: "x" });
        await assert.rejects(() => users.createUser({ username: "  alice  ",
            password: "x" }), /already taken/);
    });

    test("an account can be renamed, promoted and switched off", async () => {
        await users.createUser({ username: "keeper",
            password: "x",
            isAdmin: true });
        const bob = await users.createUser({ username: "bob",
            password: "x" });

        await users.updateUser(bob, { username: "robert",
            isAdmin: true });
        let row = await R.knex("user").where("id", bob).first();
        assert.strictEqual(row.username, "robert");
        assert.ok(row.is_admin);

        await users.updateUser(bob, { active: false });
        row = await R.knex("user").where("id", bob).first();
        assert.ok(!row.active);
    });
});

describe("Never locking the instance out", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-last-admin"));

    before(async () => {
        await testDB.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    beforeEach(async () => {
        await clearUsers();
    });

    test("the only administrator cannot be demoted", async () => {
        const alice = await users.createUser({ username: "alice",
            password: "x",
            isAdmin: true });
        await users.createUser({ username: "bob",
            password: "x" });

        await assert.rejects(() => users.updateUser(alice, { isAdmin: false }), /only administrator/);
    });

    test("the only administrator cannot be switched off either", async () => {
        // Just as effective at locking the instance out as demoting them.
        const alice = await users.createUser({ username: "alice",
            password: "x",
            isAdmin: true });

        await assert.rejects(() => users.updateUser(alice, { active: false }), /only administrator/);
    });

    test("the only administrator cannot be deleted", async () => {
        const alice = await users.createUser({ username: "alice",
            password: "x",
            isAdmin: true });

        await assert.rejects(() => users.assertNotLastAdmin(alice), /only administrator/);
    });

    test("a second administrator makes the first one demotable", async () => {
        const alice = await users.createUser({ username: "alice",
            password: "x",
            isAdmin: true });
        await users.createUser({ username: "bob",
            password: "x",
            isAdmin: true });

        await users.updateUser(alice, { isAdmin: false });
        const row = await R.knex("user").where("id", alice).first();
        assert.ok(!row.is_admin);
    });

    test("a deactivated administrator does not count as one", async () => {
        const alice = await users.createUser({ username: "alice",
            password: "x",
            isAdmin: true });
        const bob = await users.createUser({ username: "bob",
            password: "x",
            isAdmin: true });

        await users.updateUser(bob, { active: false });
        await assert.rejects(() => users.updateUser(alice, { isAdmin: false }), /only administrator/);
    });

    test("a regular account can always be removed", async () => {
        await users.createUser({ username: "alice",
            password: "x",
            isAdmin: true });
        const bob = await users.createUser({ username: "bob",
            password: "x" });

        await users.assertNotLastAdmin(bob);
        await users.updateUser(bob, { active: false });
    });
});

describe("The admin check itself", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-check-admin"));

    let admin;
    let regular;
    let inactiveAdmin;

    before(async () => {
        await testDB.create();
        admin = await users.createUser({ username: "admin",
            password: "x",
            isAdmin: true });
        regular = await users.createUser({ username: "regular",
            password: "x" });
        inactiveAdmin = await users.createUser({ username: "gone",
            password: "x",
            isAdmin: true });
        await users.updateUser(inactiveAdmin, { active: false });
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("an administrator passes", async () => {
        const user = await checkAdmin({ userID: admin });
        assert.strictEqual(user.username, "admin");
    });

    test("a regular account does not", async () => {
        await assert.rejects(() => checkAdmin({ userID: regular }), /permission/);
    });

    test("nobody logged in does not", async () => {
        await assert.rejects(() => checkAdmin({}), /not logged in/);
        await assert.rejects(() => checkAdmin({ userID: null }), /not logged in/);
    });

    test("an account that no longer exists does not", async () => {
        await assert.rejects(() => checkAdmin({ userID: 999999 }), /permission/);
    });

    test("a deactivated administrator does not", async () => {
        await assert.rejects(() => checkAdmin({ userID: inactiveAdmin }), /permission/);
    });

    test("demoting an administrator takes effect immediately", async () => {
        const victim = await users.createUser({ username: "temp",
            password: "x",
            isAdmin: true });
        const socket = { userID: victim };

        assert.ok(await checkAdmin(socket), "an admin to begin with");
        await users.updateUser(victim, { isAdmin: false });
        await assert.rejects(() => checkAdmin(socket), /permission/);
    });
});

describe("Deleting an account takes its data with it", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-user-delete"));

    let alice;
    let bob;
    let aliceMonitor;
    let bobMonitor;

    /**
     * Insert a row and return its id.
     * @param {string} table Table name
     * @param {object} row Column values
     * @returns {Promise<number>} The new id
     */
    async function insert(table, row) {
        const inserted = await R.knex(table).insert(row);
        return Array.isArray(inserted) ? inserted[0] : inserted;
    }

    before(async () => {
        await testDB.create();

        alice = await users.createUser({ username: "alice",
            password: "x",
            isAdmin: true });
        bob = await users.createUser({ username: "bob",
            password: "x",
            isAdmin: true });

        aliceMonitor = await insert("monitor", { name: "alice-http",
            type: "http",
            user_id: alice });
        bobMonitor = await insert("monitor", { name: "bob-http",
            type: "http",
            user_id: bob });

        for (const monitorID of [ aliceMonitor, bobMonitor ]) {
            await insert("heartbeat", { monitor_id: monitorID,
                status: 1,
                msg: "ok",
                time: "2026-01-01 00:00:00.000",
                important: 0 });
        }

        const page = await insert("status_page", { slug: "alice-page",
            title: "Alice",
            icon: "/icon.svg",
            theme: "light",
            user_id: alice });
        await insert("incident", { title: "outage",
            content: "x",
            status_page_id: page });
        await insert("group", { name: "Services",
            status_page_id: page });

        await insert("tag", { name: "alice-tag",
            color: "#fff",
            user_id: alice });
        await insert("notification", { name: "alice-notify",
            config: "{}",
            user_id: alice });
        await insert("maintenance", { title: "window",
            description: "x",
            strategy: "single",
            active: 1,
            user_id: alice });

        await UserSettings.set(alice, "tlsExpiryNotifyDays", [ 1 ]);
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("it reports what it is about to destroy", async () => {
        const summary = await users.describeUserData(alice);
        assert.strictEqual(summary.monitors, 1);
        assert.strictEqual(summary.statusPages, 1);
        assert.strictEqual(summary.tags, 1);
        assert.strictEqual(summary.notifications, 1);
        assert.strictEqual(summary.maintenance, 1);
    });

    test("everything the account owned is gone", async () => {
        await users.deleteUser(alice);

        const empty = async (table, where) => {
            const rows = await R.knex(table).where(where);
            assert.strictEqual(rows.length, 0, `${table} should be empty`);
        };

        await empty("user", { id: alice });
        await empty("monitor", { user_id: alice });
        await empty("status_page", { user_id: alice });
        await empty("tag", { user_id: alice });
        await empty("notification", { user_id: alice });
        await empty("maintenance", { user_id: alice });
        await empty("user_setting", { user_id: alice });
    });

    test("no monitor is left running with no owner", async () => {
        const orphans = await R.knex("monitor").whereNull("user_id");
        assert.strictEqual(orphans.length, 0);
    });

    test("its heartbeats went with its monitors", async () => {
        const beats = await R.knex("heartbeat").where("monitor_id", aliceMonitor);
        assert.strictEqual(beats.length, 0);
    });

    test("the groups and incidents on its status page are gone", async () => {
        // Neither has a foreign key to the status page, so neither cascades.
        assert.strictEqual((await R.knex("incident")).length, 0);
        assert.strictEqual((await R.knex("group")).length, 0);
    });

    test("the other account is untouched", async () => {
        const bobRow = await R.knex("user").where("id", bob).first();
        assert.ok(bobRow, "bob should still exist");

        const bobMonitors = await R.knex("monitor").where("user_id", bob);
        assert.strictEqual(bobMonitors.length, 1);

        const bobBeats = await R.knex("heartbeat").where("monitor_id", bobMonitor);
        assert.strictEqual(bobBeats.length, 1);
    });

    test("deleting an account that does not exist says so", async () => {
        await assert.rejects(() => users.deleteUser(999999), /Not found/);
    });
});
