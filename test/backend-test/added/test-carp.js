const { describe, test } = require("node:test");
const assert = require("node:assert");
const { UP, DOWN, PENDING } = require("../../../src/util");
const s = require("../../../server/carp/status");
const { parseConfig, redactConfig, describeError } = require("../../../server/monitor-types/carp");

/**
 * A VIP row shaped the way OPNsense reports one.
 * @param {object} overrides Fields to change
 * @returns {object} Raw VIP row
 */
function row(overrides = {}) {
    return {
        interface: "vtnet0",
        vhid: "1",
        advbase: "1",
        advskew: "0",
        mode: "carp",
        status: "MASTER",
        subnet: "192.168.1.1",
        subnet_bits: "24",
        ...overrides,
    };
}


describe("CARP VIP status parsing", () => {
    test("reads the paginated wrapper the API usually returns", () => {
        const vips = s.parseVipStatus({ total: 1,
            rowCount: 1,
            current: 1,
            rows: [ row() ] });
        assert.deepStrictEqual(vips, [
            { interface: "vtnet0",
                vhid: 1,
                mode: "carp",
                status: "master",
                address: "192.168.1.1" },
        ]);
    });

    test("reads a bare array just the same", () => {
        const wrapped = s.parseVipStatus({ rows: [ row(), row({ vhid: "2",
            status: "BACKUP" }) ] });
        const bare = s.parseVipStatus([ row(), row({ vhid: "2",
            status: "BACKUP" }) ]);
        assert.deepStrictEqual(bare, wrapped);
        assert.strictEqual(bare.length, 2);
        assert.strictEqual(bare[1].status, "backup");
    });

    test("a missing or renamed field does not throw", () => {
        const vips = s.parseVipStatus({
            rows: [
                // Only the alternative spellings.
                { if: "vtnet1",
                    vhid: "7",
                    status_txt: "BACKUP",
                    ip: "10.0.0.1" },
                // Nothing recognisable at all.
                {},
                // Fields present but empty.
                { interface: "",
                    vhid: "",
                    mode: "",
                    status: "",
                    address: "" },
            ],
        });
        assert.strictEqual(vips.length, 3);
        assert.deepStrictEqual(vips[0], {
            interface: "vtnet1",
            vhid: 7,
            mode: null,
            status: "backup",
            address: "10.0.0.1",
        });
        assert.deepStrictEqual(vips[1], {
            interface: null,
            vhid: null,
            mode: null,
            status: "unknown",
            address: null,
        });
        assert.strictEqual(vips[2].vhid, null);
        assert.strictEqual(vips[2].status, "unknown");
    });

    test("a payload that is not a VIP list at all yields no VIPs", () => {
        for (const payload of [ null, undefined, "", "<html>login</html>", 42, { status: "failed" }, { rows: "nope" }]) {
            assert.deepStrictEqual(s.parseVipStatus(payload), [], `payload: ${JSON.stringify(payload)}`);
        }
        assert.deepStrictEqual(s.parseVipStatus([ null, "x", 3 ]), []);
    });

    test("reads decorated vhid and status values", () => {
        const vips = s.parseVipStatus([
            { interface: "vtnet0",
                vhid_txt: "3 (freq. 1/0)",
                status: "MASTER (link up)",
                subnet: "192.168.1.3" },
        ]);
        assert.strictEqual(vips[0].vhid, 3);
        assert.strictEqual(vips[0].status, "master");
    });

    test("an unrecognised role is unknown rather than a guess", () => {
        assert.strictEqual(s.parseVipStatus([ row({ status: "n/a" }) ])[0].status, "unknown");
        assert.strictEqual(s.parseVipStatus([ row({ status: null }) ])[0].status, "unknown");
    });
});

