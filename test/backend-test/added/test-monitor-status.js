const { describe, test } = require("node:test");
const assert = require("node:assert");

const { UP, DOWN, PENDING, MAINTENANCE } = require("../../../src/util");
const {
    DMARC_STATUS_META,
    CARP_STATUS_META,
    MONITOR_STATUS_META,
    UNKNOWN_STATUS_META,
    hasStatusVocabulary,
    getStatusMeta,
    splitStatusMessage,
    stripStatusPrefix,
    statusFromMessage,
    heartbeatStatusMeta,
    formatStatusPrefix,
} = require("../../../src/monitor-status");

const dmarcStatus = require("../../../server/dmarc/status");
const carpStatus = require("../../../server/carp/status");
const { DmarcMonitorType } = require("../../../server/monitor-types/dmarc");
const { CarpMonitorType, parseConfig: parseCarpConfig } = require("../../../server/monitor-types/carp");
const Monitor = require("../../../server/model/monitor");

const KNOWN_COLORS = [ "primary", "warning", "danger", "secondary", "maintenance" ];

describe("Status vocabulary", () => {
    test("the DMARC statuses the server can report all have a label", () => {
        for (const status of dmarcStatus.SEVERITY) {
            assert.ok(DMARC_STATUS_META[status], `${status} has no entry`);
        }
    });

    test("no label is left behind for a status the server no longer reports", () => {
        for (const status of Object.keys(DMARC_STATUS_META)) {
            assert.ok(dmarcStatus.SEVERITY.includes(status), `${status} is not a server status`);
        }
    });

    test("the CARP verdicts all have a label", () => {
        for (const display of carpStatus.DISPLAY_STATUSES) {
            assert.ok(CARP_STATUS_META[display], `${display} has no entry`);
        }
        assert.strictEqual(Object.keys(CARP_STATUS_META).length, carpStatus.DISPLAY_STATUSES.length);
    });

    test("every status has a usable colour and a description", () => {
        for (const type of Object.keys(MONITOR_STATUS_META)) {
            for (const [ status, meta ] of Object.entries(MONITOR_STATUS_META[type])) {
                assert.ok(KNOWN_COLORS.includes(meta.color), `${type}/${status} has colour ${meta.color}`);
                assert.ok(meta.label, `${type}/${status} has no label`);
                assert.ok(meta.description, `${type}/${status} has no description`);
            }
        }
    });

    test("the server's own labels come from here", () => {
        for (const [ status, meta ] of Object.entries(DMARC_STATUS_META)) {
            assert.strictEqual(dmarcStatus.LABELS[status], meta.label);
            assert.strictEqual(dmarcStatus.DESCRIPTIONS[status], meta.description);
        }
        for (const [ display, meta ] of Object.entries(CARP_STATUS_META)) {
            assert.strictEqual(carpStatus.DISPLAY_LABELS[display], meta.label);
        }
    });

    test("only the types that report their own statuses have a vocabulary", () => {
        assert.ok(hasStatusVocabulary("dmarc"));
        assert.ok(hasStatusVocabulary("carp"));
        assert.ok(!hasStatusVocabulary("http"));
        assert.ok(!hasStatusVocabulary("rbl"));
        assert.ok(!hasStatusVocabulary(null));
        assert.ok(!hasStatusVocabulary(undefined));
    });

    test("a status this build does not know still renders something", () => {
        assert.strictEqual(getStatusMeta("dmarc", "invented-later"), UNKNOWN_STATUS_META);
        assert.strictEqual(getStatusMeta("http", "anything"), null);
        assert.strictEqual(getStatusMeta("dmarc", null), null);
    });
});

