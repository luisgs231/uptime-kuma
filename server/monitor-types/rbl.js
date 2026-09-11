const { MonitorType } = require("./monitor-type");
const { UP, DOWN, PENDING, log } = require("../../src/util");
const dayjs = require("dayjs");
const net = require("node:net");
const { Resolver } = require("node:dns/promises");

/**
 * DNSBL/RBL lookups: turning an address into a query name, and a DNS answer
 * into a verdict.
 */
/**
 * Blocklists queried when a monitor doesn't name its own.
 */
const KNOWN_ZONES = [
    {
        zone: "zen.spamhaus.org",
        name: "Spamhaus ZEN",
        ipv6: true,
        recommended: true,
        note: "Free use is capped by volume and forbids public resolvers; over the line it returns a 127.255.255.x rejection rather than a listing.",
    },
    {
        zone: "bl.spamcop.net",
        name: "SpamCop",
        ipv6: false,
        recommended: true,
    },
    {
        zone: "b.barracudacentral.org",
        recommended: false,
        name: "Barracuda",
        ipv6: false,
        note: "Only answers resolvers whose IP has been registered with Barracuda; an unregistered querier gets NXDOMAIN for everything, which is indistinguishable from clean.",
    },
    {
        zone: "dnsbl.sorbs.net",
        recommended: false,
        name: "SORBS",
        ipv6: false,
        note: "Reported retired in 2024. A retired zone answers NXDOMAIN for every address, so it contributes nothing but still looks like a passing check.",
    },
    {
        zone: "psbl.surriel.com",
        name: "PSBL",
        ipv6: false,
        recommended: true,
    },
    {
        zone: "cbl.abuseat.org",
        recommended: false,
        name: "CBL",
        ipv6: false,
        note: "Reported folded into the Spamhaus XBL, which zen.spamhaus.org already covers. Querying both is largely duplicate work.",
    },
];

/**
 * The zones enabled out of the box.
 */
const DEFAULT_ZONES = KNOWN_ZONES.filter((z) => z.recommended);


/**
 * DNS error codes that mean "this name does not exist", which for a DNSBL is
 * the ordinary answer for an address that is not listed.
 */
const NOT_LISTED_CODES = new Set([ "ENOTFOUND", "ENODATA" ]);

/** Readable text for the resolver failures worth naming in a heartbeat. */
const RESOLVER_ERRORS = {
    ESERVFAIL: "the nameserver returned SERVFAIL",
    ETIMEOUT: "the query timed out",
    ETIMEDOUT: "the query timed out",
    EREFUSED: "the nameserver refused the query",
    ECONNREFUSED: "the resolver refused the connection",
    ENOTIMP: "the nameserver does not implement this query",
    EBADRESP: "the nameserver sent a malformed reply",
    ENOTFOUND_SERVER: "the resolver could not be reached",
};

const CONFIG_DEFAULTS = {
    targets: [],

    zones: DEFAULT_ZONES,

    resolver: null,

    // Whether a listing should take the monitor down at all.
    failOnListing: true,

    maxListings: 0,

    concurrency: 8,
};

/**
 * Parse the stored config, filling in anything missing.
 * @param {string|object|null} raw Value of monitor.rbl_config
 * @returns {object} Config with defaults applied and zones normalised
 */
function parseConfig(raw) {
    let parsed = {};
    if (raw && typeof raw === "object") {
        parsed = raw;
    } else if (typeof raw === "string" && raw.trim()) {
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            parsed = {};
        }
    }

    const config = { ...CONFIG_DEFAULTS,
        ...parsed };

    config.targets = toStringList(config.targets);
    config.zones = normaliseZones(config.zones);
    config.resolver = typeof config.resolver === "string" && config.resolver.trim() ? config.resolver.trim() : null;
    config.failOnListing = config.failOnListing !== false;

    const maxListings = Number(config.maxListings);
    config.maxListings = Number.isFinite(maxListings) && maxListings > 0 ? Math.floor(maxListings) : 0;

    const concurrency = Number(config.concurrency);
    config.concurrency = Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : CONFIG_DEFAULTS.concurrency;

    return config;
}

/**
 * Coerce a config value that should be a list of strings.
 * @param {any} value Raw config value
 * @returns {string[]} Trimmed, non-empty strings
 */
