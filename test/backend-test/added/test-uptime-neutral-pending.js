const { describe, test } = require("node:test");
const assert = require("node:assert");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
dayjs.extend(require("../../../server/modules/dayjs/plugin/timezone"));
const { UptimeCalculator } = require("../../../server/uptime-calculator");
const { UP, DOWN, PENDING } = require("../../../src/util");
const { hasStatusVocabulary } = require("../../../src/monitor-status");

/**
 * Feed a calculator a run of beats a minute apart.
 * @param {UptimeCalculator} calculator Calculator to feed
 * @param {number[]} statuses Statuses in order
 * @returns {Promise<void>} Resolves once every beat is recorded
 */
async function feed(calculator, statuses) {
    let at = dayjs.utc("2026-09-02 12:00:00");
    for (const status of statuses) {
        UptimeCalculator.currentDate = at;
        await calculator.update(status, 10);
        at = at.add(1, "minute");
    }
}

describe("Amber does not count as downtime", () => {
    test("a pending beat is neither up nor down when the type says so", async () => {
        const c = new UptimeCalculator();
        c.neutralPending = true;
        await feed(c, [ UP, PENDING, PENDING, UP ]);
        assert.strictEqual(c.get24Hour().uptime, 1, "amber must not dent the percentage");
    });

    test("a red beat still counts, so a real outage is still visible", async () => {
        const c = new UptimeCalculator();
        c.neutralPending = true;
        await feed(c, [ UP, PENDING, DOWN, UP ]);
        assert.strictEqual(c.get24Hour().uptime, 2 / 3, "two up and one down out of three counted beats");
    });

    test("nothing changes for a monitor type without statuses of its own", async () => {
        const c = new UptimeCalculator();
        await feed(c, [ UP, PENDING, PENDING, UP ]);
        assert.strictEqual(c.get24Hour().uptime, 0.5, "upstream counts pending as down");
    });

    test("the flag follows the monitor types that report their own status", () => {
        for (const type of [ "carp", "dmarc" ]) {
            assert.strictEqual(hasStatusVocabulary(type), true, `${type} should be neutral on pending`);
        }
        for (const type of [ "http", "ping", "rbl" ]) {
            assert.strictEqual(hasStatusVocabulary(type), false, `${type} should be left alone`);
        }
    });
});
