const { describe, test } = require("node:test");
const assert = require("node:assert");
const { UP, DOWN, PENDING } = require("../../../src/util");
const lookup = require("../../../server/rbl/lookup");
const { RblMonitorType } = require("../../../server/monitor-types/rbl");

/**
 * Build a DNS error the way node's resolver reports one.
 * @param {string} code The libuv/c-ares error code, e.g. "ENOTFOUND"
 * @returns {Error} An error carrying that code
 */
function dnsError(code) {
    const error = new Error(`query failed: ${code}`);
    error.code = code;
    return error;
}

/**
 * A resolver that answers from a table instead of the network.
 * @param {object} a4 Query name to A records, or to an Error
 * @param {object} options Optional `txt` and `a6` tables
 * @returns {object} A resolver with resolve4, resolve6, resolveTxt and a call log
 */
function fakeResolver(a4, options = {}) {
    const calls = [];

    /**
     * Look a name up in one of the tables.
     * @param {object} table The table to consult
     * @param {string} name The query name
     * @returns {any} The stored answer
     * @throws {Error} NXDOMAIN when absent, or the stored error
     */
    const answer = (table, name) => {
        const value = (table || {})[name];
        if (value === undefined) {
            throw dnsError("ENOTFOUND");
        }
        if (value instanceof Error) {
            throw value;
        }
        return value;
    };

    return {
        calls,
        async resolve4(name) {
            calls.push(name);
            return answer(a4, name);
        },
        async resolve6(name) {
            return answer(options.a6, name);
        },
        async resolveTxt(name) {
            return answer(options.txt, name);
        },
    };
}

describe("RBL address reversal - IPv4", () => {
    test("reverses the octets", () => {
        assert.strictEqual(lookup.reverseIp("1.2.3.4"), "4.3.2.1");
        assert.strictEqual(lookup.reverseIp("203.0.113.10"), "10.113.0.203");
        assert.strictEqual(lookup.reverseIp("255.255.255.255"), "255.255.255.255");
        assert.strictEqual(lookup.reverseIp("0.0.0.0"), "0.0.0.0");
    });

    test("tolerates surrounding whitespace from a config field", () => {
        assert.strictEqual(lookup.reverseIp("  203.0.113.10\n"), "10.113.0.203");
    });
});

describe("RBL address reversal - IPv6 nibble format", () => {
    test("produces 32 single-nibble labels for the documentation address", () => {
        const reversed = lookup.reverseIp("2001:db8::1");
        assert.strictEqual(
            reversed,
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2"
        );
        assert.strictEqual(reversed.split(".").length, 32);
    });

    test("an already-expanded address gives the same answer as its short form", () => {
        assert.strictEqual(
            lookup.reverseIp("2001:0db8:0000:0000:0000:0000:0000:0001"),
            lookup.reverseIp("2001:db8::1")
        );
    });

    test("expands :: at the start", () => {
        assert.strictEqual(
            lookup.reverseIp("::1"),
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0"
        );
        assert.deepStrictEqual(lookup.expandIpv6("::1"), [
            "0000", "0000", "0000", "0000", "0000", "0000", "0000", "0001",
        ]);
    });

    test("expands :: at the end", () => {
        assert.strictEqual(
            lookup.reverseIp("2001:db8::"),
            "0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2"
        );
        assert.deepStrictEqual(lookup.expandIpv6("1::"), [
            "0001", "0000", "0000", "0000", "0000", "0000", "0000", "0000",
        ]);
    });

    test("expands :: in the middle", () => {
        assert.strictEqual(
            lookup.reverseIp("2001:db8:85a3::8a2e:370:7334"),
            "4.3.3.7.0.7.3.0.e.2.a.8.0.0.0.0.0.0.0.0.3.a.5.8.8.b.d.0.1.0.0.2"
        );
    });

    test("expands a bare :: to the all-zero address", () => {
        assert.strictEqual(lookup.reverseIp("::"), new Array(32).fill("0").join("."));
    });

    test("handles an address with no :: at all", () => {
        assert.strictEqual(
            lookup.reverseIp("1:2:3:4:5:6:7:8"),
            "8.0.0.0.7.0.0.0.6.0.0.0.5.0.0.0.4.0.0.0.3.0.0.0.2.0.0.0.1.0.0.0"
        );
    });

    test("lowercases hex digits", () => {
        assert.strictEqual(lookup.reverseIp("2001:DB8::1"), lookup.reverseIp("2001:db8::1"));
    });

    test("drops a zone index, which has no meaning in a DNS query", () => {
        assert.strictEqual(
            lookup.reverseIp("fe80::1%eth0"),
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.e.f"
        );
    });

    test("expands a trailing dotted quad into the last two groups", () => {
        // 192.0 is c000 and 2.1 is 0201, so the query name ends ...1.0.2.0.0.0.0.c
        assert.strictEqual(
            lookup.reverseIp("2001:db8::192.0.2.1"),
            "1.0.2.0.0.0.0.c.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2"
        );
    });

    test("an IPv4-mapped address is reversed as IPv4, not as 32 nibbles", () => {
        assert.strictEqual(lookup.reverseIp("::ffff:203.0.113.10"), "10.113.0.203");
        assert.strictEqual(lookup.reverseIp("::ffff:1.2.3.4"), "4.3.2.1");
    });

    test("does not mistake ::1 for the IPv4-compatible form", () => {
        assert.strictEqual(lookup.reverseIp("::1").split(".").length, 32);
    });
});

