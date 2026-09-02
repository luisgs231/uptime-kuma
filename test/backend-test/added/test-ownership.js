const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../../server/settings");
const { UserSettings } = require("../../../server/user-settings");
const own = require("../../../server/ownership");
const { scratchDir } = require("./helpers");

/**
 * Everything an account can address by id has to be checked against its owner.
 */
describe("Ownership", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-ownership"));

    let alice;
    let bob;
    let aliceMonitor;
    let bobMonitor;
    let aliceTag;
    let bobTag;

    before(async () => {
        await testDB.create();

        const insert = async (table, row) => {
            const inserted = await R.knex(table).insert(row);
            return Array.isArray(inserted) ? inserted[0] : inserted;
        };

        alice = await insert("user", { username: "alice",
            password: "x",
            active: 1,
            is_admin: true });
        bob = await insert("user", { username: "bob",
            password: "x",
            active: 1 });

        aliceMonitor = await insert("monitor", { name: "alice-http",
            type: "http",
            user_id: alice });
        bobMonitor = await insert("monitor", { name: "bob-http",
            type: "http",
            user_id: bob });

        aliceTag = await insert("tag", { name: "alice-tag",
            color: "#fff",
            user_id: alice });
        bobTag = await insert("tag", { name: "bob-tag",
            color: "#000",
            user_id: bob });

        await insert("status_page", { slug: "alice-page",
            title: "Alice",
            icon: "/icon.svg",
            theme: "light",
            user_id: alice });
        await insert("status_page", { slug: "bob-page",
            title: "Bob",
            icon: "/icon.svg",
            theme: "light",
            user_id: bob });
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("an account reaches its own monitor", async () => {
        const bean = await own.requireOwnedMonitor(aliceMonitor, alice);
        assert.strictEqual(bean.name, "alice-http");
    });

    test("an account cannot reach somebody else's monitor", async () => {
        await assert.rejects(() => own.requireOwnedMonitor(bobMonitor, alice), /Not found/);
        await assert.rejects(() => own.requireOwnedMonitor(aliceMonitor, bob), /Not found/);
    });

    test("somebody else's object is indistinguishable from one that does not exist", async () => {
        let missing;
        let theirs;
        await own.requireOwnedMonitor(999999, alice).catch((e) => {
            missing = e.message;
        });
        await own.requireOwnedMonitor(bobMonitor, alice).catch((e) => {
            theirs = e.message;
        });
        assert.strictEqual(missing, theirs);
    });

    test("an account cannot reach somebody else's tag", async () => {
        assert.ok(await own.requireOwnedTag(aliceTag, alice));
        await assert.rejects(() => own.requireOwnedTag(bobTag, alice), /Not found/);
    });

    test("an account cannot reach somebody else's status page", async () => {
        const bean = await own.requireOwnedStatusPage("alice-page", alice);
        assert.strictEqual(bean.title, "Alice");
        await assert.rejects(() => own.requireOwnedStatusPage("bob-page", alice), /Not found/);
    });

    test("a slug that does not exist reads the same as one that is not yours", async () => {
        let missing;
        let theirs;
        await own.requireOwnedStatusPage("no-such-page", alice).catch((e) => {
            missing = e.message;
        });
        await own.requireOwnedStatusPage("bob-page", alice).catch((e) => {
            theirs = e.message;
        });
        assert.strictEqual(missing, theirs);
    });

    test("findOwned answers null rather than throwing", async () => {
        assert.ok(await own.findOwned("monitor", aliceMonitor, alice));
        assert.strictEqual(await own.findOwned("monitor", bobMonitor, alice), null);
        assert.strictEqual(await own.findOwned("monitor", null, alice), null);
        assert.strictEqual(await own.findOwned("monitor", aliceMonitor, undefined), null);
    });

    test("a batch passes only when every one of them is yours", async () => {
        await own.requireAllOwned("monitor", [ aliceMonitor ], alice);
        await assert.rejects(() => own.requireAllOwned("monitor", [ aliceMonitor, bobMonitor ], alice), /Not found/);
        await assert.rejects(() => own.requireAllOwned("monitor", [ bobMonitor ], alice), /Not found/);
    });

    test("an empty batch is not a failure", async () => {
        // Saving a monitor with no notifications attached must not be refused.
        await own.requireAllOwned("monitor", [], alice);
        await own.requireAllOwned("monitor", null, alice);
        await own.requireAllOwned("monitor", [ null, undefined ], alice);
    });

    test("a repeated id in a batch is not mistaken for a missing one", async () => {
        // Two ids, one row: a naive length comparison would reject this.
        await own.requireAllOwned("monitor", [ aliceMonitor, aliceMonitor ], alice);
    });

    test("an unowned row belongs to nobody, not to everybody", async () => {
        const inserted = await R.knex("tag").insert({ name: "orphan",
            color: "#123456" });
        const orphan = Array.isArray(inserted) ? inserted[0] : inserted;

        await assert.rejects(() => own.requireOwnedTag(orphan, alice), /Not found/);
        await assert.rejects(() => own.requireOwnedTag(orphan, bob), /Not found/);
    });
});
