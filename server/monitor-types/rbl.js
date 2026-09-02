const { MonitorType } = require("./monitor-type");
const { UP, DOWN, PENDING, log } = require("../../src/util");
const dayjs = require("dayjs");
const net = require("node:net");
const { Resolver } = require("node:dns/promises");

const { parseConfig, checkZone, mapLimit, isNonRoutable } = require("../rbl/lookup");

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
};