function toStringList(value) {
    let items = [];
    if (Array.isArray(value)) {
        items = value;
    } else if (typeof value === "string") {
        items = value.split(/[\s,]+/);
    }
    return items.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "");
}

/**
 * Normalise a configured zone list into { zone, name, ipv6, note } objects.
 * @param {any} value Raw config value
 * @returns {object[]} Zone descriptors, falling back to DEFAULT_ZONES when empty
 */
function normaliseZones(value) {
    const list = Array.isArray(value) ? value : [];
    const zones = [];

    for (const entry of list) {
        const zone = typeof entry === "string" ? entry.trim() : String(entry && entry.zone || "").trim();
        if (!zone) {
            continue;
        }
        const known = DEFAULT_ZONES.find((z) => z.zone === zone);
        const custom = typeof entry === "object" && entry !== null ? entry : {};
        zones.push({
            zone,
            name: String(custom.name || known && known.name || zone),
            ipv6: custom.ipv6 !== undefined ? custom.ipv6 !== false : known ? known.ipv6 !== false : true,
            note: custom.note || known && known.note || null,
        });
    }

    return zones.length ? zones : DEFAULT_ZONES.map((zone) => ({ ...zone }));
}

/**
 * Expand an IPv6 address to its eight four-digit groups.
 * @param {string} ip IPv6 address
 * @returns {string[]} Eight lowercase four-character hex groups
 * @throws {Error} If the address cannot be expanded to exactly eight groups
 */
function expandIpv6(ip) {
    let text = ip.split("%")[0];

    const lastColon = text.lastIndexOf(":");
    const trailer = text.slice(lastColon + 1);
    if (trailer.includes(".")) {
        if (!net.isIPv4(trailer)) {
            throw new Error(`Malformed IPv6 address: "${ip}"`);
        }
        const octets = trailer.split(".").map(Number);
        const high = ((octets[0] << 8) | octets[1]).toString(16).padStart(4, "0");
        const low = ((octets[2] << 8) | octets[3]).toString(16).padStart(4, "0");
        text = `${text.slice(0, lastColon + 1)}${high}:${low}`;
    }

    const halves = text.split("::");
    if (halves.length > 2) {
        throw new Error(`Malformed IPv6 address, "::" may appear only once: "${ip}"`);
    }

    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];

    let groups;
    if (halves.length === 2) {
        const fill = 8 - left.length - right.length;
        if (fill < 1) {
            throw new Error(`Malformed IPv6 address, "::" stands for no groups: "${ip}"`);
        }
        groups = [ ...left, ...new Array(fill).fill("0"), ...right ];
    } else {
        groups = left;
    }

    if (groups.length !== 8) {
        throw new Error(`Malformed IPv6 address, expected 8 groups but found ${groups.length}: "${ip}"`);
    }

    return groups.map((group) => {
        if (!/^[0-9a-fA-F]{1,4}$/.test(group)) {
            throw new Error(`Malformed IPv6 address, "${group}" is not a hex group: "${ip}"`);
        }
        return group.toLowerCase().padStart(4, "0");
    });
}

/**
 * The dotted-quad hidden inside an IPv4-mapped IPv6 address, if there is one.
 * @param {string[]} groups Expanded IPv6 groups
 * @returns {string|null} The embedded IPv4 address, or null
 */
