const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const express = require("express");
const { R } = require("redbean-node");
const TestDB = require("../mock-testdb");
const { scratchDir } = require("./helpers");
const { Settings } = require("../../server/settings");
const { UserSettings } = require("../../server/user-settings");
const passwordHash = require("../../server/password-hash");
const { apiKeyOwner, requestOwner } = require("../../server/auth");
const { Prometheus } = require("../../server/prometheus");

/**
 * An API key reads the monitors of the account that created it, and nothing else.
 */

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

/**
 * Create an API key for an account and return the usable string.
 * @param {number} userID Owning account
 * @param {object} opts active and expires overrides
 * @returns {Promise<string>} The `uk<id>_<secret>` key
 */
async function makeKey(userID, opts = {}) {
    const secret = `secret-${userID}-${Math.random().toString(36).slice(2)}`;
    const id = await insert("api_key", {
        key: await passwordHash.generate(secret),
        name: `k${userID}`,
        user_id: userID,
        active: opts.active ?? 1,
        expires: opts.expires ?? null,
    });
    const formatted = `uk${id}_${secret}`;
    await R.knex("api_key").where("id", id).update({ key_plain: formatted });
    return formatted;
}

describe("API keys are scoped to the account that made them", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-api-key-scope"));
    let server;
    let port;
    let alice;
    let bob;
    let aliceMonitor;
    let aliceOther;
    let bobMonitor;
    let aliceKey;
    let bobKey;

    /**
     * Call the API with basic auth carrying the key as the password.
     * @param {string} path Path with query string
     * @param {(string|null)} key API key, or null for no credentials
     * @returns {Promise<{status: number, json: any}>} The response
     */
    async function get(path, key) {
        const headers = {};
        if (key) {
            headers.Authorization = "Basic " + Buffer.from(`x:${key}`).toString("base64");
        }
        const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
        let json = null;
        try {
            json = JSON.parse(await res.text());
        } catch (e) {
            // some responses are not json
        }
        return { status: res.status,
            json };
    }

    before(async () => {
        await testDB.create();
        await Settings.set("apiKeysEnabled", true);

        alice = await insert("user", { username: "alice",
            password: "x" });
        bob = await insert("user", { username: "bob",
            password: "x" });

        aliceMonitor = await insert("monitor", { name: "alice-web",
            type: "http",
            user_id: alice,
            active: 1 });
        aliceOther = await insert("monitor", { name: "alice-db",
            type: "http",
            user_id: alice,
            active: 1 });
        bobMonitor = await insert("monitor", { name: "bob-web",
            type: "http",
            user_id: bob,
            active: 1 });

        // Six beats a minute apart across a day boundary, alternating important.
        for (const monitorID of [ aliceMonitor, aliceOther, bobMonitor ]) {
            for (let i = 0; i < 6; i++) {
                const day = i < 3 ? "01" : "02";
                await insert("heartbeat", { monitor_id: monitorID,
                    status: i % 2 === 0 ? 0 : 1,
                    msg: `failure ${i} on internal.host`,
                    time: `2026-03-${day} 00:0${i}:00.500`,
                    important: i % 2 === 0 ? 1 : 0 });
            }
        }

        aliceKey = await makeKey(alice);
        bobKey = await makeKey(bob);

        const app = express();
        app.use(require("../../server/routers/api-router"));
        server = app.listen(0);
        port = server.address().port;
    });

    after(async () => {
        server?.close();
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    describe("resolving a key to its owner", () => {
        test("a valid key resolves to the account that made it", async () => {
            assert.strictEqual(await apiKeyOwner({ auth: { password: aliceKey } }), alice);
            assert.strictEqual(await apiKeyOwner({ auth: { password: bobKey } }), bob);
        });

        test("rubbish resolves to nobody", async () => {
            for (const bad of [ undefined, null, "", "nonsense", "uk1_wrong", "uk999_x" ]) {
                assert.strictEqual(await apiKeyOwner({ auth: { password: bad } }), null, `${bad} must not resolve`);
            }
        });

        test("a disabled key resolves to nobody", async () => {
            const key = await makeKey(alice, { active: 0 });
            assert.strictEqual(await apiKeyOwner({ auth: { password: key } }), null);
        });

        test("an expired key resolves to nobody", async () => {
            const key = await makeKey(alice, { expires: "2020-01-01 00:00:00" });
            assert.strictEqual(await apiKeyOwner({ auth: { password: key } }), null);
        });

        test("the username fallback still identifies an account", async () => {
            // apiAuth accepts a username and password when no keys exist; the
            // credentials are already checked by then, so only the id is needed.
            assert.strictEqual(await requestOwner({ auth: { user: "bob" } }), bob);
            assert.strictEqual(await requestOwner({ auth: { user: "nobody" } }), null);
        });
    });

    describe("the heartbeat history endpoint", () => {
        test("it refuses a request with no credentials", async () => {
            const res = await get("/api/monitors/heartbeats", null);
            assert.strictEqual(res.status, 401);
        });

        test("it refuses a key that is not valid", async () => {
            const res = await get("/api/monitors/heartbeats", "uk1_definitely-wrong");
            assert.strictEqual(res.status, 401);
        });

        test("it returns the key owner's monitors and nobody else's", async () => {
            const res = await get("/api/monitors/heartbeats", aliceKey);
            assert.strictEqual(res.status, 200);

            const ids = Object.keys(res.json.heartbeatList).map(Number).sort((a, b) => a - b);
            assert.deepStrictEqual(ids, [ aliceMonitor, aliceOther ].sort((a, b) => a - b));
            assert.ok(!ids.includes(bobMonitor), "another account's monitor must never appear");

            const names = res.json.monitors.map((m) => m.name).sort();
            assert.deepStrictEqual(names, [ "alice-db", "alice-web" ]);
        });

        test("bob's key sees only bob's monitor", async () => {
            const res = await get("/api/monitors/heartbeats", bobKey);
            assert.deepStrictEqual(Object.keys(res.json.heartbeatList).map(Number), [ bobMonitor ]);
        });

        test("the failure messages are there - the point of the endpoint", async () => {
            const res = await get("/api/monitors/heartbeats", aliceKey);
            const beats = res.json.heartbeatList[aliceMonitor];
            assert.ok(beats.every((b) => typeof b.msg === "string"));
            assert.ok(beats.some((b) => b.msg.includes("internal.host")));
        });

        test("limit caps the beats per monitor", async () => {
            const res = await get("/api/monitors/heartbeats?limit=2", aliceKey);
            assert.strictEqual(res.json.heartbeatList[aliceMonitor].length, 2);
        });

        test("an absurd limit is clamped, not rejected", async () => {
            const res = await get("/api/monitors/heartbeats?limit=999999", aliceKey);
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json.heartbeatList[aliceMonitor].length, 6);
        });

        test("a limit that is not a number is refused", async () => {
            const res = await get("/api/monitors/heartbeats?limit=lots", aliceKey);
            assert.strictEqual(res.status, 400);
        });

        test("since keeps only what is at or after the instant", async () => {
            const res = await get("/api/monitors/heartbeats?since=2026-03-02T00:00:00Z", aliceKey);
            const beats = res.json.heartbeatList[aliceMonitor];
            assert.strictEqual(beats.length, 3, "the second day only");
            assert.ok(beats.every((b) => String(b.time).includes("2026-03-02")));
        });

        test("the same instant with a UTC offset gives the same answer", async () => {
            const zulu = await get("/api/monitors/heartbeats?since=2026-03-02T00:00:00Z", aliceKey);
            // 05:00 at +05:00 is midnight UTC - the same instant, and on the
            // far side of a date boundary if the offset were dropped.
            const offset = await get("/api/monitors/heartbeats?since=2026-03-02T05:00:00%2B05:00", aliceKey);
            assert.deepStrictEqual(offset.json, zulu.json);
        });

        test("a since that is not a date is refused rather than ignored", async () => {
            const res = await get("/api/monitors/heartbeats?since=whenever", aliceKey);
            assert.strictEqual(res.status, 400, "an ignored bound would make the agent miss rows silently");
        });

        test("a key stored without its plaintext still works", async () => {
            // The default, and what every key issued before this existed looks
            // like. Only display depends on key_plain; authentication is still
            // the hash, so such a key works exactly as it always did.
            const secret = "legacy-secret";
            const id = await insert("api_key", { key: await passwordHash.generate(secret),
                name: "legacy-auth",
                user_id: bob,
                active: 1,
                expires: null });
            const legacyKey = `uk${id}_${secret}`;

            const stored = await R.knex("api_key").where("id", id).first();
            assert.strictEqual(stored.key_plain, null, "nothing was backfilled for it");

            const res = await get("/api/monitors/heartbeats", legacyKey);
            assert.strictEqual(res.status, 200, "an old key must keep working alongside the new ones");
            assert.deepStrictEqual(Object.keys(res.json.heartbeatList).map(Number), [ bobMonitor ]);
        });

        test("important keeps only the status changes", async () => {
            const res = await get("/api/monitors/heartbeats?important=true", aliceKey);
            const beats = res.json.heartbeatList[aliceMonitor];
            assert.strictEqual(beats.length, 3);
            assert.ok(beats.every((b) => b.important === true));
        });
    });

    describe("metrics are scoped the same way", () => {
        before(async () => {
            // The gauges are built here rather than at require time, so without
            // this the registry is empty and every assertion below would pass
            // against nothing.
            await Prometheus.init();
        });

        test("only the account's own monitors are rendered", async () => {
            // Feed one gauge per monitor through the shared registry.
            for (const [ id, name ] of [
                [ aliceMonitor, "alice-web" ],
                [ aliceOther, "alice-db" ],
                [ bobMonitor, "bob-web" ],
            ]) {
                new Prometheus({ id,
                    name,
                    type: "http",
                    url: null,
                    hostname: null,
                    port: null }, []).update({ status: 1,
                    ping: 12 }, undefined, null);
            }

            const { body } = await Prometheus.renderForMonitors([ aliceMonitor, aliceOther ]);
            assert.ok(body.includes("alice-web"), "the account's own monitor is present");
            assert.ok(body.includes("alice-db"));
            assert.ok(!body.includes("bob-web"), "another account's monitor must never be rendered");
        });

        test("everything that is not about monitors is left alone", async () => {
            // Stand in for the node default metrics and the http_* histograms:
            // instance-level series that no account owns and that /metrics has
            // always carried.
            const PrometheusClient = require("prom-client");
            if (!PrometheusClient.register.getSingleMetric("instance_level_thing")) {
                new PrometheusClient.Gauge({ name: "instance_level_thing",
                    help: "not about any monitor" }).set(1);
            }

            const { body } = await Prometheus.renderForMonitors([ aliceMonitor ]);
            assert.ok(body.includes("instance_level_thing 1"), "instance metrics must survive the filter");
            assert.ok(body.includes("alice-web"));
            assert.ok(!body.includes("bob-web"));
        });

        test("an account with no monitors loses the monitor series but keeps the rest", async () => {
            const { body } = await Prometheus.renderForMonitors([]);
            assert.ok(body.includes("instance_level_thing 1"), "still not somebody's private data");
            for (const line of body.split("\n")) {
                if (line === "" || line.startsWith("#")) {
                    continue;
                }
                assert.ok(!line.startsWith("monitor_"), `no monitor series should survive: ${line}`);
            }
        });
    });

    describe("the key can be read back", () => {
        test("its owner is shown the key itself", async () => {
            const bean = await R.findOne("api_key", " user_id = ? ORDER BY id ", [bob]);
            const json = bean.toPublicJSON();
            assert.strictEqual(json.plainKey, bobKey);
            assert.strictEqual(json.userID, bob);
        });

        test("a key stored without its plaintext reports as unrecoverable", async () => {
            const id = await insert("api_key", { key: await passwordHash.generate("old"),
                name: "legacy",
                user_id: alice,
                active: 1,
                expires: null });
            const bean = await R.findOne("api_key", " id = ? ", [id]);
            assert.strictEqual(bean.toPublicJSON().plainKey, null);
        });

        test("the hash itself is still never published", async () => {
            const bean = await R.findOne("api_key", " user_id = ? ORDER BY id ", [bob]);
            assert.ok(!Object.keys(bean.toPublicJSON()).includes("key"), "the hash must not be published");
        });
    });
});