describe("Status prefixes", () => {
    test("splits a message into its status and its body", () => {
        assert.deepStrictEqual(splitStatusMessage("[Mail loss] 12 rejected"), {
            label: "Mail loss",
            body: "12 rejected",
        });
    });

    test("a message with no prefix keeps all of itself", () => {
        assert.deepStrictEqual(splitStatusMessage("200 - OK"), { label: null,
            body: "200 - OK" });
        assert.strictEqual(stripStatusPrefix("200 - OK"), "200 - OK");
        assert.strictEqual(stripStatusPrefix(null), "");
        assert.strictEqual(stripStatusPrefix(undefined), "");
    });

    test("a bracketed message that is not a status is left alone", () => {
        // An HTTP monitor's message can begin with a bracket of its own.
        assert.strictEqual(statusFromMessage("dmarc", "[503] service unavailable"), null);
        assert.strictEqual(statusFromMessage("carp", "[not a verdict] x"), null);
    });

    test("every DMARC status survives being written and read back", () => {
        for (const status of dmarcStatus.SEVERITY) {
            const msg = `${formatStatusPrefix("dmarc", status)}details here`;
            assert.strictEqual(statusFromMessage("dmarc", msg), status, `${status} should round-trip`);
            assert.strictEqual(stripStatusPrefix(msg), "details here");
        }
    });

    test("every CARP verdict survives being written and read back", () => {
        for (const display of carpStatus.DISPLAY_STATUSES) {
            const msg = `${formatStatusPrefix("carp", display)}details here`;
            assert.strictEqual(statusFromMessage("carp", msg), display, `${display} should round-trip`);
        }
    });

    test("a type with no vocabulary never claims a status", () => {
        assert.strictEqual(statusFromMessage("http", "[Mail loss] x"), null);
    });
});

describe("Reading a status off a heartbeat", () => {
    test("the DMARC monitor's own column is preferred", () => {
        const meta = heartbeatStatusMeta("dmarc", { dmarcStatus: "spoofing",
            msg: "[Spoofing] a new source" });
        assert.strictEqual(meta.label, "Spoofing");
        assert.strictEqual(meta.color, "danger");
    });

    test("a heartbeat written before the column existed still reads", () => {
        const meta = heartbeatStatusMeta("dmarc", { msg: "[Mail loss] 12 rejected" });
        assert.strictEqual(meta.label, "Mail loss");
    });

    test("the CARP verdict is read out of the message", () => {
        assert.strictEqual(heartbeatStatusMeta("carp", { msg: "[BACKUP] moved" }).label, "BACKUP");
        assert.strictEqual(heartbeatStatusMeta("carp", { msg: "[MASTER] fine" }).color, "primary");
    });

    test("a heartbeat from before this monitor had a vocabulary falls back", () => {
        assert.strictEqual(heartbeatStatusMeta("carp", { msg: "vhid 1 is MASTER" }), null);
        assert.strictEqual(heartbeatStatusMeta("dmarc", { msg: "all fine" }), null);
    });

    test("stock monitor types are untouched", () => {
        assert.strictEqual(heartbeatStatusMeta("http", { msg: "200 - OK" }), null);
        assert.strictEqual(heartbeatStatusMeta("rbl", { msg: "No listings" }), null);
        assert.strictEqual(heartbeatStatusMeta("dmarc", null), null);
    });
});

describe("What the monitors write", () => {
    test("the DMARC monitor writes a status the dashboard can read back", () => {
        const type = new DmarcMonitorType();
        for (const status of dmarcStatus.SEVERITY) {
            const heartbeat = {};
            type.applyStatus(heartbeat, status, "some detail", {});
            assert.strictEqual(heartbeat.dmarc_status, status);
            assert.strictEqual(
                heartbeatStatusMeta("dmarc", { dmarcStatus: heartbeat.dmarc_status,
                    msg: heartbeat.msg }).label,
                DMARC_STATUS_META[status].label
            );
            assert.strictEqual(stripStatusPrefix(heartbeat.msg), "some detail");
        }
    });

    test("the CARP monitor writes a verdict the dashboard can read back", () => {
        const type = new CarpMonitorType();
        const config = parseCarpConfig("{}");
        for (const status of carpStatus.STATUSES) {
            const heartbeat = {};
            type.applyStatus(heartbeat, status, "some detail", config);
            const expected = CARP_STATUS_META[carpStatus.toDisplayStatus(status)].label;
            assert.strictEqual(heartbeatStatusMeta("carp", heartbeat).label, expected, `${status} should be readable`);
        }
    });
});

