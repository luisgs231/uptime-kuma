const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../../server/settings");

const { parseConfig } = require("../../../server/dmarc/config");
const { deployMissingDomains, coveredDomains, adoptDomain, MAX_PER_RUN } =
    require("../../../server/dmarc/autodeploy");
const { scratchDir } = require("./helpers");

/**
 * Insert a monitor row and return the bean.
 * @param {object} fields Column values
 * @returns {Promise<object>} Monitor bean
 */
async function makeMonitor(fields) {
    const inserted = await R.knex("monitor").insert(fields);
    const id = Array.isArray(inserted) ? inserted[0] : inserted;
    return R.findOne("monitor", " id = ? ", [ id ]);
}

describe("DMARC autodeploy", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-dmarc-autodeploy"));
    let userID;
    let notificationID;

    const imap = { host: "mail.example.com",
        username: "dmarc@example.com",
        password: "secret" };

    before(async () => {
        await testDB.create();
        const u = await R.knex("user").insert({ username: "tester",
            password: "x" });
        userID = Array.isArray(u) ? u[0] : u;
        const n = await R.knex("notification").insert({
            name: "ntfy",
            config: JSON.stringify({ type: "ntfy" }),
            user_id: userID,
            is_default: false,
        });
        notificationID = Array.isArray(n) ? n[0] : n;
    });

    after(async () => {
        Settings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("an unassigned monitor adopts a domain instead of spawning one", async () => {
        const monitor = await makeMonitor({
            name: "New Monitor",
            type: "dmarc",
            user_id: userID,
            interval: 3600,
            dmarc_config: JSON.stringify({ autoDeploy: true,
                imap,
                staleDays: 9 }),
        });

        const config = await adoptDomain(monitor, parseConfig(monitor.dmarc_config), "example.com");
        assert.strictEqual(config.domain, "example.com");

        const row = await R.knex("monitor").where("id", monitor.id).first();
        assert.strictEqual(parseConfig(row.dmarc_config).domain, "example.com");
        // Renamed, because this monitor is managing itself.
        assert.strictEqual(row.name, "DMARC: example.com");
        // The in-memory bean is updated too; the beat loop reuses it.
        assert.strictEqual(parseConfig(monitor.dmarc_config).domain, "example.com");

        const rel = R.dispense("monitor_notification");
        rel.monitor_id = monitor.id;
        rel.notification_id = notificationID;
        await R.store(rel);
    });

    test("a name the operator chose is left alone", async () => {
        const monitor = await makeMonitor({ name: "My mailbox",
            type: "dmarc",
            user_id: userID,
            interval: 3600,
            dmarc_config: JSON.stringify({ autoDeploy: false,
                imap }) });

        await adoptDomain(monitor, parseConfig(monitor.dmarc_config), "quiet.example.org");
        const row = await R.knex("monitor").where("id", monitor.id).first();
        assert.strictEqual(row.name, "My mailbox", "renaming only happens when autodeploy manages the monitor");
        assert.strictEqual(parseConfig(row.dmarc_config).domain, "quiet.example.org");
    });

    test("covered domains are read from every monitor's own domain", async () => {
        const covered = await coveredDomains();
        assert.ok(covered.has("example.com"));
        assert.ok(covered.has("quiet.example.org"));
    });

    test("creates a monitor for each other domain seen", async () => {
        const monitor = await R.findOne("monitor", " name = ? ", [ "DMARC: example.com" ]);
        const config = parseConfig(monitor.dmarc_config);

        const created = await deployMissingDomains(
            monitor, config, [ "shop.example.net", "mail.example.co" ], null);
        assert.deepStrictEqual(created, [ "mail.example.co", "shop.example.net" ]);

        const shop = await R.knex("monitor").where("name", "DMARC: shop.example.net").first();
        const shopConfig = parseConfig(shop.dmarc_config);
        assert.strictEqual(shopConfig.domain, "shop.example.net");
        // Same mailbox settings, so the new monitor can read it on its own.
        assert.strictEqual(shopConfig.imap.host, "mail.example.com");
        assert.strictEqual(shopConfig.imap.password, "secret");
        // Alerting settings are inherited rather than reset to defaults.
        assert.strictEqual(shopConfig.staleDays, 9);
        assert.strictEqual(Number(shop.maxretries), 0);
    });

    test("new monitors inherit the notification channels", async () => {
        // Otherwise a newly discovered domain would be monitored but silent.
        const shop = await R.knex("monitor").where("name", "DMARC: shop.example.net").first("id");
        const links = await R.knex("monitor_notification").where("monitor_id", shop.id).select();
        assert.strictEqual(links.length, 1);
        assert.strictEqual(Number(links[0].notification_id), Number(notificationID));
    });

    test("its own domain is never deployed again", async () => {
        const monitor = await R.findOne("monitor", " name = ? ", [ "DMARC: example.com" ]);
        const config = parseConfig(monitor.dmarc_config);
        assert.deepStrictEqual(await deployMissingDomains(monitor, config, [ "example.com" ], null), []);
    });

    test("is idempotent - a second run creates nothing", async () => {
        const monitor = await R.findOne("monitor", " name = ? ", [ "DMARC: example.com" ]);
        const config = parseConfig(monitor.dmarc_config);
        assert.deepStrictEqual(
            await deployMissingDomains(monitor, config, [ "shop.example.net", "mail.example.co" ], null), []);
    });

    test("picks up a domain that appears later", async () => {
        const monitor = await R.findOne("monitor", " name = ? ", [ "DMARC: example.com" ]);
        const config = parseConfig(monitor.dmarc_config);
        assert.deepStrictEqual(
            await deployMissingDomains(monitor, config, [ "new.example.org" ], null), [ "new.example.org" ]);
    });

    test("caps how many monitors one run may create", async () => {
        const monitor = await R.findOne("monitor", " name = ? ", [ "DMARC: example.com" ]);
        const config = parseConfig(monitor.dmarc_config);
        const many = Array.from({ length: MAX_PER_RUN + 5 }, (_, i) => `d${String(i).padStart(2, "0")}.bulk.example`);

        const first = await deployMissingDomains(monitor, config, many, null);
        assert.strictEqual(first.length, MAX_PER_RUN, "a misconfigured mailbox cannot create unbounded monitors");

        // The remainder is picked up next run rather than dropped.
        assert.strictEqual((await deployMissingDomains(monitor, config, many, null)).length, 5);
    });
});
