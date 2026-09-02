<template>
    <transition name="slide-fade" appear>
        <div class="dmarc-details">
            <div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-4">
                <div>
                    <h1 class="mb-2">{{ monitorName }}</h1>
                    <div class="header-status">
                        <DmarcStatusBadge :status="dmarcStatus" />
                        <span class="text-secondary">DMARC aggregate reports</span>
                    </div>
                </div>
                <router-link :to="`/dashboard/${monitorId}`" class="btn btn-normal">← Back to monitor</router-link>
            </div>

            <!-- Nothing has been collected until the monitor has a domain -->
            <div v-if="unassigned" class="shadow-box big-padding mb-4">
                <h4 class="mb-1">No domain yet</h4>
                <p class="mb-0 text-secondary">
                    This monitor has not been assigned a domain. On its first check it adopts the first domain it finds
                    in the mailbox and starts keeping that domain's reports, which then appear here. Nothing is wrong —
                    there is simply nothing collected yet.
                </p>
            </div>

            <template v-else>
                <!-- Filters -->
                <div class="shadow-box big-padding mb-4">
                    <div class="row">
                        <div class="col-md-6">
                            <div class="form-label">Domain</div>
                            <p class="domain-fixed mb-0">{{ domain || "—" }}</p>
                            <div class="form-text">
                                A monitor holds one domain's reports and nothing else, so there is nothing to choose
                                between here.
                            </div>
                        </div>
                        <div class="col-md-6 mt-3 mt-md-0">
                            <label for="dmarc-period" class="form-label">Period</label>
                            <select id="dmarc-period" v-model.number="days" class="form-select">
                                <option :value="7">Last 7 days</option>
                                <option :value="30">Last 30 days</option>
                                <option :value="90">Last 90 days</option>
                            </select>
                        </div>
                    </div>
                </div>

                <!-- Pass / fail per day -->
                <div class="shadow-box big-padding mb-4">
                    <h4 class="mb-3">Messages Per Day</h4>

                    <div v-if="timeline.error" class="text-danger">{{ timeline.error }}</div>
                    <div v-else-if="timeline.loading" class="text-secondary">Loading…</div>
                    <div v-else-if="!hasTimelineData" class="text-secondary">No messages reported in this period.</div>
                    <div v-else class="chart-wrapper">
                        <Bar :data="chartData" :options="chartOptions" />
                    </div>
                </div>

                <!-- Per-domain summary -->
                <div class="shadow-box big-padding mb-4">
                    <h4 class="mb-3">Domains</h4>

                    <div v-if="summary.error" class="text-danger">{{ summary.error }}</div>
                    <div v-else-if="summary.loading" class="text-secondary">Loading…</div>
                    <div v-else-if="summaryRows.length === 0" class="text-secondary">
                        <p class="mb-0">No DMARC reports received yet.</p>
                        <p class="mb-0">Receivers normally send one aggregate report per day.</p>
                    </div>
                    <div v-else class="table-wrapper">
                        <table class="table table-borderless table-hover mb-0">
                            <thead>
                                <tr>
                                    <th>Domain</th>
                                    <th>Pass Rate</th>
                                    <th class="text-end">Messages</th>
                                    <th class="text-end">Passed</th>
                                    <th class="text-end">Failed</th>
                                    <th class="text-end">Reports</th>
                                    <th>Policy</th>
                                    <th>Last Report</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="row in summaryRows" :key="row.domain">
                                    <td class="nowrap fw-bold">{{ row.domain }}</td>
                                    <td>
                                        <span class="badge rounded-pill" :class="`bg-${passRateColor(row)}`">
                                            {{ passRateText(row) }}
                                        </span>
                                    </td>
                                    <td class="text-end">{{ formatNumber(row.messages) }}</td>
                                    <td class="text-end">{{ formatNumber(row.passed) }}</td>
                                    <td class="text-end" :class="{ 'text-danger': row.failed > 0 }">
                                        {{ formatNumber(row.failed) }}
                                    </td>
                                    <td class="text-end">{{ formatNumber(row.reports) }}</td>
                                    <td class="nowrap policy">
                                        <span v-if="row.policy && row.policy.policy_p">
                                            p={{ row.policy.policy_p }}
                                            <span v-if="row.policy.policy_pct != null && row.policy.policy_pct < 100">
                                                pct={{ row.policy.policy_pct }}
                                            </span>
                                        </span>
                                        <span v-else class="text-secondary">unknown</span>
                                    </td>
                                    <td
                                        class="nowrap"
                                        :title="row.lastReport ? $root.unixToDateTime(row.lastReport) : ''"
                                    >
                                        {{ row.lastReport ? fromNow(row.lastReport) : "—" }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- Sending sources -->
                <div class="shadow-box big-padding mb-4">
                    <h4 class="mb-1">Sending Sources</h4>
                    <p class="form-text mt-0">
                        Every IP that sent mail as this domain. A source marked NEW was first seen inside the selected
                        period — if you do not recognise it, that is what spoofing looks like.
                    </p>

                    <div v-if="sources.error" class="text-danger">{{ sources.error }}</div>
                    <div v-else-if="sources.loading" class="text-secondary">Loading…</div>
                    <div v-else-if="sources.rows.length === 0" class="text-secondary">
                        No sending sources reported in this period.
                    </div>
                    <div v-else class="table-wrapper">
                        <table class="table table-borderless table-hover mb-0">
                            <thead>
                                <tr>
                                    <th>Source IP</th>
                                    <th>Header From</th>
                                    <th class="text-end">Messages</th>
                                    <th class="text-end">Passed</th>
                                    <th class="text-end">Failed</th>
                                    <th class="text-end">SPF Aligned</th>
                                    <th class="text-end">DKIM Aligned</th>
                                    <th class="text-end">Quarantined</th>
                                    <th class="text-end">Rejected</th>
                                    <th>First Seen</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr
                                    v-for="source in sources.rows"
                                    :key="source.sourceIp"
                                    :class="{ 'has-failures': source.failed > 0 }"
                                >
                                    <td class="nowrap">
                                        <span class="source-ip">{{ source.sourceIp }}</span>
                                        <span v-if="isNewSource(source)" class="badge bg-warning ms-2">NEW</span>
                                    </td>
                                    <td class="nowrap">
                                        <span v-if="source.headerFrom">{{ source.headerFrom }}</span>
                                        <span v-else class="text-secondary">—</span>
                                    </td>
                                    <td class="text-end">{{ formatNumber(source.messages) }}</td>
                                    <td class="text-end">{{ formatNumber(source.passed) }}</td>
                                    <td class="text-end" :class="{ 'text-danger fw-bold': source.failed > 0 }">
                                        {{ formatNumber(source.failed) }}
                                    </td>
                                    <td class="text-end">{{ formatPercent(source.spfPassed, source.messages) }}</td>
                                    <td class="text-end">{{ formatPercent(source.dkimPassed, source.messages) }}</td>
                                    <td class="text-end" :class="{ 'text-danger': source.quarantined > 0 }">
                                        {{ formatNumber(source.quarantined) }}
                                    </td>
                                    <td class="text-end" :class="{ 'text-danger': source.rejected > 0 }">
                                        {{ formatNumber(source.rejected) }}
                                    </td>
                                    <td class="nowrap">
                                        {{ source.firstSeen ? unixDate(source.firstSeen) : "—" }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <!-- SMTP TLS reporting -->
                <div class="shadow-box big-padding mb-4">
                    <h4 class="mb-1">TLS Reporting</h4>
                    <p class="form-text mt-0">
                        SMTP TLS reports arrive in the same mailbox as the DMARC ones and cover a different question:
                        not whether mail authenticated, but whether the sender could negotiate TLS to your MX at all.
                    </p>

                    <div v-if="tls.error" class="text-danger">{{ tls.error }}</div>
                    <div v-else-if="tls.loading" class="text-secondary">Loading…</div>
                    <div v-else-if="!hasTlsData" class="text-secondary">
                        <p class="mb-0">No TLS reports received in this period.</p>
                        <p class="mb-0">
                            These are a separate feed from the DMARC aggregate reports above, requested by an
                            <code>_smtp._tls</code>
                            TXT record, and not every receiver sends them. An empty panel here is normal and says
                            nothing about whether your TLS is healthy.
                        </p>
                    </div>
                    <template v-else>
                        <div class="tls-totals mb-3">
                            <span class="badge rounded-pill" :class="`bg-${tlsRateColor}`">{{ tlsRateText }}</span>
                            <span class="text-secondary">
                                {{ formatNumber(tls.summary.succeeded) }} of
                                {{ formatNumber(tls.summary.sessions) }} sessions negotiated TLS, across
                                {{ formatNumber(tls.summary.reports) }} report(s)
                            </span>
                            <span v-if="tls.summary.lastReport" class="text-secondary">
                                · last report {{ fromNow(tls.summary.lastReport) }}
                            </span>
                        </div>

                        <div v-if="tls.rows.length === 0" class="text-secondary">
                            No failed sessions were reported in this period.
                        </div>
                        <template v-else>
                            <div class="table-wrapper">
                                <table class="table table-borderless table-hover mb-0">
                                    <thead>
                                        <tr>
                                            <th>Result Type</th>
                                            <th>MX Host</th>
                                            <th>Domain</th>
                                            <th class="text-end">Sessions</th>
                                            <th class="text-end">Occurrences</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        <tr
                                            v-for="failure in tls.rows"
                                            :key="tlsRowKey(failure)"
                                            :class="{ 'has-failures': isConfigFault(failure) }"
                                        >
                                            <td
                                                class="nowrap result-type"
                                                :class="{ 'text-danger fw-bold': isConfigFault(failure) }"
                                            >
                                                {{ failure.resultType }}
                                            </td>
                                            <td class="nowrap">
                                                <span v-if="failure.receivingMxHostname">
                                                    {{ failure.receivingMxHostname }}
                                                </span>
                                                <span v-else class="text-secondary">—</span>
                                            </td>
                                            <td class="nowrap">{{ failure.domain }}</td>
                                            <td class="text-end">{{ formatNumber(failure.sessions) }}</td>
                                            <td class="text-end">{{ formatNumber(failure.occurrences) }}</td>
                                        </tr>
                                    </tbody>
                                </table>
                            </div>
                            <p class="form-text mb-0">
                                A result type in red is a configuration fault somebody has to fix — an expired or
                                untrusted certificate, a hostname that does not match, or an MTA-STS or DANE policy that
                                no longer validates. The rest are usually transient: a sender that could not reach you,
                                or one negotiation that failed and succeeded on retry.
                            </p>
                        </template>
                    </template>
                </div>

                <!-- Recent reports -->
                <div class="shadow-box big-padding mb-4">
                    <h4 class="mb-3">Recent Reports</h4>

                    <div v-if="reports.error" class="text-danger">{{ reports.error }}</div>
                    <div v-else-if="reports.loading" class="text-secondary">Loading…</div>
                    <div v-else-if="reports.rows.length === 0" class="text-secondary">
                        No reports received in this period.
                    </div>
                    <div v-else class="table-wrapper">
                        <table class="table table-borderless table-hover mb-0">
                            <thead>
                                <tr>
                                    <th>Reporter</th>
                                    <th>Domain</th>
                                    <th>Period Covered</th>
                                    <th>Policy</th>
                                    <th class="text-end">Messages</th>
                                    <th class="text-end">Passed</th>
                                    <th class="text-end">Failed</th>
                                </tr>
                            </thead>
                            <tbody>
                                <tr v-for="report in reports.rows" :key="report.id">
                                    <td class="nowrap">{{ report.orgName }}</td>
                                    <td class="nowrap">{{ report.domain }}</td>
                                    <td class="nowrap">
                                        {{ unixDate(report.dateBegin) }} – {{ unixDate(report.dateEnd) }}
                                    </td>
                                    <td class="nowrap policy">
                                        <span v-if="report.policy">p={{ report.policy }}</span>
                                        <span v-else class="text-secondary">—</span>
                                    </td>
                                    <td class="text-end">{{ formatNumber(report.messages) }}</td>
                                    <td class="text-end">{{ formatNumber(report.passed) }}</td>
                                    <td class="text-end" :class="{ 'text-danger': report.failed > 0 }">
                                        {{ formatNumber(report.failed) }}
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </template>
        </div>
    </transition>
</template>

<script>
import { BarController, BarElement, Chart, Legend, LinearScale, TimeScale, Tooltip } from "chart.js";
import "chartjs-adapter-dayjs-4";
import { Bar } from "vue-chartjs";
import dayjs from "dayjs";
import DmarcStatusBadge from "../components/DmarcStatusBadge.vue";

Chart.register(BarController, BarElement, TimeScale, LinearScale, Tooltip, Legend);

const numberFormat = new Intl.NumberFormat();

const REPORT_LIMIT = 50;

/**
 * TLS failure result types that are somebody's configuration, not bad luck.
 */
const TLS_CONFIG_FAULTS = new Set([
    "certificate-expired",
    "certificate-host-mismatch",
    "certificate-not-trusted",
    "validation-failure",
    "sts-policy-fetch-error",
    "sts-policy-invalid",
    "sts-webpki-invalid",
    "tlsa-invalid",
    "dnssec-invalid",
    "dane-required",
]);

export default {
    name: "DmarcDetails",

    components: { Bar, DmarcStatusBadge },

    data() {
        return {
            days: 30,

            summary: {
                loading: true,
                error: null,
                domains: [],
            },
            timeline: {
                loading: true,
                error: null,
                points: [],
            },
            sources: {
                loading: true,
                error: null,
                rows: [],
            },
            reports: {
                loading: true,
                error: null,
                rows: [],
            },
            tls: {
                loading: true,
                error: null,
                summary: null,
                rows: [],
            },
        };
    },

    computed: {
        monitorId() {
            return this.$route.params.id;
        },

        monitor() {
            return this.$root.monitorList[this.monitorId];
        },

        monitorName() {
            return this.monitor?.name || "Monitor";
        },

        dmarcConfig() {
            return this.monitor?.dmarcConfig || {};
        },

        /**
         * The one domain this monitor holds reports for.
         * @returns {string|null} Domain name, or null when there is none yet
         */
        domain() {
            return this.dmarcConfig.domain || null;
        },

        /**
         * Whether the monitor is here but has not taken a domain yet.
         * @returns {boolean} True when the monitor has no domain
         */
        unassigned() {
            return Boolean(this.monitor) && !this.domain;
        },

        /**
         * Rows for the per-domain table.
         * @returns {object[]} Summary rows
         */
        summaryRows() {
            return this.summary.domains.filter((row) => row.domain === this.domain);
        },

        /**
         * DMARC status carried by this monitor's latest heartbeat.
         * @returns {string|null} Status string, or null before the first check
         */
        dmarcStatus() {
            const beat = this.$root.lastHeartbeatList[this.monitorId];
            return beat?.dmarcStatus || null;
        },

        /**
         * Everything the panels are keyed on.
         * @returns {string} Reload key
         */
        reloadKey() {
            return `${this.monitorId}|${this.domain}|${this.days}`;
        },

        hasTimelineData() {
            return this.timeline.points.some((point) => point.messages > 0);
        },

        /**
         * Whether any TLS report has arrived for this monitor and period.
         * @returns {boolean} True when there is something to show
         */
        hasTlsData() {
            const summary = this.tls.summary;
            return Boolean(summary) && (summary.reports > 0 || summary.sessions > 0);
        },

        /**
         * Share of reported SMTP sessions that negotiated TLS.
         * @returns {number|null} Success rate in percent, or null when no sessions were reported
         */
        tlsSuccessRate() {
            const summary = this.tls.summary;
            if (!summary || !summary.sessions) {
                return null;
            }
            return (summary.succeeded / summary.sessions) * 100;
        },

        /**
         * Session success rate as a display string.
         * @returns {string} Formatted rate
         */
        tlsRateText() {
            const rate = this.tlsSuccessRate;
            if (rate === null) {
                return "No sessions";
            }
            return `${Math.round(rate * 10) / 10}%`;
        },

        /**
         * Bootstrap colour for the session success rate badge.
         * @returns {string} Bootstrap contextual colour
         */
        tlsRateColor() {
            const rate = this.tlsSuccessRate;
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
         * Start of the selected period, used to decide whether a source is
         * new.
         * @returns {number} Unix timestamp in seconds
         */
        periodStart() {
            return Math.floor(Date.now() / 1000) - this.days * 86400;
        },

        gridColor() {
            return this.$root.theme === "light" ? "rgba(0,0,0,0.1)" : "rgba(255,255,255,0.1)";
        },

        fontColor() {
            return this.$root.theme === "light" ? "rgba(12,12,18,1.0)" : "rgba(220,220,220,1.0)";
        },

        chartData() {
            const labels = this.timeline.points.map((point) => dayjs.unix(point.day).utc().format("YYYY-MM-DD"));

            return {
                datasets: [
                    {
                        label: "Pass",
                        data: this.timeline.points.map((point, index) => ({
                            x: labels[index],
                            y: point.passed,
                        })),
                        backgroundColor: "#5cdd8b",
                        borderWidth: 0,
                        barPercentage: 1,
                        categoryPercentage: 0.9,
                    },
                    {
                        label: "Fail",
                        data: this.timeline.points.map((point, index) => ({
                            x: labels[index],
                            y: point.failed,
                        })),
                        backgroundColor: "#dc3545",
                        borderWidth: 0,
                        barPercentage: 1,
                        categoryPercentage: 0.9,
                    },
                ],
            };
        },

        chartOptions() {
            return {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: "index",
                    intersect: false,
                },
                scales: {
                    x: {
                        type: "time",
                        stacked: true,
                        time: {
                            unit: "day",
                            tooltipFormat: "YYYY-MM-DD",
                            displayFormats: {
                                day: "MM-DD",
                            },
                        },
                        grid: {
                            color: this.gridColor,
                        },
                        ticks: {
                            color: this.fontColor,
                            maxRotation: 0,
                            autoSkipPadding: 20,
                        },
                    },
                    y: {
                        stacked: true,
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: "Messages",
                            color: this.fontColor,
                        },
                        grid: {
                            color: this.gridColor,
                        },
                        ticks: {
                            color: this.fontColor,
                            precision: 0,
                        },
                    },
                },
                plugins: {
                    legend: {
                        display: true,
                        position: "top",
                        align: "start",
                        labels: {
                            color: this.fontColor,
                        },
                    },
                    tooltip: {
                        padding: 10,
                        backgroundColor: this.$root.theme === "light" ? "rgba(212,232,222,1.0)" : "rgba(32,42,38,1.0)",
                        bodyColor: this.fontColor,
                        titleColor: this.fontColor,
                        callbacks: {
                            label: (context) => `${context.dataset.label}: ${numberFormat.format(context.parsed.y)}`,
                        },
                    },
                },
            };
        },
    },

    watch: {
        reloadKey() {
            this.loadAll();
        },
    },

    mounted() {
        this.loadAll();
    },

    methods: {
        /**
         * Refresh every panel.
         * @returns {void}
         */
        loadAll() {
            this.loadSummary();
            this.loadTimeline();
            this.loadSources();
            this.loadReports();
            this.loadTls();
        },

        /**
         * Decide whether a panel can query anything, and leave it in a
         * sensible state when it cannot.
         * @param {object} panel Panel state to update
         * @param {string} key Name of the panel's data property
         * @returns {boolean} True when the panel must not query
         */
        blockPanel(panel, key) {
            if (this.domain) {
                return false;
            }

            panel.loading = !this.monitor;
            panel.error = null;
            panel[key] = [];
            return true;
        },

        /**
         * Fetch the per-domain summary, which drives the totals table.
         * @returns {void}
         */
        loadSummary() {
            if (this.blockPanel(this.summary, "domains")) {
                return;
            }

            this.summary.loading = true;
            this.summary.error = null;

            this.$root.getSocket().emit("getDmarcSummary", this.monitorId, this.days, (res) => {
                this.summary.loading = false;

                if (!res.ok) {
                    this.summary.error = res.msg;
                    this.summary.domains = [];
                    return;
                }

                this.summary.domains = res.data?.domains || [];
            });
        },

        /**
         * Fetch the daily pass/fail buckets behind the chart.
         * @returns {void}
         */
        loadTimeline() {
            if (this.blockPanel(this.timeline, "points")) {
                return;
            }

            this.timeline.loading = true;
            this.timeline.error = null;

            this.$root.getSocket().emit("getDmarcTimeline", this.monitorId, this.domain, this.days, (res) => {
                this.timeline.loading = false;

                if (!res.ok) {
                    this.timeline.error = res.msg;
                    this.timeline.points = [];
                    return;
                }

                this.timeline.points = res.data || [];
            });
        },

        /**
         * Fetch the per-source-IP breakdown.
         * @returns {void}
         */
        loadSources() {
            if (this.blockPanel(this.sources, "rows")) {
                return;
            }

            this.sources.loading = true;
            this.sources.error = null;

            this.$root.getSocket().emit("getDmarcSources", this.monitorId, this.domain, this.days, (res) => {
                this.sources.loading = false;

                if (!res.ok) {
                    this.sources.error = res.msg;
                    this.sources.rows = [];
                    return;
                }

                this.sources.rows = (res.data || []).slice().sort((a, b) => b.messages - a.messages);
            });
        },

        /**
         * Fetch the most recent aggregate reports.
         * @returns {void}
         */
        loadReports() {
            if (this.blockPanel(this.reports, "rows")) {
                return;
            }

            this.reports.loading = true;
            this.reports.error = null;

            this.$root.getSocket().emit("getDmarcReports", this.monitorId, this.domain, REPORT_LIMIT, (res) => {
                this.reports.loading = false;

                if (!res.ok) {
                    this.reports.error = res.msg;
                    this.reports.rows = [];
                    return;
                }

                this.reports.rows = res.data || [];
            });
        },

        /**
         * Fetch the SMTP TLS session totals and the failure breakdown.
         * @returns {void}
         */
        loadTls() {
            if (this.blockPanel(this.tls, "rows")) {
                this.tls.summary = null;
                return;
            }

            this.tls.loading = true;
            this.tls.error = null;

            const socket = this.$root.getSocket();
            const ask = (event) =>
                new Promise((resolve) => {
                    socket.emit(event, this.monitorId, this.domain, this.days, resolve);
                });

            Promise.all([ask("getTlsrptSummary"), ask("getTlsrptFailures")]).then(([summary, failures]) => {
                this.tls.loading = false;

                if (!summary.ok || !failures.ok) {
                    this.tls.error = summary.msg || failures.msg;
                    this.tls.summary = null;
                    this.tls.rows = [];
                    return;
                }

                this.tls.summary = summary.data || null;
                this.tls.rows = (failures.data || []).slice().sort((a, b) => b.sessions - a.sessions);
            });
        },

        /**
         * Whether a TLS failure is a configuration fault rather than bad luck.
         * @param {object} failure Failure row
         * @returns {boolean} True when somebody has to go and fix something
         */
        isConfigFault(failure) {
            return TLS_CONFIG_FAULTS.has(failure.resultType);
        },

        /**
         * A stable key for a TLS failure row.
         * @param {object} failure Failure row
         * @returns {string} Row key
         */
        tlsRowKey(failure) {
            return `${failure.resultType}|${failure.receivingMxHostname}|${failure.domain}`;
        },

        /**
         * Was this source first seen inside the selected period?
         * @param {object} source Source row
         * @returns {boolean} True when the source is new
         */
        isNewSource(source) {
            return Boolean(source.firstSeen) && source.firstSeen >= this.periodStart;
        },

        /**
         * Share of messages that passed DMARC alignment.
         * @param {object} domain Summary row
         * @returns {number|null} Pass rate in percent, or null when nothing was reported
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
         * Format an integer with thousands separators.
         * @param {number} value Value to format
         * @returns {string} Formatted number
         */
        formatNumber(value) {
            return numberFormat.format(value || 0);
        },

        /**
         * Format a count as a percentage of a total.
         * @param {number} value Part
         * @param {number} total Whole
         * @returns {string} Formatted percentage
         */
        formatPercent(value, total) {
            if (!total) {
                return "—";
            }
            return `${Math.round(((value || 0) / total) * 1000) / 10}%`;
        },

        /**
         * Format a unix timestamp as a date in the user's timezone.
         * @param {number} timestamp Unix timestamp in seconds
         * @returns {string} Formatted date
         */
        unixDate(timestamp) {
            return this.$root.unixToDayjs(timestamp).format("YYYY-MM-DD");
        },

        /**
         * Relative time since a unix timestamp.
         * @param {number} timestamp Unix timestamp in seconds
         * @returns {string} Human readable relative time
         */
        fromNow(timestamp) {
            return dayjs.unix(timestamp).fromNow();
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.dmarc-details {
    .header-status {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.5rem;
    }

    .domain-fixed {
        font-weight: bold;
    }

    .chart-wrapper {
        height: 300px;
    }

    // Every table gets its own scroller so the page body never moves sideways.
    .table-wrapper {
        overflow-x: auto;
    }

    table {
        font-size: 14px;
    }

    th {
        white-space: nowrap;
    }

    .nowrap {
        white-space: nowrap;
    }

    .policy,
    .source-ip,
    .result-type {
        font-family: monospace;
    }

    .tls-totals {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 0.5rem;
        font-size: 0.9rem;
    }

    tr.has-failures {
        background-color: rgba(220, 53, 69, 0.06);

        .dark & {
            background-color: rgba(220, 53, 69, 0.13);
        }
    }

    .badge.bg-warning {
        color: $dark-font-color2;
    }
}
</style>