function mappedIpv4(groups) {
    const prefixIsZero = groups.slice(0, 5).every((group) => group === "0000");
    if (!prefixIsZero || groups[5] !== "ffff") {
        return null;
    }
    const high = parseInt(groups[6], 16);
    const low = parseInt(groups[7], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * Build the DNSBL query prefix for an address.
 * @param {string} ip IPv4 or IPv6 address
 * @returns {string} The reversed query prefix, without a trailing dot
 * @throws {Error} If the input is not a valid IP address
 */
function reverseIp(ip) {
    if (typeof ip !== "string") {
        throw new Error(`Not an IP address: ${JSON.stringify(ip)}`);
    }

    const address = ip.trim();

    if (net.isIPv4(address)) {
        return address.split(".").reverse().join(".");
    }

    if (net.isIPv6(address)) {
        const groups = expandIpv6(address);
        const mapped = mappedIpv4(groups);
        if (mapped) {
            return mapped.split(".").reverse().join(".");
        }
        return groups.join("").split("").reverse().join(".");
    }

    throw new Error(`Not a valid IP address: "${ip}"`);
}

/**
 * Whether an address can never appear on a public blocklist.
 * @param {string} ip IPv4 or IPv6 address
 * @returns {boolean} True when the address is outside public routing
 */
function isNonRoutable(ip) {
    const address = typeof ip === "string" ? ip.trim() : "";

    if (net.isIPv4(address)) {
        const octets = address.split(".").map(Number);
        if (octets[0] === 0 || octets[0] === 10 || octets[0] === 127) {
            return true;
        }
        if (octets[0] === 169 && octets[1] === 254) {
            return true;
        }
        if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) {
            return true;
        }
        if (octets[0] === 192 && octets[1] === 168) {
            return true;
        }
        // 100.64.0.0/10, carrier-grade NAT.
        if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
            return true;
        }
        // Multicast and the reserved top of the space.
        return octets[0] >= 224;
    }

    if (net.isIPv6(address)) {
        let groups;
        try {
            groups = expandIpv6(address);
        } catch (e) {
            return false;
        }

        const mapped = mappedIpv4(groups);
        if (mapped) {
            return isNonRoutable(mapped);
        }

        const joined = groups.join("");
        // The unspecified address and loopback.
        if (/^0{31}[01]$/.test(joined)) {
            return true;
        }

        const first = parseInt(groups[0], 16);
        // fc00::/7 unique local, fe80::/10 link local, ff00::/8 multicast.
        return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00;
    }

    return false;
}

/**
 * Join a resolveTxt() reply into one readable string.
 * @param {any} txt Value returned by resolveTxt, normally string[][]
 * @returns {string|null} The joined text, or null if there was none
 */
function joinTxt(txt) {
    if (!Array.isArray(txt)) {
        return typeof txt === "string" && txt.trim() ? txt.trim() : null;
    }
    const parts = txt
        .map((entry) => (Array.isArray(entry) ? entry.join("") : String(entry)))
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "");
    return parts.length ? parts.join(" ") : null;
}

/**
 * The last octet of a 127.0.0.0/8 answer: the zone-specific return code.
 * @param {string} address An A record from a DNSBL
 * @returns {number} The final octet
 */
function returnCode(address) {
    return Number(address.split(".")[3]);
}

/**
 * Whether an answer falls inside 127.0.0.0/8, where every real DNSBL answers.
 * @param {string} address An A record
 * @returns {boolean} True when the answer is a loopback address
 */
function isBlocklistAnswer(address) {
    return net.isIPv4(address) && address.split(".")[0] === "127";
}

/**
 * Whether an answer is a rejection rather than a listing.
 * @param {string} address An A record from a DNSBL
 * @returns {boolean} True when the zone rejected the query
 */
function isRejection(address) {
    return address.startsWith("127.255.255.");
}

/**
 * Turn a zone's answer into a verdict.
 * @param {string|object} zone Zone name, or a { zone, name } descriptor
 * @param {string[]|null} addresses A records returned for the query, if any
 * @param {any} txt Value returned by resolveTxt, if it was fetched
 * @returns {object} { listed, zone, name, codes, addresses, reason, error }
 */
function interpretResult(zone, addresses, txt) {
    const zoneName = typeof zone === "string" ? zone : String(zone && zone.zone || "");
    const label = typeof zone === "object" && zone !== null && zone.name ? zone.name : zoneName;
    const reason = joinTxt(txt);

    const answers = (Array.isArray(addresses) ? addresses : [])
        .filter((address) => typeof address === "string" && address.trim() !== "")
        .map((address) => address.trim());

    const result = {
        listed: false,
        zone: zoneName,
        name: label,
        codes: [],
        addresses: answers,
        reason,
        error: null,
    };

    // No answer at all is the ordinary "not listed" reply.
    if (!answers.length) {
        return result;
    }

    const outside = answers.filter((address) => !isBlocklistAnswer(address));
    if (outside.length) {
        result.error = `${label} answered ${outside.join(", ")}, which is outside 127.0.0.0/8; the resolver appears to be rewriting the reply`;
        return result;
    }

    const rejections = answers.filter(isRejection);
    if (rejections.length) {
        result.error = `${label} rejected the query (${rejections.join(", ")})${reason ? `: ${reason}` : ""}`;
        return result;
    }

    result.listed = true;
    result.codes = [ ...new Set(answers.map(returnCode)) ].sort((a, b) => a - b);
    return result;
}