describe("RBL address reversal - malformed input", () => {
    test("throws on values that are not addresses at all", () => {
        for (const bad of [ "", "   ", "not an ip", "example.com", "1.2.3.4/24" ]) {
            assert.throws(() => lookup.reverseIp(bad), /valid IP address/, `expected ${JSON.stringify(bad)} to throw`);
        }
    });

    test("throws on values that are not strings", () => {
        for (const bad of [ null, undefined, 12345, {}, [], true ]) {
            assert.throws(() => lookup.reverseIp(bad), /Not an IP address/);
        }
    });

    test("throws on malformed IPv4", () => {
        for (const bad of [ "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.-1", "1.2.3.a" ]) {
            assert.throws(() => lookup.reverseIp(bad), Error, `expected ${JSON.stringify(bad)} to throw`);
        }
    });

    test("throws on malformed IPv6", () => {
        for (const bad of [ "1:::2", "gggg::1", "12345::1", "1:2:3:4:5:6:7:8:9", "2001:db8", ":::" ]) {
            assert.throws(() => lookup.reverseIp(bad), Error, `expected ${JSON.stringify(bad)} to throw`);
        }
    });

    test("expandIpv6 rejects a second ::", () => {
        assert.throws(() => lookup.expandIpv6("1::2::3"), /only once/);
    });

    test("expandIpv6 rejects the wrong number of groups", () => {
        assert.throws(() => lookup.expandIpv6("1:2:3"), /8 groups/);
        assert.throws(() => lookup.expandIpv6("1:2:3:4:5:6:7:8:9"), /8 groups/);
    });

    test("expandIpv6 rejects a non-hex group", () => {
        assert.throws(() => lookup.expandIpv6("1:2:3:4:5:6:7:zz"), /hex group/);
    });
});

