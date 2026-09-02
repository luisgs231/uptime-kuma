<template>
    <div class="shadow-box big-padding rbl-summary">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
            <h4 class="mb-0">
                Blocklists
                <span class="fw-normal text-secondary sub">DNSBL reputation</span>
            </h4>
            <span v-if="lastHeartBeat.time" class="text-secondary sub">
                checked
                <Datetime :value="lastHeartBeat.time" />
            </span>
        </div>

        <div v-if="!hasHeartbeat" class="text-secondary mb-3">
            <p class="mb-0">This monitor has not run yet.</p>
            <p class="mb-0">The first check runs on the monitor's normal interval.</p>
        </div>

        <div v-else class="mb-3">
            <span class="badge rounded-pill" :class="`bg-${verdict.color}`">{{ verdict.label }}</span>
            <div class="status-msg">{{ message }}</div>
        </div>

        <div class="row config">
            <div class="col-md-6">
                <h6 class="mb-1">Watching</h6>
                <ul v-if="targets.length" class="list-unstyled mb-0">
                    <li v-for="target in targets" :key="target" class="mono">{{ target }}</li>
                </ul>
                <p v-else class="text-secondary mb-0">
                    No addresses configured, so there is nothing for this monitor to look up.
                </p>
            </div>
            <div class="col-md-6 mt-3 mt-md-0">
                <h6 class="mb-1">Against</h6>
                <ul v-if="zones.length" class="list-unstyled mb-0">
                    <li v-for="zone in zones" :key="zone.zone">
                        {{ zone.name }}
                        <span class="mono zone-host">{{ zone.zone }}</span>
                    </li>
                </ul>
                <p v-else class="text-secondary mb-0">
                    No blocklists selected. The monitor falls back to its recommended set rather than checking nothing.
                </p>
            </div>
        </div>
    </div>
</template>

<script>
import { DOWN, PENDING, UP } from "../util.ts";
import Datetime from "./Datetime.vue";

/**
 * Colours for the bracketed labels a heartbeat message may carry.
 */
const LABEL_COLORS = {
    listed: "danger",
    "not listed": "primary",
    clean: "primary",
    error: "danger",
    incomplete: "warning",
    ok: "primary",
};

export default {
    name: "RblSummary",

    components: {
        Datetime,
    },

    props: {
        /** Monitor this summary belongs to */
        monitor: {
            type: Object,
            required: true,
        },
    },

    computed: {
        /**
         * The monitor's most recent heartbeat.
         * @returns {object} Latest heartbeat, or an empty object before the first one
         */
        lastHeartBeat() {
            if (this.monitor.id in this.$root.lastHeartbeatList && this.$root.lastHeartbeatList[this.monitor.id]) {
                return this.$root.lastHeartbeatList[this.monitor.id];
            }

            return {};
        },

        /**
         * Whether the monitor has produced a result at all.
         * @returns {boolean} True once a heartbeat exists
         */
        hasHeartbeat() {
            return this.lastHeartBeat.status !== undefined && this.lastHeartBeat.status !== null;
        },

        /**
         * The heartbeat message with any leading "[Label]" removed.
         * @returns {string} The message body
         */
        message() {
            const raw = String(this.lastHeartBeat.msg || "");
            const match = raw.match(/^\[([^\]]+)\]\s*/);
            return match ? raw.slice(match[0].length) : raw;
        },

        /**
         * Label and colour for the badge above the message.
         * @returns {object} label and Bootstrap colour
         */
        verdict() {
            const raw = String(this.lastHeartBeat.msg || "");
            const match = raw.match(/^\[([^\]]+)\]/);
            if (match) {
                const label = match[1];
                return {
                    label,
                    color: LABEL_COLORS[label.toLowerCase()] || this.statusColor,
                };
            }

            const listed = / listed on /.test(raw);

            if (this.lastHeartBeat.status === UP) {
                return { label: "Not listed", color: "primary" };
            }
            if (this.lastHeartBeat.status === DOWN) {
                return { label: listed ? "Listed" : "Check failed", color: "danger" };
            }
            if (this.lastHeartBeat.status === PENDING) {
                return { label: listed ? "Listed" : "Incomplete", color: "warning" };
            }
            return { label: "Unknown", color: "secondary" };
        },

        /**
         * Bootstrap colour matching the heartbeat's own up/pending/down state.
         * @returns {string} Bootstrap contextual colour
         */
        statusColor() {
            if (this.lastHeartBeat.status === UP) {
                return "primary";
            }
            if (this.lastHeartBeat.status === PENDING) {
                return "warning";
            }
            if (this.lastHeartBeat.status === DOWN) {
                return "danger";
            }
            return "secondary";
        },

        /**
         * The addresses and hostnames this monitor looks up.
         * @returns {string[]} Configured targets
         */
        targets() {
            const targets = this.monitor.rblConfig?.targets;
            return Array.isArray(targets) ? targets : [];
        },

        /**
         * The blocklists this monitor queries.
         * @returns {object[]} Zones with a name and a hostname
         */
        zones() {
            const zones = this.monitor.rblConfig?.zones;
            if (!Array.isArray(zones)) {
                return [];
            }

            return zones
                .map((entry) => {
                    const zone = (typeof entry === "string" ? entry : String(entry?.zone ?? "")).trim();
                    if (!zone) {
                        return null;
                    }
                    return {
                        zone,
                        name: (entry && typeof entry === "object" && entry.name) || zone,
                    };
                })
                .filter((zone) => zone !== null);
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.rbl-summary {
    .sub {
        font-size: 0.8rem;
    }

    .status-msg {
        font-size: 0.85rem;
        margin-top: 0.35rem;
        word-break: break-word;
    }

    .config {
        font-size: 0.85rem;
    }

    .mono {
        font-family: monospace;
    }

    .zone-host {
        opacity: 0.7;
    }

    .badge.bg-warning {
        color: $dark-font-color2;
    }
}
</style>