/**
 * Look one address up in one zone.
 * @param {string} ip Address to look up
 * @param {string|object} zone Zone name, or a { zone, name } descriptor
 * @param {object} resolver Object with resolve4() and optionally resolveTxt()
 * @returns {Promise<object>} The interpretResult() shape
 */
async function checkZone(ip, zone, resolver) {
    const zoneName = typeof zone === "string" ? zone : String(zone && zone.zone || "");
    const label = typeof zone === "object" && zone !== null && zone.name ? zone.name : zoneName;

    /**
     * Build a result carrying an error rather than a verdict.
     * @param {string} message What went wrong
     * @returns {object} The interpretResult() shape with `error` set
     */
    const failure = (message) => ({
        listed: false,
        zone: zoneName,
        name: label,
        codes: [],
        addresses: [],
        reason: null,
        error: message,
    });

    let query;
    try {
        query = `${reverseIp(ip)}.${zoneName}`;
    } catch (e) {
        return failure(e.message);
    }

    let addresses;
    try {
        addresses = await resolver.resolve4(query);
    } catch (e) {
        if (NOT_LISTED_CODES.has(e.code)) {
            return interpretResult(zone, [], null);
        }
        const detail = RESOLVER_ERRORS[e.code] || e.message || String(e);
        return failure(`${label} could not be queried: ${detail}`);
    }

    let txt = null;
    if (typeof resolver.resolveTxt === "function") {
        try {
            txt = await resolver.resolveTxt(query);
        } catch (e) {
            txt = null;
        }
    }

    return interpretResult(zone, addresses, txt);
}

/**
 * Map over items with a bounded number of workers in flight.
 * @param {any[]} items Items to process
 * @param {number} limit Maximum concurrent workers
 * @param {Function} worker Async function called with (item, index)
 * @returns {Promise<any[]>} Worker results, in input order
 */
async function mapLimit(items, limit, worker) {
    const list = Array.isArray(items) ? items : [];
    const results = new Array(list.length);
    if (!list.length) {
        return results;
    }

    const workers = Math.max(1, Math.min(Math.floor(Number(limit)) || 1, list.length));
    let next = 0;

    /**
     * Take items off the shared cursor until there are none left.
     * @returns {Promise<void>} Resolves when the queue is drained
     */
    const run = async () => {
        while (next < list.length) {
            const index = next;
            next += 1;
            results[index] = await worker(list[index], index);
        }
    };

    await Promise.all(new Array(workers).fill(null).map(run));
    return results;
}

/** How many listings to name in the heartbeat before summarising the rest. */
const MAX_LISTINGS_IN_MESSAGE = 10;

/** How many addresses to name in a clean heartbeat before summarising. */
const MAX_ADDRESSES_IN_MESSAGE = 5;

/**
 * DNSBL/RBL monitor type.
 */
class RblMonitorType extends MonitorType {
    name = "rbl";

    allowCustomStatus = true;

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const startTime = dayjs().valueOf();
        const config = parseConfig(monitor.rbl_config);

        const targets = config.targets.length ? config.targets : monitor.hostname ? [ monitor.hostname.trim() ] : [];

        if (!targets.length) {
            throw new Error("No addresses or hostnames configured to check");
        }
        if (!config.zones.length) {
            throw new Error("No blocklist zones configured");
        }

        const resolver = this.createResolver(monitor, config);
        const { addresses, errors: targetErrors } = await this.resolveTargets(targets, resolver);

        const routable = addresses.filter((entry) => !isNonRoutable(entry.ip));
        const nonRoutable = addresses.filter((entry) => isNonRoutable(entry.ip));

        const jobs = [];
        const skippedZones = new Set();
        for (const entry of routable) {
            const isV6 = net.isIPv6(entry.ip);
            for (const zone of config.zones) {
                if (isV6 && zone.ipv6 === false) {
                    skippedZones.add(zone.name);
                    continue;
                }
                jobs.push({ entry,
                    zone });
            }
        }

