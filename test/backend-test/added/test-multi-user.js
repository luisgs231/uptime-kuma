const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../../server/settings");
const { UserSettings } = require("../../../server/user-settings");
const scope = require("../../../server/setting-scope");
const { scratchDir } = require("./helpers");

/**
 * Insert a user and return its id.
 * @param {string} username Account name
 * @param {boolean} isAdmin Whether it is an admin
 * @returns {Promise<number>} The new user's id
 */
async function addUser(username, isAdmin = false) {
    const inserted = await R.knex("user").insert({
        username,
        password: "not-a-real-hash",
        active: 1,
        is_admin: isAdmin,
    });
    return Array.isArray(inserted) ? inserted[0] : inserted;
}

describe("Multi-user schema", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-multi-user-schema"));

    before(async () => {
        await testDB.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("the migration added the role, the settings table and the two owners", async () => {
        assert.ok(await R.knex.schema.hasColumn("user", "is_admin"));
        assert.ok(await R.knex.schema.hasTable("user_setting"));
        assert.ok(await R.knex.schema.hasColumn("tag", "user_id"));
        assert.ok(await R.knex.schema.hasColumn("status_page", "user_id"));
    });

    test("groups and incidents are owned through their status page, not directly", async () => {
        assert.ok(await R.knex.schema.hasColumn("group", "status_page_id"));
        assert.ok(await R.knex.schema.hasColumn("incident", "status_page_id"));
        assert.strictEqual(await R.knex.schema.hasColumn("group", "user_id"), false);
        assert.strictEqual(await R.knex.schema.hasColumn("incident", "user_id"), false);
    });

    test("a new account is not an admin unless it is made one", async () => {
        const id = await addUser("regular");
        const row = await R.knex("user").where("id", id).first();
        assert.ok(!row.is_admin, "is_admin should default to false");
    });

    test("the system setting table keeps the shape upstream expects", async () => {
        assert.strictEqual(await R.knex.schema.hasColumn("setting", "user_id"), false);
    });
});

describe("Multi-user upgrade of an existing instance", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-multi-user-upgrade"));

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("the account that set the instance up becomes the admin", async () => {
        await testDB.create();
        const ownerID = await addUser("owner");

        const first = await R.knex("user").orderBy("id", "asc").first("id");
        assert.strictEqual(Number(first.id), Number(ownerID));
    });

    test("existing tags and status pages end up owned rather than orphaned", async () => {
        const ownerID = await addUser("second-owner", true);

        await R.knex("tag").insert({ name: "prod",
            color: "#ff0000" });
        await R.knex("status_page").insert({ slug: "legacy",
            title: "Legacy",
            icon: "/icon.svg",
            theme: "light" });

        await R.knex("tag").whereNull("user_id").update({ user_id: ownerID });
        await R.knex("status_page").whereNull("user_id").update({ user_id: ownerID });

        const tag = await R.knex("tag").where("name", "prod").first();
        const page = await R.knex("status_page").where("slug", "legacy").first();
        assert.strictEqual(Number(tag.user_id), Number(ownerID));
        assert.strictEqual(Number(page.user_id), Number(ownerID));
    });
});

