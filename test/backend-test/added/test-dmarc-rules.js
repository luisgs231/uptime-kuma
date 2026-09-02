const { describe, test } = require("node:test");
const assert = require("node:assert");
const { evaluate, summarise, withDefaults } = require("../../../server/dmarc/rules");
const { DAY } = require("./helpers");

const now = Math.floor(Date.now() / 1000);

/**
 * Assemble the inputs evaluate() expects.
 * @param {object} o Overrides
 * @returns {object} evaluate() input
 */
function input(o = {}) {
    return {
        domains: o.domains ?? [],
        sourcesByDomain: o.sourcesByDomain ?? {},
        knownDomains: o.knownDomains ?? [],
        config: o.config ?? {},
        now,
        baselined: o.baselined ?? true,
    };
}

/**
 * A source row as getSources() returns it.
 * @param {object} o Overrides
 * @returns {object} Source row
 */
function source(o) {
    return {
        sourceIp: o.ip,
        messages: o.messages ?? 0,
        passed: o.passed ?? 0,
        failed: o.failed ?? 0,
        dkimPassed: 0,
        spfPassed: 0,
        quarantined: o.quarantined ?? 0,
        rejected: o.rejected ?? 0,
        headerFrom: "example.com",
        firstSeen: o.firstSeen ?? now - 200 * DAY,
    };
}

const healthy = { domain: "example.com",
    messages: 1000,
    passed: 1000,
    failed: 0,
    reports: 5,
    lastReport: now - DAY };

