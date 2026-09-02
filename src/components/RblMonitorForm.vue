<template>
    <div class="rbl-monitor-form">
        <h2 class="mb-2">Targets</h2>

        <p class="form-text mt-0">
            The addresses to look up on every selected blocklist. A listing is a deliverability problem for whatever
            sends from that address, so this is normally the outbound IP of a mail server rather than a web host.
        </p>

        <div class="my-3">
            <label for="rbl-targets" class="form-label">Addresses or Hostnames</label>
            <textarea
                id="rbl-targets"
                v-model="targetsText"
                class="form-control"
                rows="4"
                spellcheck="false"
                placeholder="203.0.113.10&#10;mail.example.com"
            ></textarea>
            <div class="form-text">
                One per line. A hostname is resolved first and every address behind it is checked, because a name with
                four A records is four different reputations. Addresses that are not publicly routable — private,
                loopback or link-local — are skipped and named in the heartbeat, since no blocklist can hold them.
            </div>
        </div>

        <div v-if="targetCount === 0" class="alert alert-warning" role="alert">
            Nothing is configured to check, so this monitor will report an error rather than a clean result.
        </div>

        <h2 class="mt-5 mb-2">Blocklists</h2>

        <p class="form-text mt-0">
            Each selected zone is queried once per address. Zones that only hold IPv4 space are skipped for IPv6
            addresses rather than counted as a pass — an unanswerable question is not a clean answer.
        </p>

        <div class="my-3">
            <div v-for="zone in zoneOptions" :key="zone.zone" class="form-check zone-row">
                <input
                    :id="`rbl-zone-${zone.zone}`"
                    v-model="selectedZones"
                    class="form-check-input"
                    type="checkbox"
                    :value="zone.zone"
                />
                <label class="form-check-label" :for="`rbl-zone-${zone.zone}`">
                    <span class="zone-name">{{ zone.name }}</span>
                    <span class="zone-host">{{ zone.zone }}</span>
                    <span v-if="!zone.ipv6" class="badge bg-secondary ms-1">IPv4 only</span>
                    <span v-if="zone.custom" class="badge bg-secondary ms-1">custom</span>
                </label>
                <div v-if="zone.note" class="zone-note" :class="zone.recommended ? 'text-secondary' : 'text-warning'">
                    <font-awesome-icon v-if="!zone.recommended" icon="exclamation-triangle" class="me-1" />
                    {{ zone.note }}
                </div>
            </div>
        </div>

        <div v-if="selectedZones.length === 0" class="alert alert-warning" role="alert">
            No blocklist is selected. The monitor falls back to the recommended set rather than checking nothing, so
            unticking everything does not switch the checks off — it just hides which ones are running.
        </div>

        <div v-else-if="hasUnrecommendedSelection" class="alert alert-warning" role="alert">
            One or more selected zones carry a warning above. A retired zone, and a zone that only answers resolvers
            registered with its operator, both reply NXDOMAIN for every address on earth — which this monitor cannot
            tell apart from "not listed". Such a zone reports clean forever and adds nothing but confidence.
        </div>

        <h2 class="mt-5 mb-2">Resolver</h2>

        <div class="my-3">
            <label for="rbl-resolver" class="form-label">DNS Resolver</label>
            <input
                id="rbl-resolver"
                v-model="resolver"
                type="text"
                class="form-control"
                placeholder="System resolver"
            />
            <div class="form-text">
                Leave this blank to use the system resolver, which is almost always what you want. Spamhaus and several
                others refuse queries that arrive from a large public resolver: pointing this at
                <code>1.1.1.1</code>
                or
                <code>8.8.8.8</code>
                makes them answer with a rejection code instead of a verdict, so the monitor stops reporting whether
                your addresses are listed and starts reporting that it was not allowed to ask.
            </div>
        </div>

        <h2 class="mt-5 mb-2">Alerting</h2>

        <div class="my-3 form-check">
            <input id="rbl-fail-on-listing" v-model="config.failOnListing" class="form-check-input" type="checkbox" />
            <label class="form-check-label" for="rbl-fail-on-listing">Go down when an address is listed</label>
            <div class="form-text">
                Turn this off to watch the blocklists without being paged. A listing then leaves the monitor pending:
                visible on the dashboard and in its history, but never a down alert. A tolerated listing is pending
                either way — being on a blocklist is never nothing.
            </div>
        </div>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="rbl-max-listings" class="form-label">Tolerated Listings</label>
                    <input
                        id="rbl-max-listings"
                        v-model.number="config.maxListings"
                        type="number"
                        class="form-control"
                        min="0"
                        step="1"
                        :disabled="!config.failOnListing"
                    />
                    <div class="form-text">
                        How many listings to put up with before going down. 0 means any listing is a failure. Raise it
                        only for an address that sits on a list you have decided to live with.
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
/**
 * The blocklist catalogue offered by the form.
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
        name: "Barracuda",
        ipv6: false,
        recommended: false,
        note: "Only answers resolvers whose IP has been registered with Barracuda; an unregistered querier gets NXDOMAIN for everything, which is indistinguishable from clean.",
    },
    {
        zone: "dnsbl.sorbs.net",
        name: "SORBS",
        ipv6: false,
        recommended: false,
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
        name: "CBL",
        ipv6: false,
        recommended: false,
        note: "Reported folded into the Spamhaus XBL, which zen.spamhaus.org already covers. Querying both is largely duplicate work.",
    },
];

/** The zones ticked for a monitor that has never been configured. */
const DEFAULT_ZONES = KNOWN_ZONES.filter((zone) => zone.recommended);