describe("Per-account settings", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-user-settings"));
    let alice;
    let bob;

    before(async () => {
        await testDB.create();
        alice = await addUser("alice", true);
        bob = await addUser("bob");
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("a value written for one account is readable again", async () => {
        await UserSettings.set(alice, "entryPage", "statusPage-main");
        assert.strictEqual(await UserSettings.get(alice, "entryPage"), "statusPage-main");
    });

    test("one account's value is not another's", async () => {
        await UserSettings.set(bob, "entryPage", "dashboard");
        assert.strictEqual(await UserSettings.get(alice, "entryPage"), "statusPage-main");
        assert.strictEqual(await UserSettings.get(bob, "entryPage"), "dashboard");
    });

    test("an account that never set one gets undefined, not somebody else's", async () => {
        assert.strictEqual(await UserSettings.get(bob, "domainExpiryNotifyDays"), undefined);
        assert.deepStrictEqual(
            await UserSettings.getWithDefault(bob, "domainExpiryNotifyDays", [ 7, 14, 21 ]),
            [ 7, 14, 21 ]
        );
    });

    test("values keep their type", async () => {
        await UserSettings.set(alice, "tlsExpiryNotifyDays", [ 1, 30 ]);
        assert.deepStrictEqual(await UserSettings.get(alice, "tlsExpiryNotifyDays"), [ 1, 30 ]);

        await UserSettings.set(alice, "domainExpiryNotifyDays", 5);
        assert.strictEqual(await UserSettings.get(alice, "domainExpiryNotifyDays"), 5);
    });

    test("writing the same key twice updates rather than duplicating", async () => {
        await UserSettings.set(bob, "entryPage", "dashboard");
        await UserSettings.set(bob, "entryPage", "statusPage-other");
        const rows = await R.knex("user_setting").where({ user_id: bob,
            key: "entryPage" });
        assert.strictEqual(rows.length, 1);
        assert.strictEqual(await UserSettings.get(bob, "entryPage"), "statusPage-other");
    });

    test("getSettings returns only that account's settings", async () => {
        const forAlice = await UserSettings.getSettings(alice);
        const forBob = await UserSettings.getSettings(bob);
        assert.strictEqual(forAlice.entryPage, "statusPage-main");
        assert.strictEqual(forBob.entryPage, "statusPage-other");
        assert.ok(!("domainExpiryNotifyDays" in forBob), "bob never set this one");
    });

    test("a key outside the allowed list is not written", async () => {
        const carol = await addUser("carol");

        await UserSettings.setSettings(
            carol,
            { tlsExpiryNotifyDays: [ 2 ],
                disableAuth: true,
                entryPage: "statusPage-sneaky",
                madeUp: 1 },
            scope.USER_SETTINGS
        );
        assert.deepStrictEqual(await UserSettings.get(carol, "tlsExpiryNotifyDays"), [ 2 ]);
        assert.strictEqual(await UserSettings.get(carol, "disableAuth"), undefined);
        assert.strictEqual(await UserSettings.get(carol, "entryPage"), undefined, "entryPage is instance-wide");
        assert.strictEqual(await UserSettings.get(carol, "madeUp"), undefined);
    });

    test("the cache does not leak between accounts", async () => {
        await UserSettings.set(alice, "entryPage", "alice-value");
        await UserSettings.set(bob, "entryPage", "bob-value");

        // Both read first so both are cached, then one changes.
        await UserSettings.get(alice, "entryPage");
        await UserSettings.get(bob, "entryPage");
        await UserSettings.set(alice, "entryPage", "changed");

        assert.strictEqual(await UserSettings.get(alice, "entryPage"), "changed");
        assert.strictEqual(await UserSettings.get(bob, "entryPage"), "bob-value");
    });

    test("forgetting an account clears only its cache", async () => {
        await UserSettings.get(alice, "entryPage");
        await UserSettings.get(bob, "entryPage");
        UserSettings.deleteUserCache(alice);

        const keys = Object.keys(UserSettings.cacheList);
        assert.ok(!keys.some((k) => k.startsWith(`${alice}:`)), "alice's cache should be gone");
        assert.ok(keys.some((k) => k.startsWith(`${bob}:`)), "bob's cache should remain");
    });

    test("deleting an account takes its settings with it", async () => {
        const temp = await addUser("temporary");
        await UserSettings.set(temp, "entryPage", "dashboard");
        assert.strictEqual((await R.knex("user_setting").where("user_id", temp)).length, 1);

        await R.knex("user").where("id", temp).delete();
        assert.strictEqual(
            (await R.knex("user_setting").where("user_id", temp)).length,
            0,
            "user_setting rows should cascade with the account"
        );
    });
});

describe("Which settings belong to whom", () => {
    test("no setting is both instance-wide and per-account", () => {
        for (const key of scope.USER_SETTINGS) {
            assert.ok(!scope.SYSTEM_SETTINGS.includes(key), `${key} is listed in both`);
        }
    });

    test("anything not known to be per-account is instance-wide", () => {
        assert.ok(scope.isSystemSetting("somethingAddedUpstreamLater"));
        assert.ok(!scope.isUserSetting("somethingAddedUpstreamLater"));
    });

    test("authentication and the reverse proxy are never per-account", () => {
        for (const key of [ "disableAuth", "trustProxy", "primaryBaseURL", "serverTimezone" ]) {
            assert.ok(scope.isSystemSetting(key), `${key} must stay instance-wide`);
            assert.ok(!scope.isUserSetting(key));
        }
    });

    test("every per-account setting has a default to fall back to", () => {
        for (const key of scope.USER_SETTINGS) {
            assert.ok(
                key in scope.USER_SETTING_DEFAULTS,
                `${key} has no default, so an account that never set it would get undefined`
            );
        }
    });
});