describe("Selecting a VIP", () => {
    const vips = s.parseVipStatus([
        row({ interface: "vtnet0",
            vhid: "1",
            subnet: "192.168.1.1" }),
        row({ interface: "vtnet1",
            vhid: "2",
            subnet: "10.0.0.1",
            status: "BACKUP" }),
    ]);

    test("by vhid", () => {
        assert.strictEqual(s.findVip(vips, { vhid: 2 }).interface, "vtnet1");
        // The stored config may hold it as a string.
        assert.strictEqual(s.findVip(vips, { vhid: "2" }).interface, "vtnet1");
    });

    test("by address", () => {
        assert.strictEqual(s.findVip(vips, { address: "10.0.0.1" }).vhid, 2);
    });

    test("by interface", () => {
        assert.strictEqual(s.findVip(vips, { interface: "vtnet0" }).vhid, 1);
    });

    test("a miss returns null", () => {
        assert.strictEqual(s.findVip(vips, { vhid: 99 }), null);
        assert.strictEqual(s.findVip(vips, { address: "172.16.0.1" }), null);
        assert.strictEqual(s.findVip(vips, { interface: "igb9" }), null);
        assert.strictEqual(s.findVip([], { vhid: 1 }), null);
        assert.strictEqual(s.findVip(null, { vhid: 1 }), null);
    });

    test("an empty selector matches nothing rather than guessing", () => {
        assert.strictEqual(s.findVip(vips, {}), null);
        assert.strictEqual(s.findVip(vips, null), null);
    });

    test("fields given together must all match", () => {
        assert.strictEqual(s.findVip(vips, { vhid: 1,
            interface: "vtnet0" }).address, "192.168.1.1");
        assert.strictEqual(s.findVip(vips, { vhid: 1,
            interface: "vtnet1" }), null);
    });
});