describe("RBL response interpretation", () => {
    test("no answer is not listed and is not an error", () => {
        const result = lookup.interpretResult("zen.spamhaus.org", [], null);
        assert.strictEqual(result.listed, false);
        assert.strictEqual(result.error, null);
        assert.deepStrictEqual(result.codes, []);
        assert.strictEqual(result.zone, "zen.spamhaus.org");
    });

    test("a null answer list is treated the same as an empty one", () => {
        const result = lookup.interpretResult("zen.spamhaus.org", null, null);
        assert.strictEqual(result.listed, false);
        assert.strictEqual(result.error, null);
    });

    test("127.0.0.2 is a listing and the return code is recorded", () => {
        const result = lookup.interpretResult("zen.spamhaus.org", [ "127.0.0.2" ], null);
        assert.strictEqual(result.listed, true);
        assert.strictEqual(result.error, null);
        assert.deepStrictEqual(result.codes, [ 2 ]);
        assert.deepStrictEqual(result.addresses, [ "127.0.0.2" ]);
    });

    test("several return codes on one zone are all recorded, in order", () => {
        const result = lookup.interpretResult("zen.spamhaus.org", [ "127.0.0.4", "127.0.0.10", "127.0.0.2" ], null);
        assert.strictEqual(result.listed, true);
        assert.deepStrictEqual(result.codes, [ 2, 4, 10 ]);
        assert.strictEqual(result.addresses.length, 3);
    });

    test("duplicate return codes are folded", () => {
        const result = lookup.interpretResult("bl.spamcop.net", [ "127.0.0.2", "127.0.0.2" ], null);
        assert.deepStrictEqual(result.codes, [ 2 ]);
    });

    test("the TXT record becomes the human readable reason", () => {
        const result = lookup.interpretResult(
            "zen.spamhaus.org",
            [ "127.0.0.2" ],
            [ [ "https://check.spamhaus.org/query/ip/", "203.0.113.10" ] ]
        );
        assert.strictEqual(result.listed, true);
        assert.strictEqual(result.reason, "https://check.spamhaus.org/query/ip/203.0.113.10");
    });

    test("a plain string TXT value is accepted too", () => {
        const result = lookup.interpretResult("psbl.surriel.com", [ "127.0.0.2" ], "listed since 2026");
        assert.strictEqual(result.reason, "listed since 2026");
    });

    test("Spamhaus 127.255.255.254 is an ERROR, NOT a listing", () => {
        const result = lookup.interpretResult("zen.spamhaus.org", [ "127.255.255.254" ], null);
        assert.strictEqual(result.listed, false, "127.255.255.254 must never be reported as listed");
        assert.match(result.error, /rejected the query/);
        assert.deepStrictEqual(result.codes, []);
    });

    test("the whole 127.255.255.0/24 rejection range is an error, not a listing", () => {
        for (const code of [ "127.255.255.252", "127.255.255.253", "127.255.255.254", "127.255.255.255" ]) {
            const result = lookup.interpretResult("zen.spamhaus.org", [ code ], null);
            assert.strictEqual(result.listed, false, `${code} must not be a listing`);
            assert.ok(result.error, `${code} must be an error`);
        }
    });

    test("a rejection alongside a real listing still errors rather than reporting the listing", () => {
        const result = lookup.interpretResult("zen.spamhaus.org", [ "127.0.0.2", "127.255.255.255" ], null);
        assert.strictEqual(result.listed, false);
        assert.ok(result.error);
    });

    test("the rejection reason from TXT is carried into the error", () => {
        const result = lookup.interpretResult(
            "zen.spamhaus.org",
            [ "127.255.255.254" ],
            [ [ "Query via public resolver, see https://www.spamhaus.org/returnc/pub/" ] ]
        );
        assert.match(result.error, /public resolver/);
    });

    test("an answer outside 127.0.0.0/8 is an error, not a listing", () => {
        const result = lookup.interpretResult("bl.spamcop.net", [ "92.242.140.21" ], null);
        assert.strictEqual(result.listed, false);
        assert.match(result.error, /outside 127\.0\.0\.0\/8/);
    });

    test("a zone descriptor object contributes its display name", () => {
        const zone = { zone: "zen.spamhaus.org",
            name: "Spamhaus ZEN" };
        const result = lookup.interpretResult(zone, [ "127.0.0.2" ], null);
        assert.strictEqual(result.zone, "zen.spamhaus.org");
        assert.strictEqual(result.name, "Spamhaus ZEN");
    });
});

