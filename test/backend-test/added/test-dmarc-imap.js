const { describe, test } = require("node:test");
const assert = require("node:assert");
const { planFetch } = require("../../../server/dmarc/imap");

const now = 1756771200;          // fixed, so the expected dates are exact
const DAY = 86400;

describe("DMARC IMAP fetch planning", () => {
    test("first run reads back by date, not the whole mailbox", () => {
        const plan = planFetch(null, { uidValidity: 111n }, 30, now);
        assert.strictEqual(plan.mode, "date");
        assert.strictEqual(plan.since.getTime(), (now - 30 * DAY) * 1000);
    });

    test("an empty state object is still a first run", () => {
        assert.strictEqual(planFetch({}, { uidValidity: 111n }, 30, now).mode, "date");
    });

    test("subsequent runs fetch only past the cursor", () => {
        const plan = planFetch({ uidValidity: "111",
            lastUid: 42 }, { uidValidity: 111n }, 30, now);
        assert.strictEqual(plan.mode, "uid");
        assert.strictEqual(plan.range, "43:*");
        assert.strictEqual(plan.lastUid, 42);
    });

    test("a changed UIDVALIDITY forces a rescan instead of skipping mail", () => {
        const plan = planFetch({ uidValidity: "111",
            lastUid: 900 }, { uidValidity: 222n }, 14, now);
        assert.strictEqual(plan.mode, "date");
        assert.strictEqual(plan.since.getTime(), (now - 14 * DAY) * 1000);
        assert.match(plan.reason, /UIDVALIDITY changed \(111 -> 222\)/);
    });

    test("UIDVALIDITY compares as a string, so a BigInt from the server still matches", () => {
        const plan = planFetch({ uidValidity: "1756000000",
            lastUid: 5 }, { uidValidity: 1756000000n }, 30, now);
        assert.strictEqual(plan.mode, "uid");
    });

    test("a cursor with no lastUid starts from the beginning of that mailbox", () => {
        const plan = planFetch({ uidValidity: "111" }, { uidValidity: 111n }, 30, now);
        assert.strictEqual(plan.range, "1:*");
        assert.strictEqual(plan.lastUid, 0);
    });
});
