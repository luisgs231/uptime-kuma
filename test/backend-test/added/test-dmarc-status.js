const { describe, test } = require("node:test");
const assert = require("node:assert");
const { UP, DOWN, PENDING } = require("../../../src/util");
const s = require("../../../server/dmarc/status");

describe("DMARC status derivation", () => {
    test("no reports at all is no-data, not ok", () => {
        assert.strictEqual(s.deriveStatus([], false), s.NO_DATA);
        // ...even if there is somehow an alert, having no data comes first.
        assert.strictEqual(s.deriveStatus([{ rule: "stale" }], false), s.NO_DATA);
    });

    test("no alerts with data is ok", () => {
        assert.strictEqual(s.deriveStatus([], true), s.OK);
    });

    test("maps each rule to its status", () => {
        assert.strictEqual(s.deriveStatus([{ rule: "fail-rate" }], true), s.DEGRADED);
        assert.strictEqual(s.deriveStatus([{ rule: "stale" }], true), s.STALE);
        assert.strictEqual(s.deriveStatus([{ rule: "new-source" }], true), s.SPOOFING);
        assert.strictEqual(s.deriveStatus([{ rule: "rejected" }], true), s.MAIL_LOSS);
        assert.strictEqual(s.deriveStatus([{ rule: "quarantined" }], true), s.MAIL_LOSS);
    });

    test("reports the worst status when several rules trip", () => {
        const alerts = [{ rule: "fail-rate" }, { rule: "new-source" }, { rule: "stale" }];
        assert.strictEqual(s.deriveStatus(alerts, true), s.SPOOFING);

        alerts.push({ rule: "rejected" });
        assert.strictEqual(s.deriveStatus(alerts, true), s.MAIL_LOSS);
    });

    test("ignores rules it does not recognise", () => {
        assert.strictEqual(s.deriveStatus([{ rule: "something-new" }], true), s.OK);
    });
});

describe("DMARC status to heartbeat status", () => {
    test("ok is always UP", () => {
        assert.strictEqual(s.toHeartbeatStatus(s.OK), UP);
    });

    test("a failure of the domain is red, a degradation is amber", () => {
        for (const status of [ s.MAIL_LOSS, s.SPOOFING, s.CERT_PROBLEM ]) {
            assert.strictEqual(s.toHeartbeatStatus(status), DOWN, `${status} should be red`);
        }
        for (const status of [ s.TLS_FAILURE, s.STALE, s.DEGRADED, s.NO_DATA ]) {
            assert.strictEqual(s.toHeartbeatStatus(status), PENDING, `${status} should be amber`);
        }
    });

    test("an unreadable mailbox is amber and says nothing", () => {
        // The mail server has a monitor of its own; this one is about reports.
        assert.strictEqual(s.toHeartbeatStatus(s.INGEST_ERROR), PENDING);
        assert.strictEqual(s.isSilent(s.INGEST_ERROR), true);
        for (const status of s.SEVERITY.filter((x) => x !== s.INGEST_ERROR)) {
            assert.strictEqual(s.isSilent(status), false, `${status} should still notify`);
        }
    });

    test("every status has a label and a description", () => {
        for (const status of s.SEVERITY) {
            assert.ok(s.LABELS[status], `missing label for ${status}`);
            assert.ok(s.DESCRIPTIONS[status], `missing description for ${status}`);
        }
    });
});