describe("Evaluating CARP state", () => {
    test("silent failover: the pair has flipped to the backup and nothing else would notice", () => {
        const vips = s.parseVipStatus({ rows: [ row({ status: "BACKUP" }) ] });
        const result = s.evaluate({ vips,
            selector: { vhid: 1 },
            expectedRole: "master" });

        assert.strictEqual(result.status, s.FAILED_OVER);
        assert.match(result.message, /vhid 1 on vtnet0/);
        assert.match(result.message, /is BACKUP/);
        assert.match(result.message, /expected MASTER/);
    });

    test("the backup node having taken the VIP is a failover too", () => {
        const vips = s.parseVipStatus([ row({ status: "MASTER" }) ]);
        const result = s.evaluate({ vips,
            selector: { vhid: 1 },
            expectedRole: "backup" });
        assert.strictEqual(result.status, s.FAILED_OVER);
        assert.match(result.message, /is MASTER, expected BACKUP/);
    });

    test("the expected role being held is ok", () => {
        const vips = s.parseVipStatus([ row() ]);
        const result = s.evaluate({ vips,
            selector: { vhid: 1 },
            expectedRole: "master" });
        assert.strictEqual(result.status, s.OK);
        assert.match(result.message, /is MASTER, as expected/);
    });

    test("without an expected role the role is reported but not judged", () => {
        const vips = s.parseVipStatus([ row({ status: "BACKUP" }) ]);
        for (const expectedRole of [ null, "", undefined, "either" ]) {
            const result = s.evaluate({ vips,
                selector: { vhid: 1 },
                expectedRole });
            assert.strictEqual(result.status, s.OK, `expectedRole: ${expectedRole}`);
            assert.match(result.message, /is BACKUP$/);
        }
    });

    test("split brain: the same vhid is MASTER in two places at once", () => {
        const vips = s.parseVipStatus({
            rows: [ row({ interface: "vtnet0" }), row({ interface: "vtnet1" }) ],
        });
        const result = s.evaluate({ vips,
            selector: { vhid: 1,
                interface: "vtnet0" },
            expectedRole: "master" });

        assert.strictEqual(result.status, s.SPLIT_BRAIN);
        assert.match(result.message, /vhid 1 is MASTER in 2 places/);
        assert.match(result.message, /vtnet0 and vtnet1/);
    });

    test("split brain on the watched vhid wins over one elsewhere", () => {
        const vips = s.parseVipStatus([
            row({ interface: "vtnet0",
                vhid: "5" }),
            row({ interface: "vtnet1",
                vhid: "5" }),
            row({ interface: "vtnet2",
                vhid: "9" }),
            row({ interface: "vtnet3",
                vhid: "9" }),
        ]);
        const result = s.evaluate({ vips,
            selector: { vhid: 9,
                interface: "vtnet2" },
            expectedRole: "master" });
        assert.strictEqual(result.status, s.SPLIT_BRAIN);
        assert.match(result.message, /vhid 9 is MASTER/);
    });

    test("a VIP still in INIT is reported as init, not as a failover", () => {
        const vips = s.parseVipStatus([ row({ status: "INIT" }) ]);
        const result = s.evaluate({ vips,
            selector: { vhid: 1 },
            expectedRole: "master" });

        assert.strictEqual(result.status, s.INIT);
        assert.match(result.message, /is INIT/);
        assert.match(result.message, /interface is down or CARP has not settled/);
    });

    test("a VIP with no CARP role at all is init, not silently ok", () => {
        const vips = s.parseVipStatus([ row({ status: "n/a" }) ]);
        const result = s.evaluate({ vips,
            selector: { vhid: 1 },
            expectedRole: null });
        assert.strictEqual(result.status, s.INIT);
        assert.match(result.message, /did not report a CARP role/);
    });

    test("another CARP VIP being in INIT is reported as well", () => {
        const vips = s.parseVipStatus([ row(), row({ vhid: "2",
            interface: "vtnet1",
            status: "INIT" }) ]);
        const result = s.evaluate({ vips,
            selector: { vhid: 1 },
            expectedRole: "master" });
        assert.strictEqual(result.status, s.INIT);
        assert.match(result.message, /vhid 1 on vtnet0 .* is MASTER, but vhid 2 on vtnet1/);
    });

    test("an ipalias without a CARP role does not trip the init sweep", () => {
        const vips = s.parseVipStatus([
            row(),
            { interface: "vtnet1",
                vhid: "",
                mode: "ipalias",
                status: "",
                subnet: "10.0.0.9" },
        ]);
        const result = s.evaluate({ vips,
            selector: { vhid: 1 },
            expectedRole: "master" });
        assert.strictEqual(result.status, s.OK);
    });

    test("vip-missing names what was looked for and what was there", () => {
        const vips = s.parseVipStatus([ row({ vhid: "2",
            subnet: "10.0.0.1" }) ]);
        const result = s.evaluate({ vips,
            selector: { vhid: 1 },
            expectedRole: "master" });

        assert.strictEqual(result.status, s.VIP_MISSING);
        assert.match(result.message, /No VIP matches vhid 1/);
        assert.match(result.message, /vhid 2 on vtnet0 \(10\.0\.0\.1\)/);
    });

    test("vip-missing when the firewall reports no VIPs at all", () => {
        const result = s.evaluate({ vips: [],
            selector: { address: "192.168.1.1" },
            expectedRole: "master" });
        assert.strictEqual(result.status, s.VIP_MISSING);
        assert.match(result.message, /no VIPs at all/);
        assert.match(result.message, /address 192\.168\.1\.1/);
    });

    test("vip-missing when nothing has been selected", () => {
        const result = s.evaluate({ vips: s.parseVipStatus([ row() ]),
            selector: {},
            expectedRole: "master" });
        assert.strictEqual(result.status, s.VIP_MISSING);
        assert.match(result.message, /No VIP is selected/);
    });

    test("garbage in does not throw", () => {
        for (const vips of [ null, undefined, "rows", 3 ]) {
            const result = s.evaluate({ vips,
                selector: { vhid: 1 },
                expectedRole: "master" });
            assert.strictEqual(result.status, s.VIP_MISSING);
        }
    });
});