describe("RBL zone lookup", () => {
    test("builds the query name from the reversed address and the zone", async () => {
        const resolver = fakeResolver({});
        await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.deepStrictEqual(resolver.calls, [ "10.113.0.203.zen.spamhaus.org" ]);
    });

    test("builds a 32-label query name for an IPv6 address", async () => {
        const resolver = fakeResolver({});
        await lookup.checkZone("2001:db8::1", "zen.spamhaus.org", resolver);
        assert.strictEqual(
            resolver.calls[0],
            "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.zen.spamhaus.org"
        );
    });

    test("NXDOMAIN means not listed, not an error", async () => {
        const resolver = fakeResolver({});
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, false);
        assert.strictEqual(result.error, null, "NXDOMAIN is the ordinary answer for a clean address");
    });

    test("ENODATA also means not listed", async () => {
        const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": dnsError("ENODATA") });
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, false);
        assert.strictEqual(result.error, null);
    });

    test("a 127.0.0.2 answer is a listing with the code recorded", async () => {
        const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": [ "127.0.0.2" ] });
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, true);
        assert.deepStrictEqual(result.codes, [ 2 ]);
        assert.strictEqual(result.error, null);
    });

    test("SERVFAIL is an error, never a silent clean", async () => {
        const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": dnsError("ESERVFAIL") });
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, false);
        assert.ok(result.error, "SERVFAIL must not be reported as a clean result");
        assert.match(result.error, /SERVFAIL/);
    });

    test("a timeout is an error, never a silent clean", async () => {
        for (const code of [ "ETIMEOUT", "ETIMEDOUT" ]) {
            const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": dnsError(code) });
            const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
            assert.strictEqual(result.listed, false);
            assert.match(result.error, /timed out/, `${code} must surface as an error`);
        }
    });

    test("a refused query is an error", async () => {
        const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": dnsError("EREFUSED") });
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.ok(result.error);
    });

    test("an unrecognised DNS error still surfaces rather than passing", async () => {
        const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": dnsError("ESOMETHINGNEW") });
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, false);
        assert.ok(result.error);
    });

    test("a rejection code from the zone is an error, not a listing", async () => {
        const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": [ "127.255.255.254" ] });
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, false);
        assert.ok(result.error);
    });

    test("the TXT reason is attached to a listing", async () => {
        const query = "10.113.0.203.bl.spamcop.net";
        const resolver = fakeResolver(
            { [query]: [ "127.0.0.2" ] },
            { txt: { [query]: [ [ "Blocked - see https://www.spamcop.net/bl.shtml" ] ] } }
        );
        const result = await lookup.checkZone("203.0.113.10", "bl.spamcop.net", resolver);
        assert.strictEqual(result.listed, true);
        assert.match(result.reason, /spamcop\.net/);
    });

    test("a failing TXT lookup does not cancel the listing", async () => {
        const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": [ "127.0.0.2" ] });
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, true);
        assert.strictEqual(result.reason, null);
    });

    test("a resolver without resolveTxt is usable", async () => {
        const resolver = {
            /**
             * @returns {Promise<string[]>} A single listing answer
             */
            async resolve4() {
                return [ "127.0.0.4" ];
            },
        };
        const result = await lookup.checkZone("203.0.113.10", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, true);
        assert.deepStrictEqual(result.codes, [ 4 ]);
    });

    test("a malformed address comes back as an error rather than throwing", async () => {
        // One bad entry in a target list must not abort the whole run.
        const resolver = fakeResolver({});
        const result = await lookup.checkZone("not-an-ip", "zen.spamhaus.org", resolver);
        assert.strictEqual(result.listed, false);
        assert.match(result.error, /valid IP address/);
        assert.deepStrictEqual(resolver.calls, [], "no query should be sent for a bad address");
    });

    test("carries the zone descriptor's display name through", async () => {
        const resolver = fakeResolver({ "10.113.0.203.zen.spamhaus.org": [ "127.0.0.2" ] });
        const zone = { zone: "zen.spamhaus.org",
            name: "Spamhaus ZEN" };
        const result = await lookup.checkZone("203.0.113.10", zone, resolver);
        assert.strictEqual(result.name, "Spamhaus ZEN");
    });
});

