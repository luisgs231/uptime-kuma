<template>
    <div class="shadow-box big-padding dmarc-summary">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
            <h4 class="mb-0">
                DMARC
                <span class="fw-normal text-secondary period">last {{ days }} days</span>
            </h4>
            <router-link :to="`/dashboard/${monitor.id}/dmarc`" class="btn btn-primary report-link">
                <font-awesome-icon icon="chart-bar" class="me-1" />
                Open DMARC report
            </router-link>
        </div>

        <div v-if="dmarcStatus" class="mb-3">
            <DmarcStatusBadge :status="dmarcStatus" :show-description="true" />
            <div v-if="lastHeartBeat.msg" class="status-msg text-secondary">{{ lastHeartBeat.msg }}</div>
        </div>

        <div v-if="loading" class="text-secondary">Loading…</div>

        <div v-else-if="error" class="text-danger">{{ error }}</div>

        <div v-else-if="domains.length === 0" class="text-secondary">
            <p class="mb-0">No DMARC reports received yet.</p>
            <p class="mb-0">
                Receivers normally send one aggregate report per day, so allow up to 24 hours after publishing the
                <code>_dmarc</code>
                record before worrying.
            </p>
        </div>

        <div v-else class="table-wrapper">
            <table class="table table-borderless table-hover mb-0">
                <thead>
                    <tr>
                        <th>Domain</th>
                        <th>Pass Rate</th>
                        <th class="text-end">Messages</th>
                        <th class="text-end">Failed</th>
                        <th>Policy</th>
                        <th>Last Report</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="domain in domains" :key="domain.domain">
                        <td class="domain-cell">{{ domain.domain }}</td>
                        <td>
                            <span class="badge rounded-pill" :class="`bg-${passRateColor(domain)}`">
                                {{ passRateText(domain) }}
                            </span>
                        </td>
                        <td class="text-end">{{ formatNumber(domain.messages) }}</td>
                        <td class="text-end" :class="{ 'text-danger': domain.failed > 0 }">
                            {{ formatNumber(domain.failed) }}
                        </td>
                        <td>
                            <span v-if="domain.policy && domain.policy.policy_p" class="policy">
                                p={{ domain.policy.policy_p }}
                            </span>
                            <span v-else class="text-secondary">unknown</span>
                        </td>
                        <td :title="domain.lastReport ? $root.unixToDateTime(domain.lastReport) : ''">
                            {{ domain.lastReport ? fromNow(domain.lastReport) : "—" }}
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<script>
import dayjs from "dayjs";
import DmarcStatusBadge from "./DmarcStatusBadge.vue";

const numberFormat = new Intl.NumberFormat();

export default {
    name: "DmarcSummary",

    components: {
        DmarcStatusBadge,
    },

    props: {
        /** Monitor this summary belongs to */
        monitor: {
            type: Object,
            required: true,
        },
    },

    data() {
        return {
            loading: true,
            error: null,
            domains: [],
        };
    },

    computed: {
        days() {
            return this.monitor.dmarcConfig?.windowDays || 30;
        },

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
         * DMARC status carried by the latest heartbeat.
         * @returns {string|null} Status string, or null before the monitor has run
         */
        dmarcStatus() {
            return this.lastHeartBeat.dmarcStatus || null;
        },
    },

    watch: {
        "monitor.id"() {
            this.load();
        },

        days() {
            this.load();
        },
    },

    mounted() {
        this.load();
    },

    methods: {
        /**
         * Fetch the per-domain summary for the monitor's evaluation window.
         * @returns {void}
         */
        load() {
            this.loading = true;
            this.error = null;

            this.$root.getSocket().emit("getDmarcSummary", this.monitor.id, this.days, (res) => {
                this.loading = false;

                if (!res.ok) {
                    this.error = res.msg;
                    this.domains = [];
                    return;
                }

                this.domains = res.data?.domains || [];
            });
        },

        /**
         * Share of messages that passed DMARC alignment.
         * @param {object} domain Summary row
         * @returns {number|null} Pass rate in percent, or null when no messages were reported
         */
        passRate(domain) {
            if (!domain.messages) {
                return null;
            }
            return (domain.passed / domain.messages) * 100;
        },

        /**
         * Pass rate as a display string.
         * @param {object} domain Summary row
         * @returns {string} Formatted pass rate
         */
        passRateText(domain) {
            const rate = this.passRate(domain);
            if (rate === null) {
                return "—";
            }
            return `${Math.round(rate * 10) / 10}%`;
        },

        /**
         * Bootstrap colour for the pass rate badge.
         * @param {object} domain Summary row
         * @returns {string} Bootstrap contextual colour
         */
        passRateColor(domain) {
            const rate = this.passRate(domain);
            if (rate === null) {
                return "secondary";
            }
            if (rate >= 99) {
                return "primary";
            }
            if (rate >= 95) {
                return "warning";
            }
            return "danger";
        },

        /**
         * Relative time since a unix timestamp.
         * @param {number} timestamp Unix timestamp in seconds
         * @returns {string} Human readable relative time
         */
        fromNow(timestamp) {
            return dayjs.unix(timestamp).fromNow();
        },

        /**
         * Format an integer with thousands separators.
         * @param {number} value Value to format
         * @returns {string} Formatted number
         */
        formatNumber(value) {
            return numberFormat.format(value || 0);
        },
    },
};
</script>

<style lang="scss" scoped>
.dmarc-summary {
    .report-link {
        font-weight: 700;
        white-space: nowrap;
    }

    .period {
        font-size: 0.8rem;
    }

    .status-msg {
        font-size: 0.85rem;
        margin-top: 0.25rem;
    }

    .table-wrapper {
        overflow-x: auto;
    }

    table {
        font-size: 14px;
    }

    .domain-cell {
        font-weight: bold;
        white-space: nowrap;
    }

    .policy {
        font-family: monospace;
    }
}
</style>