describe("CARP status to heartbeat status", () => {
    test("ok is always UP", () => {
        assert.strictEqual(s.toHeartbeatStatus(s.OK), UP);
    });

    test("a status that is not a failure of the pair stays amber", () => {
        for (const status of [ s.FAILED_OVER, s.UNKNOWN_HOLDER, s.INIT, s.NO_BACKUP ]) {
            assert.strictEqual(s.toHeartbeatStatus(status), PENDING, `${status} should be amber`);
        }
        for (const status of [ s.SPLIT_BRAIN, s.NO_MASTER, s.VIP_DOWN, s.UNREACHABLE, s.VIP_MISSING ]) {
            assert.strictEqual(s.toHeartbeatStatus(status), DOWN, `${status} should be red`);
        }
    });

    test("the verdict is which node holds the address", () => {
        assert.strictEqual(s.toDisplayStatus(s.OK), "MASTER");
        assert.strictEqual(s.toDisplayStatus(s.FAILED_OVER), "BACKUP");

        // Amber covers "something else holds it" and "cannot be confirmed".
        for (const status of [ s.UNKNOWN_HOLDER, s.INIT ]) {
            assert.strictEqual(s.toDisplayStatus(status), "BACKUP", `${status} should be BACKUP`);
        }

        // Red is nothing holding it, unreachable, or two nodes claiming it.
        for (const status of [ s.VIP_DOWN, s.NO_MASTER, s.SPLIT_BRAIN, s.UNREACHABLE, s.VIP_MISSING ]) {
            assert.strictEqual(s.toDisplayStatus(status), "DOWN", `${status} should be DOWN`);
        }
    });

    test("MASTER is green, the two in between amber, DOWN red", () => {
        assert.strictEqual(s.displayToHeartbeatStatus("MASTER"), UP);
        assert.strictEqual(s.displayToHeartbeatStatus("MASTER ONLY"), PENDING);
        assert.strictEqual(s.displayToHeartbeatStatus("BACKUP"), PENDING);
        assert.strictEqual(s.displayToHeartbeatStatus("DOWN"), DOWN);
    });

    test("every status has a label and a description", () => {
        for (const status of s.STATUSES) {
            assert.ok(s.LABELS[status], `no label for ${status}`);
            assert.ok(s.DESCRIPTIONS[status], `no description for ${status}`);
        }
    });
});

describe("CARP monitor config", () => {
    test("survives a missing, empty or corrupt config", () => {
        for (const raw of [ null, undefined, "", "   ", "{not json", "[]", "42" ]) {
            const config = parseConfig(raw);
            assert.strictEqual(config.floatingIp, "");
            assert.deepStrictEqual(config.backupIps, []);
            assert.strictEqual(config.scheme, "https");
            assert.strictEqual(Number(config.port), 443);
        }
    });

    test("reads a JSON string and an object alike", () => {
        const expected = { floatingIp: "192.168.1.1",
            masterIp: "192.168.1.2",
            backupIps: [ "192.168.1.3" ] };
        for (const raw of [ JSON.stringify(expected), expected ]) {
            const config = parseConfig(raw);
            assert.strictEqual(config.floatingIp, "192.168.1.1");
            assert.strictEqual(config.masterIp, "192.168.1.2");
            assert.deepStrictEqual(config.backupIps, [ "192.168.1.3" ]);
        }
    });

    test("the API secret is redacted", () => {
        const config = { apiKey: "key",
            apiSecret: "secret" };
        assert.strictEqual(redactConfig(config).apiSecret, "");
        assert.strictEqual(redactConfig(config).apiKey, "key");
    });
});