describe("RBL non-routable addresses", () => {
    test("recognises space no public blocklist can hold", () => {
        for (const ip of [
            "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.255.255",
            "192.168.1.1", "100.64.0.1", "224.0.0.1", "255.255.255.255",
            "::", "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:10.0.0.1",
        ]) {
            assert.strictEqual(lookup.isNonRoutable(ip), true, `${ip} should be non-routable`);
        }
    });

    test("leaves public space alone, including the documentation ranges", () => {
        for (const ip of [ "8.8.8.8", "203.0.113.10", "192.0.2.1", "198.51.100.1", "172.32.0.1", "100.128.0.1", "2001:db8::1" ]) {
            assert.strictEqual(lookup.isNonRoutable(ip), false, `${ip} should be checkable`);
        }
    });

    test("a non-address is not claimed to be non-routable", () => {
        assert.strictEqual(lookup.isNonRoutable("example.com"), false);
        assert.strictEqual(lookup.isNonRoutable(null), false);
    });
});

describe("RBL default zone list", () => {
    test("the catalogue covers the well-known lists", () => {
        const zones = lookup.KNOWN_ZONES.map((z) => z.zone);
        for (const expected of [
            "zen.spamhaus.org", "bl.spamcop.net", "b.barracudacentral.org",
            "dnsbl.sorbs.net", "psbl.surriel.com", "cbl.abuseat.org",
        ]) {
            assert.ok(zones.includes(expected), `${expected} should be offered`);
        }
    });

    test("only zones that answer a general querier are enabled by default", () => {
        const zones = lookup.DEFAULT_ZONES.map((z) => z.zone);
        assert.deepStrictEqual(zones, [ "zen.spamhaus.org", "bl.spamcop.net", "psbl.surriel.com" ]);

        for (const excluded of [ "b.barracudacentral.org", "dnsbl.sorbs.net", "cbl.abuseat.org" ]) {
            assert.ok(!zones.includes(excluded), `${excluded} must not be on by default`);
        }
    });

    test("every zone that is off by default explains why", () => {
        for (const zone of lookup.KNOWN_ZONES.filter((z) => !z.recommended)) {
            assert.ok(zone.note && zone.note.length > 20,
                `${zone.zone} needs a note saying why it is not enabled`);
        }
    });

    test("every entry has a zone and a readable name", () => {
        for (const zone of lookup.KNOWN_ZONES) {
            assert.strictEqual(typeof zone.zone, "string");
            assert.ok(zone.zone.length > 0);
            assert.strictEqual(typeof zone.name, "string");
            assert.ok(zone.name.length > 0);
        }
    });
});

describe("RBL config parsing", () => {
    test("an empty config yields workable defaults", () => {
        for (const raw of [ null, undefined, "", "   ", "not json", "[1,2,3" ]) {
            const config = lookup.parseConfig(raw);
            assert.deepStrictEqual(config.targets, []);
            assert.ok(config.zones.length > 0, "a missing zone list falls back to the defaults");
            assert.strictEqual(config.resolver, null);
            assert.strictEqual(config.failOnListing, true);
            assert.strictEqual(config.maxListings, 0);
            assert.strictEqual(config.concurrency, 8);
        }
    });

    test("reads a JSON string and an object alike", () => {
        const shape = { targets: [ "203.0.113.10" ],
            resolver: "192.0.2.53",
            maxListings: 2 };
        for (const raw of [ shape, JSON.stringify(shape) ]) {
            const config = lookup.parseConfig(raw);
            assert.deepStrictEqual(config.targets, [ "203.0.113.10" ]);
            assert.strictEqual(config.resolver, "192.0.2.53");
            assert.strictEqual(config.maxListings, 2);
        }
    });

    test("accepts a free-text target list from a textarea", () => {
        const config = lookup.parseConfig({ targets: "203.0.113.10, mail.example.com\n198.51.100.4  " });
        assert.deepStrictEqual(config.targets, [ "203.0.113.10", "mail.example.com", "198.51.100.4" ]);
    });

    test("bare zone strings pick up the known display name and IPv6 flag", () => {
        const config = lookup.parseConfig({ zones: [ "zen.spamhaus.org", "bl.spamcop.net", "rbl.example.net" ] });
        assert.deepStrictEqual(config.zones[0], {
            zone: "zen.spamhaus.org",
            name: "Spamhaus ZEN",
            ipv6: true,
            note: lookup.DEFAULT_ZONES[0].note,
        });
        assert.strictEqual(config.zones[1].ipv6, false, "SpamCop is an IPv4-only list");
        assert.strictEqual(config.zones[2].ipv6, true);
        assert.strictEqual(config.zones[2].name, "rbl.example.net");
    });

    test("a blank resolver means the system resolver", () => {
        assert.strictEqual(lookup.parseConfig({ resolver: "   " }).resolver, null);
        assert.strictEqual(lookup.parseConfig({ resolver: 1234 }).resolver, null);
    });

    test("nonsense numbers fall back rather than disabling the checks", () => {
        assert.strictEqual(lookup.parseConfig({ maxListings: -5 }).maxListings, 0);
        assert.strictEqual(lookup.parseConfig({ maxListings: "abc" }).maxListings, 0);
        assert.strictEqual(lookup.parseConfig({ concurrency: 0 }).concurrency, 8);
        assert.strictEqual(lookup.parseConfig({ concurrency: -1 }).concurrency, 8);
        assert.strictEqual(lookup.parseConfig({ concurrency: 4 }).concurrency, 4);
    });

    test("failOnListing is only off when explicitly false", () => {
        assert.strictEqual(lookup.parseConfig({ failOnListing: false }).failOnListing, false);
        assert.strictEqual(lookup.parseConfig({}).failOnListing, true);
    });
});