describe("DMARC rules", () => {
    test("a clean domain produces no alerts", () => {
        const alerts = evaluate(input({
            domains: [ healthy ],
            knownDomains: [{ domain: "example.com",
                lastReport: now - DAY }],
        }));
        assert.deepStrictEqual(alerts, []);
    });

    test("flags a failure rate above the threshold", () => {
        const alerts = evaluate(input({
            domains: [{ ...healthy,
                messages: 1000,
                passed: 900,
                failed: 100 }],
            knownDomains: [{ domain: "example.com",
                lastReport: now - DAY }],
        }));
        assert.strictEqual(alerts.length, 1);
        assert.strictEqual(alerts[0].rule, "fail-rate");
        assert.match(alerts[0].message, /10\.0% DMARC failures \(100 of 1000 messages\)/);
    });

    test("ignores a high rate that is only a handful of messages", () => {
        // 2 of 3 is 66%, but on that volume it is noise, not a signal.
        const alerts = evaluate(input({
            domains: [{ ...healthy,
                messages: 3,
                passed: 1,
                failed: 2 }],
            knownDomains: [{ domain: "example.com",
                lastReport: now - DAY }],
        }));
        assert.deepStrictEqual(alerts, []);
    });

    test("suppresses new-source alerts until a baseline exists", () => {
        const withNewSource = {
            domains: [ healthy ],
            sourcesByDomain: {
                "example.com": [ source({ ip: "198.51.100.5",
                    messages: 40,
                    failed: 40,
                    firstSeen: now - 2 * DAY }) ],
            },
            knownDomains: [{ domain: "example.com",
                lastReport: now - DAY }],
        };

        assert.deepStrictEqual(evaluate(input({ ...withNewSource,
            baselined: false })), []);

        const after = evaluate(input({ ...withNewSource,
            baselined: true }));
        assert.strictEqual(after.length, 1);
        assert.strictEqual(after[0].rule, "new-source");
        assert.match(after[0].message, /new source 198\.51\.100\.5 failing DMARC \(40 message\(s\)\)/);
    });

    test("a long-standing source that starts failing is not a new source", () => {
        const alerts = evaluate(input({
            domains: [ healthy ],
            sourcesByDomain: {
                "example.com": [ source({ ip: "203.0.113.9",
                    messages: 10,
                    failed: 10,
                    firstSeen: now - 300 * DAY }) ],
            },
            knownDomains: [{ domain: "example.com",
                lastReport: now - DAY }],
        }));
        assert.strictEqual(alerts.filter((a) => a.rule === "new-source").length, 0);
    });

    test("collapses a flood of new sources into a summary line", () => {
        const many = [];
        for (let i = 1; i <= 9; i++) {
            many.push(source({ ip: `198.51.100.${i}`,
                messages: i,
                failed: i,
                firstSeen: now - DAY }));
        }
        const alerts = evaluate(input({
            domains: [ healthy ],
            sourcesByDomain: { "example.com": many },
            knownDomains: [{ domain: "example.com",
                lastReport: now - DAY }],
        }));
        const newSource = alerts.filter((a) => a.rule === "new-source");
        assert.strictEqual(newSource.length, 6, "five named plus one summary");
        assert.match(newSource[newSource.length - 1].message, /4 further new failing source\(s\)/);
        // Named ones are the worst offenders, not an arbitrary five.
        assert.match(newSource[0].message, /198\.51\.100\.9/);
    });

    test("flags mail receivers actually acted on", () => {
        const alerts = evaluate(input({
            domains: [ healthy ],
            sourcesByDomain: {
                "example.com": [ source({ ip: "192.0.2.1",
                    messages: 30,
                    failed: 30,
                    quarantined: 20,
                    rejected: 10 }) ],
            },
            knownDomains: [{ domain: "example.com",
                lastReport: now - DAY }],
        }));
        const rules = alerts.map((a) => a.rule);
        assert.ok(rules.includes("rejected"));
        assert.ok(rules.includes("quarantined"));
    });

    test("flags a domain that has gone quiet", () => {
        const alerts = evaluate(input({
            domains: [],
            knownDomains: [{ domain: "gone.example.com",
                lastReport: now - 20 * DAY }],
        }));
        assert.strictEqual(alerts.length, 1);
        assert.strictEqual(alerts[0].rule, "stale");
        assert.match(alerts[0].message, /no report received in 20 days/);
    });

    test("staleness can be switched off", () => {
        const alerts = evaluate(input({
            knownDomains: [{ domain: "gone.example.com",
                lastReport: now - 90 * DAY }],
            config: { staleDays: 0 },
        }));
        assert.deepStrictEqual(alerts, []);
    });

    test("orders the most severe alert first", () => {
        const alerts = evaluate(input({
            domains: [{ ...healthy,
                messages: 100,
                passed: 50,
                failed: 50 }],
            sourcesByDomain: {
                "example.com": [ source({ ip: "192.0.2.1",
                    messages: 50,
                    failed: 50,
                    rejected: 50 }) ],
            },
            knownDomains: [{ domain: "example.com",
                lastReport: now - DAY }],
        }));
        assert.strictEqual(alerts[0].rule, "rejected");
        assert.ok(alerts.some((a) => a.rule === "fail-rate"));
    });

    test("does not cap the alerts by default", () => {
        const knownDomains = [];
        for (let i = 0; i < 50; i++) {
            knownDomains.push({ domain: `d${i}.example.com`,
                lastReport: now - 30 * DAY });
        }
        assert.strictEqual(withDefaults({}).maxAlerts, 0, "0 means no limit");
        assert.strictEqual(evaluate(input({ knownDomains })).length, 50);
    });

    test("maxAlerts still truncates when set", () => {
        const knownDomains = [];
        for (let i = 0; i < 50; i++) {
            knownDomains.push({ domain: `d${i}.example.com`,
                lastReport: now - 30 * DAY });
        }
        assert.strictEqual(evaluate(input({ knownDomains,
            config: { maxAlerts: 5 } })).length, 5);
    });

    test("summarise reports health when quiet and the problem when not", () => {
        assert.match(summarise([ healthy ], [], 3), /1 domain\(s\), 1000 message\(s\), 100\.00% DMARC pass, \+3 new report\(s\)/);
        const alerts = [
            { message: "a" }, { message: "b" }, { message: "c" }, { message: "d" },
        ];
        assert.strictEqual(summarise([ healthy ], alerts, 0), "a; b; c (+1 more)");
    });
});