describe("Describing request failures", () => {
    test("a certificate mismatch points at the setting that fixes it", () => {
        const e = new Error("Hostname/IP does not match certificate's altnames: IP: 10.0.0.4 is not in the cert's list:");
        e.code = "ERR_TLS_CERT_ALTNAME_INVALID";
        assert.match(describeError(e), /Ignore TLS errors/);
        assert.doesNotMatch(describeError(e), /altnames/);
    });

    test("self-signed certificates get the same answer", () => {
        const e = new Error("self signed certificate");
        e.code = "DEPTH_ZERO_SELF_SIGNED_CERT";
        assert.match(describeError(e), /Ignore TLS errors/);
    });

    test("connection failures read plainly", () => {
        const cases = [
            [ "ECONNREFUSED", /connection refused/ ],
            [ "ETIMEDOUT", /no response/ ],
            [ "ENOTFOUND", /not resolvable/ ],
            [ "EHOSTUNREACH", /unreachable/ ],
        ];
        for (const [ code, expected ] of cases) {
            const e = new Error("some long node message");
            e.code = code;
            assert.match(describeError(e), expected, `${code} should read plainly`);
        }
    });

    test("an unrecognised error keeps its own message", () => {
        assert.strictEqual(describeError(new Error("something else entirely")), "something else entirely");
    });
});

describe("Judging the pair by reachability alone", () => {
    const base = { floatingIp: "192.168.1.1",
        floatingIpUp: true,
        masterIp: "192.168.1.2" };

    /**
     * A node as the ping path sees it - no role, only whether it answered.
     * @param {string} ip Node address
     * @param {boolean} reachable Whether it answered
     * @returns {object} Node observation
     */
    function node(ip, reachable) {
        return { ip,
            reachable,
            role: null,
            error: "" };
    }

    test("the floating address not answering is still red", () => {
        const r = s.evaluatePing({ ...base,
            floatingIpUp: false,
            nodes: [ node("192.168.1.2", true) ] });
        assert.strictEqual(r.status, s.VIP_DOWN);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), DOWN);
    });

    test("a master that stopped answering cannot be holding the address", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ node("192.168.1.2", false), node("192.168.1.3", true) ] });
        assert.strictEqual(r.status, s.FAILED_OVER);
        assert.match(r.message, /inferred from reachability/);
    });

    test("both up reports ok, and admits what it cannot see", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ node("192.168.1.2", true), node("192.168.1.3", true) ] });
        assert.strictEqual(r.status, s.OK);
        assert.match(r.message, /would not be seen/);
    });

    test("no node answering is not reported as a failover", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ node("192.168.1.2", false), node("192.168.1.3", false) ] });
        assert.strictEqual(r.status, s.UNKNOWN_HOLDER);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), PENDING);
    });

    test("with no master configured it only reports that the address is up", () => {
        const r = s.evaluatePing({ ...base,
            masterIp: "",
            nodes: [ node("192.168.1.3", true) ] });
        assert.strictEqual(r.status, s.OK);
        assert.match(r.message, /no master configured/);
    });

    test("split brain is invisible without the API", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ node("192.168.1.2", true), node("192.168.1.3", true) ] });
        assert.notStrictEqual(r.status, s.SPLIT_BRAIN);
    });
});

describe("Recovering the status from a heartbeat message", () => {
    test("reads back every verdict the monitor emits", () => {
        for (const display of s.DISPLAY_STATUSES) {
            const msg = `[${s.DISPLAY_LABELS[display]}] something happened`;
            assert.strictEqual(s.statusFromMessage(msg), display, `${display} should round-trip`);
        }
    });

    test("returns null rather than guessing when there is no label", () => {
        assert.strictEqual(s.statusFromMessage("no prefix at all"), null);
        assert.strictEqual(s.statusFromMessage(""), null);
        assert.strictEqual(s.statusFromMessage(null), null);
        assert.strictEqual(s.statusFromMessage("[Not a status] x"), null);
    });
});