        const results = await mapLimit(jobs, config.concurrency, async (job) =>
            ({ entry: job.entry,
                result: await checkZone(job.entry.ip, job.zone, resolver) })
        );

        heartbeat.ping = dayjs().valueOf() - startTime;

        const listings = results.filter((item) => item.result.listed);
        const failures = results.filter((item) => item.result.error);
        const answered = results.filter((item) => !item.result.error);

        for (const item of failures) {
            log.debug("rbl", `${item.entry.ip}: ${item.result.error}`);
        }

        const notes = this.buildNotes({
            targetErrors,
            nonRoutable,
            skippedZones,
            failures,
        });

        if (listings.length) {
            this.reportListings(heartbeat, config, listings, notes);
            return;
        }

        if (!results.length) {
            if (targetErrors.length) {
                this.apply(heartbeat, DOWN, `Could not check any blocklist: ${targetErrors.join("; ")}`);
            } else {
                this.apply(heartbeat, PENDING, `Nothing to check: ${notes.join("; ") || "no usable address"}`);
            }
            return;
        }

        if (!answered.length) {
            const detail = this.uniqueMessages(failures.map((item) => item.result.error)).join("; ");
            this.apply(heartbeat, DOWN, `Could not check any blocklist: ${detail}`);
            return;
        }

        const summary = `No listings: ${this.describeAddresses(routable)} checked against ${this.zoneCount(results)} blocklist(s)`;

        if (failures.length || targetErrors.length) {
            this.apply(heartbeat, PENDING, `${summary} (incomplete: ${notes.join("; ")})`);
            return;
        }

