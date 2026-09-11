<template>
    <div class="shadow-box big-padding carp-summary">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
            <h4 class="mb-0">
                CARP
                <span class="fw-normal text-secondary sub">failover state</span>
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
            <span class="badge rounded-pill" :class="`bg-${verdict.color}`" :title="verdict.description">{{
                verdict.label
            }}</span>
            <div class="status-msg">{{ message }}</div>
        </div>

        <h6 class="mb-1">Topology</h6>
        <div class="table-wrapper">
            <table class="table table-borderless table-sm mb-0 topology">
                <tbody>
                    <tr>
                        <th scope="row">Floating IP</th>
                        <td>
                            <span v-if="floatingIp" class="mono">{{ floatingIp }}</span>
                            <span v-else class="text-secondary">not configured</span>
                            <span v-if="vhid" class="text-secondary ms-2">VHID {{ vhid }}</span>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Master</th>
                        <td>
                            <span v-if="masterIp" class="mono">{{ masterIp }}</span>
                            <span v-else class="text-secondary">any node may hold it</span>
                        </td>
                    </tr>
                    <tr>
                        <th scope="row">Other nodes</th>
                        <td>
                            <span v-if="backupIps.length === 0" class="text-secondary">none</span>
                            <span v-for="ip in backupIps" v-else :key="ip" class="mono node">{{ ip }}</span>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <p class="form-text mb-0">
            Every node above is queried, not just the master: a node reports only its own virtual addresses, so two
            nodes both claiming MASTER cannot be seen from either one alone.
        </p>
    </div>
</template>

<script>
import Datetime from "./Datetime.vue";
import { CARP_STATUS_META, statusFromMessage, splitStatusMessage } from "../monitor-status.ts";

export default {
    name: "CarpSummary",

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
         * The heartbeat message with its "[Label]" prefix removed.
         * @returns {string} The message body
         */
        message() {
            return splitStatusMessage(this.lastHeartBeat.msg).body;
        },

        /**
         * Label and colour for the badge above the message.
         * @returns {object} label and Bootstrap colour
         */
        verdict() {
            const status = statusFromMessage("carp", this.lastHeartBeat.msg);
            if (status) {
                return CARP_STATUS_META[status];
            }

            const { label } = splitStatusMessage(this.lastHeartBeat.msg);
            return { label: label || "Unknown",
                color: "secondary",
                description: "" };
        },

        /**
         * Stored configuration for this monitor.
         * @returns {object} carpConfig, or an empty object
         */
        config() {
            return this.monitor.carpConfig || {};
        },

        floatingIp() {
            return this.config.floatingIp || "";
        },

        masterIp() {
            return this.config.masterIp || "";
        },

        vhid() {
            return this.config.vhid || null;
        },

        /**
         * The other nodes queried alongside the master.
         * @returns {string[]} Node addresses
         */
        backupIps() {
            return Array.isArray(this.config.backupIps) ? this.config.backupIps : [];
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.carp-summary {
    .sub {
        font-size: 0.8rem;
    }

    .status-msg {
        font-size: 0.85rem;
        margin-top: 0.35rem;
        word-break: break-word;
    }

    .table-wrapper {
        overflow-x: auto;
    }

    .topology {
        font-size: 0.85rem;

        th {
            white-space: nowrap;
            width: 9rem;
            font-weight: normal;
            opacity: 0.75;
        }
    }

    .mono {
        font-family: monospace;
    }

    .node + .node {
        margin-left: 0.75rem;
    }

    .badge.bg-warning {
        color: $dark-font-color2;
    }
}
</style>