describe("Matching the configured VIP address", () => {
    test("a VIP reported as a subnet still matches the bare address", () => {
        const vips = s.parseVipStatus([
            { interface: "vtnet0",
                vhid: "1",
                mode: "carp",
                status: "MASTER",
                subnet: "192.168.1.1/24" },
        ]);
        assert.ok(s.findVip(vips, { address: "192.168.1.1" }));
    });

    test("matching is case-insensitive and tolerates surrounding space", () => {
        const vips = s.parseVipStatus([
            { interface: "vtnet0",
                vhid: "2",
                mode: "carp",
                status: "BACKUP",
                subnet: "2001:DB8::1/64" },
        ]);
        assert.ok(s.findVip(vips, { address: " 2001:db8::1 " }));
    });

    test("a genuinely different address still does not match", () => {
        const vips = s.parseVipStatus([
            { interface: "vtnet0",
                vhid: "1",
                mode: "carp",
                status: "MASTER",
                subnet: "192.168.1.1/24" },
        ]);
        assert.strictEqual(s.findVip(vips, { address: "192.168.1.2" }), null);
    });
});

describe("Judging the pair from every node", () => {
    const base = { floatingIp: "192.168.1.1",
        floatingIpUp: true,
        masterIp: "192.168.1.2" };

    /**
     * A node's answer.
     * @param {string} ip Node address
     * @param {string|null} role Role it reports
     * @param {boolean} reachable Whether it answered at all
     * @returns {object} Node observation
     */
    function node(ip, role, reachable = true) {
        return { ip,
            role,
            reachable,
            error: reachable ? "" : "connection refused" };
    }

    test("the master holding the floating IP is the healthy case", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ node("192.168.1.2", "master"), node("192.168.1.3", "backup") ] });
        assert.strictEqual(r.status, s.OK);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), UP);
        assert.match(r.message, /192\.168\.1\.1 is held by the master 192\.168\.1\.2/);
    });

    test("a backup holding it is a silent failover - amber, and it says which node", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ node("192.168.1.2", "backup"), node("192.168.1.3", "master") ] });
        assert.strictEqual(r.status, s.FAILED_OVER);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), PENDING);
        assert.match(r.message, /held by 192\.168\.1\.3, not the master 192\.168\.1\.2/);
    });

    test("nobody holding it is red even though the address answers", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ node("192.168.1.2", "backup"), node("192.168.1.3", "backup") ] });
        assert.strictEqual(r.status, s.NO_MASTER);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), DOWN);
    });

    test("the floating IP not answering outranks everything else", () => {
        const r = s.evaluateCluster({ ...base,
            floatingIpUp: false,
            nodes: [ node("192.168.1.2", "master") ] });
        assert.strictEqual(r.status, s.VIP_DOWN);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), DOWN);
    });

    test("two masters is split brain, and names both nodes", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ node("192.168.1.2", "master"), node("192.168.1.3", "master") ] });
        assert.strictEqual(r.status, s.SPLIT_BRAIN);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), DOWN);
        assert.match(r.message, /192\.168\.1\.2 and 192\.168\.1\.3 both claim MASTER/);
    });

    test("no node reachable is amber, not a false failover", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ node("192.168.1.2", null, false), node("192.168.1.3", null, false) ] });
        assert.strictEqual(r.status, s.UNKNOWN_HOLDER);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), PENDING);
    });

    test("one unreachable node does not hide a healthy master", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ node("192.168.1.2", "master"), node("192.168.1.3", null, false) ] });
        assert.strictEqual(r.status, s.NO_BACKUP);
        assert.match(r.message, /held by the master 192\.168\.1\.2/);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), PENDING);
    });

    test("an initialising interface is amber rather than a missing master", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ node("192.168.1.2", "init"), node("192.168.1.3", "backup") ] });
        assert.strictEqual(r.status, s.INIT);
        assert.strictEqual(s.displayToHeartbeatStatus(s.toDisplayStatus(r.status)), PENDING);
    });

    test("with no master configured, any single holder is healthy", () => {
        const r = s.evaluateCluster({ ...base,
            masterIp: "",
            nodes: [ node("192.168.1.3", "master") ] });
        assert.strictEqual(r.status, s.OK);
    });
});