describe("Notification text", () => {
    test("a DMARC alert names the problem instead of saying down", () => {
        const text = Monitor.notificationText(
            { type: "dmarc" },
            { status: DOWN,
                msg: "[Mail loss] 12 messages rejected",
                dmarc_status: "mail-loss" }
        );
        assert.strictEqual(text.status, "🔴 Mail loss");
        assert.strictEqual(text.body, "12 messages rejected");
    });

    test("a CARP failover names the verdict", () => {
        const text = Monitor.notificationText({ type: "carp" }, { status: PENDING,
            msg: "[BACKUP] held by 10.0.0.2" });
        assert.strictEqual(text.status, "🟡 BACKUP");
        assert.strictEqual(text.body, "held by 10.0.0.2");
    });

    test("the icon comes from the verdict, not from the status underneath it", () => {
        // An amber verdict has to arrive amber whatever Kuma's own status says.
        const text = Monitor.notificationText({ type: "carp" }, { status: DOWN,
            msg: "[BACKUP] held by 10.0.0.2" });
        assert.strictEqual(text.status, "🟡 BACKUP");
    });

    test("every status the two monitors can report produces a status line", () => {
        const ICON = { primary: "✅",
            success: "✅",
            warning: "🟡",
            danger: "🔴",
            secondary: "⚪" };

        for (const status of dmarcStatus.SEVERITY) {
            const msg = `${formatStatusPrefix("dmarc", status)}detail`;
            const text = Monitor.notificationText({ type: "dmarc" }, { status: DOWN,
                msg });
            assert.strictEqual(text.status, `${ICON[DMARC_STATUS_META[status].color]} ${DMARC_STATUS_META[status].label}`);
        }
        for (const display of carpStatus.DISPLAY_STATUSES) {
            const msg = `${formatStatusPrefix("carp", display)}detail`;
            const text = Monitor.notificationText({ type: "carp" }, { status: UP,
                msg });
            assert.strictEqual(text.status, `${ICON[CARP_STATUS_META[display].color]} ${CARP_STATUS_META[display].label}`);
        }
    });

    test("a maintenance beat gets its own icon", () => {
        const text = Monitor.notificationText({ type: "carp" }, { status: MAINTENANCE,
            msg: "[MASTER] fine" });
        assert.strictEqual(text.status, "🔧 MASTER");
    });

    test("stock monitor types keep the wording they always had", () => {
        assert.deepStrictEqual(Monitor.notificationText({ type: "http" }, { status: UP,
            msg: "200 - OK" }), {
            status: "✅ Up",
            body: "200 - OK",
        });
        assert.deepStrictEqual(Monitor.notificationText({ type: "http" }, { status: DOWN,
            msg: "timeout" }), {
            status: "🔴 Down",
            body: "timeout",
        });
        // Including one whose message happens to start with a bracket.
        assert.deepStrictEqual(Monitor.notificationText({ type: "port" }, { status: DOWN,
            msg: "[503] refused" }), {
            status: "🔴 Down",
            body: "[503] refused",
        });
    });

    test("a heartbeat from before the vocabulary existed still reads as up or down", () => {
        const text = Monitor.notificationText({ type: "carp" }, { status: DOWN,
            msg: "vhid 1 is BACKUP" });
        assert.strictEqual(text.status, "🔴 Down");
        assert.strictEqual(text.body, "vhid 1 is BACKUP");
    });
});

describe("CARP amber verdicts stay amber", () => {
    test("a failover is amber, because the pair is still carrying traffic", () => {
        const heartbeat = {};
        new CarpMonitorType().applyStatus(heartbeat, carpStatus.FAILED_OVER, "moved", parseCarpConfig("{}"));
        assert.strictEqual(heartbeat.status, PENDING);
    });

    test("a pair with nothing left to fail over to is amber too", () => {
        const heartbeat = {};
        new CarpMonitorType().applyStatus(heartbeat, carpStatus.NO_BACKUP, "alone", parseCarpConfig("{}"));
        assert.strictEqual(heartbeat.status, PENDING);
    });

    test("a stored notifyOn from an older config changes nothing", () => {
        const config = parseCarpConfig(JSON.stringify({ notifyOn: [ "split-brain" ] }));
        const heartbeat = {};
        new CarpMonitorType().applyStatus(heartbeat, carpStatus.FAILED_OVER, "moved", config);
        assert.strictEqual(heartbeat.status, PENDING);
    });

    test("the master holding the address is still the only verdict that is up", () => {
        const heartbeat = {};
        new CarpMonitorType().applyStatus(heartbeat, carpStatus.OK, "held", parseCarpConfig("{}"));
        assert.strictEqual(heartbeat.status, UP);
    });
});
