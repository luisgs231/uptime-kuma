const { describe, test } = require("node:test");
const assert = require("node:assert");
const { shouldNotifyStatusChange } = require("../../../server/dmarc/notify");

/**
 * Decision inputs with sensible defaults.
 * @param {object} o Overrides
 * @returns {object} Input for shouldNotifyStatusChange
 */
function input(o = {}) {
    return {
        isFirstBeat: false,
        previousStatus: "spoofing",
        status: "mail-loss",
        kumaWillNotify: false,
        enabled: true,
        isAmber: false,
        isSilent: false,
        ...o,
    };
}

describe("DMARC status change notification", () => {
    test("notifies when one problem status becomes another", () => {
        assert.strictEqual(shouldNotifyStatusChange(input()), true);
    });

    test("stays quiet when the status has not changed", () => {
        assert.strictEqual(
            shouldNotifyStatusChange(input({ previousStatus: "spoofing",
                status: "spoofing" })), false);
    });

    test("does not duplicate a notification Kuma is already sending", () => {
        assert.strictEqual(shouldNotifyStatusChange(input({ kumaWillNotify: true })), false);
        assert.strictEqual(
            shouldNotifyStatusChange(input({ previousStatus: "mail-loss",
                status: "ok",
                kumaWillNotify: true })), false);
    });

    test("is silent on the very first beat", () => {
        assert.strictEqual(
            shouldNotifyStatusChange(input({ isFirstBeat: true,
                previousStatus: null })), false);
    });

    test("treats a monitor with no recorded DMARC status as a baseline", () => {
        assert.strictEqual(shouldNotifyStatusChange(input({ previousStatus: null })), false);
        assert.strictEqual(shouldNotifyStatusChange(input({ previousStatus: "" })), false);
    });

    test("can be switched off between two red statuses", () => {
        assert.strictEqual(shouldNotifyStatusChange(input({ enabled: false })), false);
    });

    test("an amber beat notifies even with it switched off", () => {
        // Kuma never notifies on amber, so nothing else would ever send this.
        assert.strictEqual(
            shouldNotifyStatusChange(input({ enabled: false,
                isAmber: true })), true);
    });

    test("an amber beat is still silent when nothing changed", () => {
        assert.strictEqual(
            shouldNotifyStatusChange(input({ isAmber: true,
                previousStatus: "degraded",
                status: "degraded" })), false);
    });

    test("an amber beat is still silent on the first beat", () => {
        assert.strictEqual(
            shouldNotifyStatusChange(input({ isAmber: true,
                isFirstBeat: true })), false);
    });

    test("a mailbox that cannot be read is not the domain's problem", () => {
        assert.strictEqual(
            shouldNotifyStatusChange(input({ previousStatus: "ok",
                status: "ingest-error",
                isAmber: true,
                isSilent: true })), false);
    });

    test("coming back from one is not news either", () => {
        assert.strictEqual(
            shouldNotifyStatusChange(input({ previousStatus: "ingest-error",
                status: "ok",
                isSilent: true })), false);
    });

    test("a real problem found after one still notifies", () => {
        assert.strictEqual(
            shouldNotifyStatusChange(input({ previousStatus: "ingest-error",
                status: "mail-loss" })), true);
    });

    test("notifies on recovery that Kuma would miss", () => {
        assert.strictEqual(
            shouldNotifyStatusChange(input({ previousStatus: "degraded",
                status: "ok" })), true);
    });
});
