const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../../server/settings");
const { UserSettings } = require("../../../server/user-settings");
const { clampKeepPeriod } = require("../../../server/setting-scope");
const { renderRobotsTxt, buildRobotsTxt } = require("../../../server/robots");
const { keepPeriodFor, clearOldData } = require("../../../server/jobs/clear-old-data");
const { scratchDir } = require("./helpers");

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

describe("Retention with an admin ceiling", () => {
    test("an account keeps what it asks for, up to the ceiling", () => {
        assert.strictEqual(clampKeepPeriod(30, 365), 30);
        assert.strictEqual(clampKeepPeriod(365, 365), 365);
        assert.strictEqual(clampKeepPeriod(3650, 365), 365);
    });

    test("no ceiling means the account decides", () => {
        assert.strictEqual(clampKeepPeriod(3650, null), 3650);
        assert.strictEqual(clampKeepPeriod(3650, 0), 3650);
        assert.strictEqual(clampKeepPeriod(3650, ""), 3650);
    });

    test("switching deletion off is not a way round the ceiling", () => {
        assert.strictEqual(clampKeepPeriod(0, 365), 365);
        assert.strictEqual(clampKeepPeriod(-1, 365), 365);

        // With no ceiling it keeps meaning what it always meant.
        assert.strictEqual(clampKeepPeriod(0, null), 0);
    });

    test("a value that is not a number falls back to the default", () => {
        assert.strictEqual(clampKeepPeriod("nonsense", null), 365);
        assert.strictEqual(clampKeepPeriod(undefined, null), 365);
    });
});

describe("Clearing old data per account", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-retention"));

    let alice;
    let bob;
    let aliceMonitor;
    let bobMonitor;

    before(async () => {
        await testDB.create();

        alice = await insert("user", { username: "alice",
            password: "x",
            active: 1,
            is_admin: true });
        bob = await insert("user", { username: "bob",
            password: "x",
            active: 1 });

        aliceMonitor = await insert("monitor", { name: "alice",
            type: "http",
            user_id: alice });
        bobMonitor = await insert("monitor", { name: "bob",
            type: "http",
            user_id: bob });

        // Two beats each: one from long ago, one from today.
        for (const monitorID of [ aliceMonitor, bobMonitor ]) {
            await insert("heartbeat", { monitor_id: monitorID,
                status: 1,
                msg: "old",
                time: "2020-01-01 00:00:00.000",
                important: 0 });
            await insert("heartbeat", { monitor_id: monitorID,
                status: 1,
                msg: "new",
                time: new Date().toISOString().replace("T", " ").replace("Z", ""),
                important: 0 });
        }
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("an account's own period is used, bounded by the ceiling", async () => {
        await UserSettings.set(alice, "keepDataPeriodDays", 30);
        assert.strictEqual(await keepPeriodFor(alice, null), 30);
        assert.strictEqual(await keepPeriodFor(alice, 7), 7, "the ceiling wins");
    });

    test("an account that has set nothing inherits the instance value", async () => {
        await Settings.set("keepDataPeriodDays", 100, "general");
        UserSettings.deleteUserCache(bob);
        assert.strictEqual(await keepPeriodFor(bob, null), 100);
    });

    test("monitors with no owner still get cleared", async () => {
        assert.strictEqual(await keepPeriodFor(null, null), 100);
    });

    test("one account's short period does not delete another's history", async () => {
        await UserSettings.set(alice, "keepDataPeriodDays", 30);
        await UserSettings.set(bob, "keepDataPeriodDays", 100000);

        await clearOldData();

        const aliceBeats = await R.knex("heartbeat").where("monitor_id", aliceMonitor).select("msg");
        const bobBeats = await R.knex("heartbeat").where("monitor_id", bobMonitor).select("msg");

        assert.deepStrictEqual(
            aliceBeats.map((b) => b.msg),
            [ "new" ],
            "alice's old beat should be gone"
        );
        assert.deepStrictEqual(
            bobBeats.map((b) => b.msg).sort(),
            [ "new", "old" ],
            "bob asked to keep his"
        );
    });

    test("the ceiling actually bites", async () => {
        await insert("heartbeat", { monitor_id: bobMonitor,
            status: 1,
            msg: "ancient",
            time: "2019-01-01 00:00:00.000",
            important: 0 });

        // Bob still wants to keep everything; the admin says 30 days.
        await Settings.set("keepDataPeriodDaysMax", 30, "general");
        await clearOldData();

        const bobBeats = await R.knex("heartbeat").where("monitor_id", bobMonitor).select("msg");
        assert.deepStrictEqual(
            bobBeats.map((b) => b.msg),
            [ "new" ],
            "the ceiling should have applied to bob"
        );
    });
});

describe("robots.txt with per-account indexing", () => {
    test("nobody indexed is the whole site disallowed", () => {
        // Exactly what stock Uptime Kuma produces for a private instance.
        assert.strictEqual(
            renderRobotsTxt({ anyIndexed: false,
                disallowedSlugs: [] }),
            "User-agent: *\nDisallow: /"
        );
    });

    test("one account indexed lifts the blanket rule", () => {
        assert.strictEqual(
            renderRobotsTxt({ anyIndexed: true,
                disallowedSlugs: [] }),
            "User-agent: *\nDisallow:"
        );
    });

    test("accounts that opted out have their pages named instead", () => {
        assert.strictEqual(
            renderRobotsTxt({ anyIndexed: true,
                disallowedSlugs: [ "private", "internal" ] }),
            "User-agent: *\nDisallow:\nDisallow: /status/private\nDisallow: /status/internal"
        );
    });
});

describe("robots.txt assembled from the database", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-robots"));

    let alice;
    let bob;

    before(async () => {
        await testDB.create();
        alice = await insert("user", { username: "alice",
            password: "x",
            active: 1,
            is_admin: true });
        bob = await insert("user", { username: "bob",
            password: "x",
            active: 1 });

        const page = (slug, userID, published) => ({
            slug,
            title: slug,
            icon: "/icon.svg",
            theme: "light",
            published,
            user_id: userID,
        });
        await insert("status_page", page("alice-public", alice, 1));
        await insert("status_page", page("bob-private", bob, 1));
        await insert("status_page", page("bob-draft", bob, 0));
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("a private instance disallows everything", async () => {
        assert.strictEqual(await buildRobotsTxt(), "User-agent: *\nDisallow: /");
    });

    test("one account opting in does not opt the others in", async () => {
        await UserSettings.set(alice, "searchEngineIndex", true);
        const txt = await buildRobotsTxt();

        assert.ok(txt.includes("Disallow: /status/bob-private"), "bob did not ask to be indexed");
        assert.ok(!txt.includes("alice-public"), "alice asked to be indexed");
        assert.ok(!txt.includes("Disallow: /\n") && !txt.endsWith("Disallow: /"), "the blanket rule must be gone");
    });

    test("an unpublished page is not named", async () => {
        // Naming it would disclose that it exists, and nothing can crawl it.
        const txt = await buildRobotsTxt();
        assert.ok(!txt.includes("bob-draft"));
    });
});