describe("RBL bounded concurrency", () => {
    test("keeps the results in input order", async () => {
        const results = await lookup.mapLimit([ 1, 2, 3, 4, 5 ], 2, async (n) => n * 10);
        assert.deepStrictEqual(results, [ 10, 20, 30, 40, 50 ]);
    });

    test("never exceeds the limit", async () => {
        let inFlight = 0;
        let peak = 0;
        const items = new Array(40).fill(0).map((_, i) => i);

        await lookup.mapLimit(items, 8, async (n) => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setImmediate(resolve));
            inFlight -= 1;
            return n;
        });

        assert.ok(peak <= 8, `peak concurrency was ${peak}`);
        assert.ok(peak > 1, "the work should actually run in parallel");
    });

    test("handles an empty list and a silly limit", async () => {
        assert.deepStrictEqual(await lookup.mapLimit([], 8, async () => 1), []);
        assert.deepStrictEqual(await lookup.mapLimit([ 1, 2 ], 0, async (n) => n), [ 1, 2 ]);
    });
});

describe("RBL monitor type", () => {
    /**
     * Run check() with a fake resolver in place of the real one.
     * @param {object} config Monitor config, stored as JSON on the bean
     * @param {object} resolver Fake resolver to use
     * @param {object} monitorFields Extra fields on the monitor bean
     * @returns {Promise<object>} The heartbeat check() produced
     */
    async function run(config, resolver, monitorFields = {}) {
        const type = new RblMonitorType();
        type.createResolver = () => resolver;
        const heartbeat = {};
        await type.check({ rbl_config: JSON.stringify(config),
            ...monitorFields }, heartbeat, null);
        return heartbeat;
    }

    const zen = { zone: "zen.spamhaus.org",
        name: "Spamhaus ZEN" };
    const spamcop = { zone: "bl.spamcop.net",
        name: "SpamCop" };

    test("names the address, the blocklist and the return code", async () => {
        const heartbeat = await run(
            { targets: [ "203.0.113.10" ],
                zones: [ zen ] },
            fakeResolver({ "10.113.0.203.zen.spamhaus.org": [ "127.0.0.2" ] })
        );
        // A bare "down" is useless: this line is the entire value of the check.
        assert.strictEqual(heartbeat.msg, "203.0.113.10 listed on Spamhaus ZEN (127.0.0.2)");
        assert.strictEqual(heartbeat.status, DOWN);
        assert.strictEqual(typeof heartbeat.ping, "number");
    });

    test("appends the blocklist's own explanation when there is one", async () => {
        const query = "10.113.0.203.bl.spamcop.net";
        const heartbeat = await run(
            { targets: [ "203.0.113.10" ],
                zones: [ spamcop ] },
            fakeResolver({ [query]: [ "127.0.0.2" ] }, { txt: { [query]: [ [ "Blocked - see https://www.spamcop.net/" ] ] } })
        );
        assert.match(heartbeat.msg, /^203\.0\.113\.10 listed on SpamCop \(127\.0\.0\.2\) - Blocked/);
    });

    test("is UP and says what it checked when everything is clean", async () => {
        const heartbeat = await run(
            { targets: [ "203.0.113.10" ],
                zones: [ zen, spamcop ] },
            fakeResolver({})
        );
        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /No listings: 203\.0\.113\.10 checked against 2 blocklist\(s\)/);
    });

    test("reports every listing across every address and zone", async () => {
        const heartbeat = await run(
            { targets: [ "203.0.113.10", "198.51.100.4" ],
                zones: [ zen, spamcop ] },
            fakeResolver({
                "10.113.0.203.zen.spamhaus.org": [ "127.0.0.2" ],
                "4.100.51.198.bl.spamcop.net": [ "127.0.0.2" ],
            })
        );
        assert.strictEqual(heartbeat.status, DOWN);
        assert.match(heartbeat.msg, /203\.0\.113\.10 listed on Spamhaus ZEN/);
        assert.match(heartbeat.msg, /198\.51\.100\.4 listed on SpamCop/);
    });

    test("a rejected query is reported as a failed lookup, not as a listing", async () => {
        // The false positive this whole monitor has to avoid.
        const heartbeat = await run(
            { targets: [ "203.0.113.10" ],
                zones: [ zen, spamcop ] },
            fakeResolver({ "10.113.0.203.zen.spamhaus.org": [ "127.255.255.254" ] })
        );
        assert.strictEqual(heartbeat.status, PENDING, "a rejected query is neither a listing nor a pass");
        assert.doesNotMatch(heartbeat.msg, /listed on/);
        assert.match(heartbeat.msg, /incomplete/);
        assert.match(heartbeat.msg, /rejected the query/);
    });

    test("a partial resolver failure is PENDING and names the failing zone", async () => {
        const heartbeat = await run(
            { targets: [ "203.0.113.10" ],
                zones: [ zen, spamcop ] },
            fakeResolver({ "10.113.0.203.zen.spamhaus.org": dnsError("ESERVFAIL") })
        );
        assert.strictEqual(heartbeat.status, PENDING);
        assert.match(heartbeat.msg, /Spamhaus ZEN/);
        assert.match(heartbeat.msg, /SERVFAIL/);
    });

    test("every zone failing is DOWN, not a clean result", async () => {
        const heartbeat = await run(
            { targets: [ "203.0.113.10" ],
                zones: [ zen, spamcop ] },
            fakeResolver({
                "10.113.0.203.zen.spamhaus.org": dnsError("ETIMEOUT"),
                "10.113.0.203.bl.spamcop.net": dnsError("ETIMEOUT"),
            })
        );
        assert.strictEqual(heartbeat.status, DOWN);
        assert.match(heartbeat.msg, /Could not check any blocklist/);
    });

    test("a listing still wins when some other zone failed", async () => {
        const heartbeat = await run(
            { targets: [ "203.0.113.10" ],
                zones: [ zen, spamcop ] },
            fakeResolver({
                "10.113.0.203.zen.spamhaus.org": [ "127.0.0.4" ],
                "10.113.0.203.bl.spamcop.net": dnsError("ESERVFAIL"),
            })
        );
        assert.strictEqual(heartbeat.status, DOWN);
        assert.match(heartbeat.msg, /listed on Spamhaus ZEN \(127\.0\.0\.4\)/);
        assert.match(heartbeat.msg, /gave no answer/);
    });

    test("resolves a hostname target and checks every address behind it", async () => {
        const heartbeat = await run(
            { targets: [ "mail.example.com" ],
                zones: [ zen ] },
            fakeResolver(
                { "mail.example.com": [ "203.0.113.10", "198.51.100.4" ],
                    "4.100.51.198.zen.spamhaus.org": [ "127.0.0.3" ] },
                { a6: { "mail.example.com": [ "2001:db8::1" ] } }
            )
        );
        assert.strictEqual(heartbeat.status, DOWN);
        assert.match(heartbeat.msg, /198\.51\.100\.4 \(mail\.example\.com\) listed on Spamhaus ZEN \(127\.0\.0\.3\)/);
    });

    test("an unresolvable hostname is DOWN, never a pass", async () => {
        const heartbeat = await run(
            { targets: [ "mail.example.com" ],
                zones: [ zen ] },
            fakeResolver({})
        );
        assert.strictEqual(heartbeat.status, DOWN);
        assert.match(heartbeat.msg, /could not resolve mail\.example\.com/);
    });

    test("skips IPv4-only zones for an IPv6 address and says so", async () => {
        const heartbeat = await run(
            { targets: [ "2001:db8::1" ],
                zones: [ zen, spamcop ] },
            fakeResolver({})
        );
        assert.strictEqual(heartbeat.status, UP);
        assert.match(heartbeat.msg, /skipped SpamCop for IPv6 addresses/);
        assert.match(heartbeat.msg, /checked against 1 blocklist\(s\)/);
    });

    test("does not query a private address, which no blocklist can hold", async () => {
        const resolver = fakeResolver({});
        const heartbeat = await run({ targets: [ "192.168.1.10" ],
            zones: [ zen ] }, resolver);
        assert.deepStrictEqual(resolver.calls, [], "querying it would earn a rejection code, not an answer");
        assert.strictEqual(heartbeat.status, PENDING);
        assert.match(heartbeat.msg, /not publicly routable/);
    });

    test("honours maxListings as a tolerance", async () => {
        const answers = {
            "10.113.0.203.zen.spamhaus.org": [ "127.0.0.2" ],
            "10.113.0.203.bl.spamcop.net": [ "127.0.0.2" ],
        };
        const config = { targets: [ "203.0.113.10" ],
            zones: [ zen, spamcop ] };

        const tolerated = await run({ ...config,
            maxListings: 2 }, fakeResolver(answers));
        assert.strictEqual(tolerated.status, PENDING, "listings within tolerance stay visible but do not page");
        assert.match(tolerated.msg, /within the tolerance of 2/);

        const exceeded = await run({ ...config,
            maxListings: 1 }, fakeResolver(answers));
        assert.strictEqual(exceeded.status, DOWN);
    });

    test("failOnListing false reports the listing without taking the monitor down", async () => {
        const heartbeat = await run(
            { targets: [ "203.0.113.10" ],
                zones: [ zen ],
                failOnListing: false },
            fakeResolver({ "10.113.0.203.zen.spamhaus.org": [ "127.0.0.2" ] })
        );
        assert.strictEqual(heartbeat.status, PENDING);
        assert.match(heartbeat.msg, /listed on Spamhaus ZEN/);
    });

    test("falls back to the monitor's own hostname when no target is configured", async () => {
        const heartbeat = await run(
            { zones: [ zen ] },
            fakeResolver({ "10.113.0.203.zen.spamhaus.org": [ "127.0.0.2" ] }),
            { hostname: " 203.0.113.10 " }
        );
        assert.match(heartbeat.msg, /203\.0\.113\.10 listed on Spamhaus ZEN/);
    });

    test("throws when there is nothing at all to check", async () => {
        const type = new RblMonitorType();
        type.createResolver = () => fakeResolver({});
        await assert.rejects(
            () => type.check({ rbl_config: "{}" }, {}, null),
            /No addresses or hostnames configured/
        );
    });

    test("checks the same address once when two targets share it", async () => {
        const resolver = fakeResolver({ "mail.example.com": [ "203.0.113.10" ] });
        await run({ targets: [ "203.0.113.10", "mail.example.com" ],
            zones: [ zen ] }, resolver);
        const blocklistQueries = resolver.calls.filter((name) => name.endsWith(".zen.spamhaus.org"));
        assert.strictEqual(blocklistQueries.length, 1);
    });
});