describe("A pair with nothing left to fail over to", () => {
    const base = { floatingIp: "192.168.1.1",
        floatingIpUp: true,
        masterIp: "192.168.1.2" };

    /**
     * A node as the ping path sees it.
     * @param {string} ip Node address
     * @param {boolean} reachable Whether it answered
     * @returns {object} Node observation
     */
    function ping(ip, reachable) {
        return { ip,
            reachable,
            role: null,
            error: "" };
    }

    /**
     * A node's answer on the API path.
     * @param {string} ip Node address
     * @param {string|null} role Role it reports
     * @param {boolean} reachable Whether it answered at all
     * @returns {object} Node observation
     */
    function api(ip, role, reachable = true) {
        return { ip,
            role,
            reachable,
            error: reachable ? "" : "connection refused" };
    }

    test("by reachability: the master is up and the backup is gone", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ ping("192.168.1.2", true), ping("192.168.1.3", false) ] });
        assert.strictEqual(r.status, s.NO_BACKUP);
        assert.match(r.message, /192\.168\.1\.3 is not answering/);
        assert.match(r.message, /nothing left to fail over to/);
    });

    test("by reachability: a surviving backup is the healthy case", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ ping("192.168.1.2", true), ping("192.168.1.3", true) ] });
        assert.strictEqual(r.status, s.OK);
    });

    test("by reachability: one of several backups surviving is enough", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ ping("192.168.1.2", true), ping("192.168.1.3", false), ping("192.168.1.4", true) ] });
        assert.strictEqual(r.status, s.OK);
    });

    test("by reachability: every backup gone names all of them", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ ping("192.168.1.2", true), ping("192.168.1.3", false), ping("192.168.1.4", false) ] });
        assert.strictEqual(r.status, s.NO_BACKUP);
        assert.match(r.message, /192\.168\.1\.3 and 192\.168\.1\.4 are not answering/);
    });

    test("by reachability: a single-node config has no backup to lose", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ ping("192.168.1.2", true) ] });
        assert.strictEqual(r.status, s.OK);
    });

    test("by reachability: the master being gone outranks the backup being gone", () => {
        const r = s.evaluatePing({ ...base,
            nodes: [ ping("192.168.1.2", false), ping("192.168.1.3", true) ] });
        assert.strictEqual(r.status, s.FAILED_OVER);
    });

    test("by API: the master holds it and no other node answers", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ api("192.168.1.2", "master"), api("192.168.1.3", null, false) ] });
        assert.strictEqual(r.status, s.NO_BACKUP);
        assert.match(r.message, /192\.168\.1\.3 is not answering/);
    });

    test("by API: a node answering but not standing by is not a backup", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ api("192.168.1.2", "master"), api("192.168.1.3", "init") ] });
        assert.strictEqual(r.status, s.NO_BACKUP);
        assert.match(r.message, /192\.168\.1\.3 is INIT/);
    });

    test("by API: a real standby is the healthy case", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ api("192.168.1.2", "master"), api("192.168.1.3", "backup") ] });
        assert.strictEqual(r.status, s.OK);
    });

    test("by API: a single-node config has no backup to lose", () => {
        const r = s.evaluateCluster({ ...base,
            nodes: [ api("192.168.1.2", "master") ] });
        assert.strictEqual(r.status, s.OK);
    });

    test("the verdict is amber, and says the master is the only node left", () => {
        assert.strictEqual(s.toDisplayStatus(s.NO_BACKUP), s.MASTER_ONLY);
        assert.strictEqual(s.MASTER_ONLY, "MASTER ONLY");
        assert.strictEqual(s.displayToHeartbeatStatus(s.MASTER_ONLY), PENDING);
    });
});