        this.apply(heartbeat, UP, notes.length ? `${summary} (${notes.join("; ")})` : summary);
    }

    /**
     * Record the outcome on the heartbeat.
     * @param {object} heartbeat Heartbeat to update
     * @param {number} status UP, PENDING or DOWN
     * @param {string} msg Human readable message
     * @returns {void}
     */
    apply(heartbeat, status, msg) {
        heartbeat.status = status;
        heartbeat.msg = msg;
    }

    /**
     * Report one or more listings, taking the monitor down if they exceed the
     * configured tolerance.
     * @param {object} heartbeat Heartbeat to update
     * @param {object} config Monitor config
     * @param {object[]} listings Results whose `listed` is true
     * @param {string[]} notes Caveats about what could not be checked
     * @returns {void}
     */
    reportListings(heartbeat, config, listings, notes) {
        const shown = listings.slice(0, MAX_LISTINGS_IN_MESSAGE).map((item) => this.describeListing(item));
        if (listings.length > shown.length) {
            shown.push(`and ${listings.length - shown.length} more`);
        }

        const parts = [ shown.join("; ") ];
        if (notes.length) {
            parts.push(`(${notes.join("; ")})`);
        }

        const msg = parts.join(" ");

        if (!config.failOnListing) {
            this.apply(heartbeat, PENDING, msg);
            return;
        }

        if (listings.length > config.maxListings) {
            this.apply(heartbeat, DOWN, msg);
            return;
        }

        this.apply(heartbeat, PENDING, `${msg} - within the tolerance of ${config.maxListings} listing(s)`);
    }

    /**
     * Render one listing as the line an operator has to act on.
     * @param {object} item A { entry, result } pair
     * @returns {string} e.g. "203.0.113.10 listed on Spamhaus ZEN (127.0.0.2)"
     */
    describeListing(item) {
        const { entry, result } = item;
        const who = entry.target && entry.target !== entry.ip ? `${entry.ip} (${entry.target})` : entry.ip;
        const codes = result.addresses.length ? result.addresses.join(", ") : result.codes.join(", ");
        const line = `${who} listed on ${result.name} (${codes})`;
        return result.reason ? `${line} - ${result.reason}` : line;
    }

    /**
     * Collect the caveats worth carrying into the heartbeat.
     * @param {object} input Everything that went wrong or was skipped
     * @param {string[]} input.targetErrors Targets that could not be resolved
     * @param {object[]} input.nonRoutable Addresses outside public routing
     * @param {Set<string>} input.skippedZones Zones skipped for IPv6 targets
     * @param {object[]} input.failures Lookups that did not get an answer
     * @returns {string[]} Human readable notes, possibly empty
     */
    buildNotes({ targetErrors, nonRoutable, skippedZones, failures }) {
        const notes = [];

        if (targetErrors.length) {
            notes.push(...targetErrors);
        }

        if (nonRoutable.length) {
            const list = nonRoutable.map((entry) => entry.ip).join(", ");
            notes.push(`skipped ${list}: not publicly routable, so no blocklist can hold it`);
        }

        if (skippedZones.size) {
            notes.push(`skipped ${[ ...skippedZones ].join(", ")} for IPv6 addresses: IPv4-only zones`);
        }

        if (failures.length) {
            const messages = this.uniqueMessages(failures.map((item) => item.result.error));
            notes.push(`${failures.length} lookup(s) gave no answer: ${messages.join("; ")}`);
        }

        return notes;
    }

    /**
     * Deduplicate a list of messages, keeping the first occurrence of each.
     * @param {string[]} messages Messages to fold
     * @returns {string[]} Unique messages, capped at a readable length
     */
    uniqueMessages(messages) {
        const unique = [ ...new Set(messages.filter(Boolean)) ];
        if (unique.length <= 3) {
            return unique;
        }
        return [ ...unique.slice(0, 3), `and ${unique.length - 3} more` ];
    }

    /**
     * Name the addresses that were actually checked.
     * @param {object[]} entries Address entries
     * @returns {string} A readable address list
     */
    describeAddresses(entries) {
        const ips = [ ...new Set(entries.map((entry) => entry.ip)) ];
        if (ips.length <= MAX_ADDRESSES_IN_MESSAGE) {
            return ips.join(", ");
        }
        return `${ips.slice(0, MAX_ADDRESSES_IN_MESSAGE).join(", ")} and ${ips.length - MAX_ADDRESSES_IN_MESSAGE} more`;
    }

    /**
     * How many distinct zones produced a result.
     * @param {object[]} results Results from the run
     * @returns {number} Distinct zone count
     */
    zoneCount(results) {
        return new Set(results.map((item) => item.result.zone)).size;
    }

    /**
     * Build the resolver used for both target and blocklist lookups.
     * @param {object} monitor Monitor bean
     * @param {object} config Monitor config
     * @returns {Resolver} A configured resolver
     */
    createResolver(monitor, config) {
        const seconds = Number(monitor.timeout);
        const timeout = (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 30) : 5) * 1000;

        const resolver = new Resolver({ timeout,
            tries: 2 });

        if (config.resolver) {
            resolver.setServers([ net.isIPv6(config.resolver) ? `[${config.resolver}]` : config.resolver ]);
        }

        return resolver;
    }

    /**
     * Expand every target into the addresses behind it.
     * @param {string[]} targets Addresses or hostnames from the config
     * @param {object} resolver Resolver to use
     * @returns {Promise<object>} { addresses: {ip, target}[], errors: string[] }
     */
    async resolveTargets(targets, resolver) {
        const addresses = [];
        const errors = [];
        const seen = new Set();

        /**
         * Record an address once, remembering the target it came from.
         * @param {string} ip Address
         * @param {string} target Target it was resolved from
         * @returns {void}
         */
        const add = (ip, target) => {
            if (seen.has(ip)) {
                return;
            }
            seen.add(ip);
            addresses.push({ ip,
                target });
        };

        for (const target of targets) {
            if (net.isIP(target)) {
                add(target, target);
                continue;
            }

            const [ v4, v6 ] = await Promise.allSettled([ resolver.resolve4(target), resolver.resolve6(target) ]);
            const found = [
                ...(v4.status === "fulfilled" ? v4.value : []),
                ...(v6.status === "fulfilled" ? v6.value : []),
            ];

            if (!found.length) {
                const reason = v4.status === "rejected" ? v4.reason.code || v4.reason.message : "no A or AAAA record";
                errors.push(`could not resolve ${target}: ${reason}`);
                continue;
            }

            for (const ip of found) {
                add(ip, target);
            }
        }

        return { addresses,
            errors };
    }
}

module.exports = {
    RblMonitorType,
    KNOWN_ZONES,
    DEFAULT_ZONES,
    CONFIG_DEFAULTS,
    NOT_LISTED_CODES,
    parseConfig,
    normaliseZones,
    expandIpv6,
    reverseIp,
    isNonRoutable,
    interpretResult,
    checkZone,
    mapLimit,
};