const DEFAULT_CONFIG = {
    targets: [],
    resolver: null,
    failOnListing: true,
    maxListings: 0,
};

/**
 * Split a textarea's contents into a list of trimmed, non-empty entries.
 * @param {string} text Raw textarea value
 * @returns {string[]} One entry per non-blank line
 */
function splitLines(text) {
    return String(text ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

/**
 * Turn a stored zone entry into the full descriptor the form renders.
 * @param {string|object} entry Stored zone entry
 * @returns {object|null} Zone descriptor, or null when there is no zone name
 */
function describeZone(entry) {
    const zone = (typeof entry === "string" ? entry : String(entry?.zone ?? "")).trim();
    if (!zone) {
        return null;
    }

    const known = KNOWN_ZONES.find((candidate) => candidate.zone === zone);
    if (known) {
        return { ...known };
    }

    const custom = entry && typeof entry === "object" ? entry : {};
    return {
        zone,
        name: String(custom.name || zone),
        ipv6: custom.ipv6 !== false,
        recommended: true,
        note: custom.note || null,
        custom: true,
    };
}

/**
 * Fill in every setting the stored config is missing.
 * @param {object|null|undefined} raw Stored rblConfig, if any
 * @returns {object} Config with defaults applied
 */
function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};

    const zones = Array.isArray(source.zones)
        ? source.zones.map(describeZone).filter((zone) => zone !== null)
        : DEFAULT_ZONES.map((zone) => ({ ...zone }));

    return {
        ...DEFAULT_CONFIG,
        ...source,
        targets: Array.isArray(source.targets) ? [...source.targets] : splitLines(source.targets),
        zones,
        resolver: typeof source.resolver === "string" && source.resolver.trim() ? source.resolver.trim() : null,
        failOnListing: source.failOnListing !== false,
        maxListings: Number.isFinite(Number(source.maxListings))
            ? Math.max(0, Math.floor(Number(source.maxListings)))
            : 0,
    };
}

export default {
    name: "RblMonitorForm",

    props: {
        /** The monitor being edited */
        modelValue: {
            type: Object,
            required: true,
        },
    },

    emits: ["update:modelValue"],

    data() {
        const config = normalizeConfig(this.modelValue.rblConfig);
        return {
            config,
            targetsText: config.targets.join("\n"),
        };
    },

    computed: {
        /**
         * Every zone the checkbox list offers.
         * @returns {object[]} Zone descriptors
         */
        zoneOptions() {
            const extra = this.config.zones.filter(
                (zone) => !KNOWN_ZONES.some((candidate) => candidate.zone === zone.zone)
            );
            return [...KNOWN_ZONES, ...extra];
        },

        /**
         * The ticked zones, as bare zone names.
         * @returns {string[]} Zone names
         */
        selectedZones: {
            get() {
                return this.config.zones.map((zone) => zone.zone);
            },
            set(value) {
                const known = new Map(this.zoneOptions.map((zone) => [zone.zone, zone]));
                this.config.zones = value.map((name) => ({ ...(known.get(name) || describeZone(name)) }));
            },
        },

        /**
         * The configured resolver, with an empty field meaning "the system
         * one".
         * @returns {string} Resolver address, or an empty string
         */
        resolver: {
            get() {
                return this.config.resolver || "";
            },
            set(value) {
                const text = String(value ?? "").trim();
                this.config.resolver = text === "" ? null : text;
            },
        },

        /**
         * How many addresses or hostnames are configured.
         * @returns {number} Target count
         */
        targetCount() {
            return this.config.targets.length;
        },

        /**
         * Whether any ticked zone is one the catalogue advises against.
         * @returns {boolean} True when a warned-about zone is selected
         */
        hasUnrecommendedSelection() {
            return this.zoneOptions.some((zone) => !zone.recommended && this.selectedZones.includes(zone.zone));
        },
    },

    watch: {
        targetsText(value) {
            this.config.targets = splitLines(value);
        },

        config: {
            deep: true,
            handler() {
                this.emitConfig();
            },
        },

        "modelValue.rblConfig"(newConfig) {
            if (newConfig && newConfig !== this.config) {
                this.config = normalizeConfig(newConfig);
                this.targetsText = this.config.targets.join("\n");
            }
        },
    },

    created() {
        this.emitConfig();
    },

    methods: {
        /**
         * Hand the current config back to the parent's v-model.
         * @returns {void}
         */
        emitConfig() {
            this.$emit("update:modelValue", {
                ...this.modelValue,
                rblConfig: this.config,
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.rbl-monitor-form {
    .form-text code {
        word-break: break-word;
    }

    textarea {
        font-family: monospace;
    }

    .zone-row {
        margin-bottom: 0.6rem;

        .form-check-label {
            display: block;
        }
    }

    .zone-name {
        font-weight: bold;
    }

    .zone-host {
        font-family: monospace;
        font-size: 0.85rem;
        margin-left: 0.5rem;
        opacity: 0.75;
    }

    .zone-note {
        font-size: 0.85rem;
        margin-top: 0.15rem;
    }

    .badge {
        font-size: 0.7rem;
        font-weight: normal;
        vertical-align: middle;
    }
}
</style>