describe("The API key and status page migrations", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-api-key-migration"));

    before(async () => {
        await testDB.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("api_key.key_plain reverses and reapplies cleanly", async () => {
        const migration = require("../../db/knex_migrations/2026-09-13-0002-add-api-key-plaintext");

        assert.ok(await R.knex.schema.hasColumn("api_key", "key_plain"));
        await migration.down(R.knex);
        assert.ok(!(await R.knex.schema.hasColumn("api_key", "key_plain")));
        await migration.up(R.knex);
        await migration.up(R.knex);
        assert.ok(await R.knex.schema.hasColumn("api_key", "key_plain"));
    });

    test("the status page history columns are gone again", async () => {
        assert.ok(!(await R.knex.schema.hasColumn("status_page", "api_history_enabled")));
        assert.ok(!(await R.knex.schema.hasColumn("status_page", "api_history_max")));
    });

    test("the drop migration reverses, putting them back", async () => {
        const migration = require("../../db/knex_migrations/2026-09-13-0001-drop-status-page-history-api");

        await migration.down(R.knex);
        assert.ok(await R.knex.schema.hasColumn("status_page", "api_history_enabled"));
        await migration.up(R.knex);
        await migration.up(R.knex);
        assert.ok(!(await R.knex.schema.hasColumn("status_page", "api_history_enabled")));
    });
});
