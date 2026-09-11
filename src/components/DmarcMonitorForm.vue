<template>
    <div class="dmarc-monitor-form">
        <h2 class="mb-2">Domain</h2>

        <p class="form-text mt-0">
            Every DMARC monitor watches exactly one domain and reads the mailbox itself, which is what lets each domain
            go up and down on its own. There is no separate mailbox monitor doing the ingesting on everyone else's
            behalf, so every monitor in the list is a domain somebody cares about rather than plumbing.
        </p>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-domain" class="form-label">Domain</label>
                    <input
                        id="dmarc-domain"
                        v-model.trim="config.domain"
                        type="text"
                        class="form-control"
                        placeholder="example.com"
                        @change="normalizeDomain"
                    />
                    <div class="form-text">
                        The domain this monitor watches, as it appears in the reports. Leave it blank and the first
                        check adopts the first domain found in the mailbox: the monitor you just created becomes that
                        domain's monitor, rather than creating a second one for it and staying behind as a leftover with
                        nothing to watch.
                    </div>
                </div>
            </div>
        </div>

        <h2 class="mt-5 mb-2">Mailbox</h2>

        <p class="form-text mt-0">
            Aggregate reports are read straight out of an IMAP mailbox. Point the
            <code>rua=</code>
            address of your
            <code>_dmarc</code>
            record at an inbox that lands here. Every monitor opens its own connection, and reports arrive about once a
            day, so the check interval should be an hour or more.
        </p>

        <div class="my-3">
            <label for="dmarc-imap-host" class="form-label">IMAP Host</label>
            <input
                id="dmarc-imap-host"
                v-model="config.imap.host"
                type="text"
                class="form-control"
                placeholder="imap.example.com"
                required
            />
        </div>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-imap-port" class="form-label">IMAP Port</label>
                    <input
                        id="dmarc-imap-port"
                        v-model.number="config.imap.port"
                        type="number"
                        class="form-control"
                        required
                        min="1"
                        max="65535"
                        step="1"
                    />
                </div>
            </div>
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-imap-folder" class="form-label">Folder</label>
                    <input id="dmarc-imap-folder" v-model="config.imap.folder" type="text" class="form-control" />
                    <div class="form-text">
                        Which mailbox folder to read, normally
                        <code>INBOX</code>
                        or a subfolder such as
                        <code>INBOX/DMARC</code>
                    </div>
                </div>
            </div>
        </div>

        <div class="my-3 form-check">
            <input id="dmarc-imap-secure" v-model="config.imap.secure" class="form-check-input" type="checkbox" />
            <label class="form-check-label" for="dmarc-imap-secure">Use TLS</label>
            <div class="form-text">
                Implicit TLS, normally on port 993. Turn this off for a plain connection upgraded with STARTTLS,
                normally on port 143.
            </div>
        </div>

        <div class="my-3 form-check">
            <input
                id="dmarc-imap-ignore-tls"
                v-model="config.imap.ignoreTls"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="dmarc-imap-ignore-tls">Ignore TLS Error</label>
            <div class="form-text">
                Accept self-signed or mismatched certificates. Only enable this for a mail server you control.
            </div>
        </div>

        <div class="my-3">
            <label for="dmarc-imap-username" class="form-label">Username</label>
            <input
                id="dmarc-imap-username"
                v-model="config.imap.username"
                type="text"
                class="form-control"
                autocomplete="off"
            />
        </div>

        <div class="my-3">
            <label for="dmarc-imap-password" class="form-label">Password</label>
            <input
                id="dmarc-imap-password"
                v-model="config.imap.password"
                type="password"
                class="form-control"
                autocomplete="new-password"
                placeholder="Unchanged"
            />
            <div class="form-text">
                Leave this blank to keep the password that is already saved. The stored password is never sent back to
                the browser, so an empty field means "unchanged" rather than "no password".
            </div>
        </div>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-initial-days" class="form-label">Initial Backfill (days)</label>
                    <input
                        id="dmarc-initial-days"
                        v-model.number="config.initialDays"
                        type="number"
                        class="form-control"
                        min="1"
                        step="1"
                    />
                    <div class="form-text">
                        How far back to read when there is no position to resume from. Saving this
                        monitor clears that position, so a save rescans the mailbox from this date -
                        which is also how a domain added since the last run gets picked up.
                        Re-reading is safe: reports are de-duplicated.
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-max-messages" class="form-label">Max Messages Per Run</label>
                    <input
                        id="dmarc-max-messages"
                        v-model.number="config.maxMessagesPerRun"
                        type="number"
                        class="form-control"
                        min="1"
                        step="1"
                    />
                    <div class="form-text">
                        Caps how many messages one check will fetch, so a large backlog is worked through over several
                        runs instead of one very long one.
                    </div>
                </div>
            </div>
        </div>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-retention-days" class="form-label">Retention (days)</label>
                    <input
                        id="dmarc-retention-days"
                        v-model.number="config.retentionDays"
                        type="number"
                        class="form-control"
                        min="0"
                        step="1"
                    />
                    <div class="form-text">
                        How long parsed reports are kept. Set to 0 to keep everything forever. Only this monitor's own
                        domain is stored here, so this governs the history behind its DMARC page.
                    </div>
                </div>
            </div>
        </div>

        <h2 class="mt-5 mb-2">Automatic Domain Monitors</h2>

        <div class="my-3 form-check">
            <input id="dmarc-auto-deploy" v-model="config.autoDeploy" class="form-check-input" type="checkbox" />
            <label class="form-check-label" for="dmarc-auto-deploy">Create a monitor for every other domain</label>
            <div class="form-text">
                Creates a monitor for every other domain found in the mailbox, copying the IMAP settings above so each
                one reads the mailbox for itself, and keeps creating them as new domains appear. Each new monitor
                inherits this monitor's notification channels, so a newly discovered domain is watched and not silent.
                Nothing is ever removed automatically: a monitor for a domain that stops reporting is exactly what the
                staleness alert needs, so deleting one is left to you.
            </div>
        </div>

        <div v-if="config.autoDeploy && !config.domain" class="alert alert-warning" role="alert">
            This monitor has no domain yet, so it will adopt one on its first check — and with auto deploy on it renames
            itself to the prefix plus that domain. Turn auto deploy off to keep the name you chose.
        </div>

        <div class="my-3">
            <label for="dmarc-auto-deploy-prefix" class="form-label">Monitor Name Prefix</label>
            <input
                id="dmarc-auto-deploy-prefix"
                v-model="config.autoDeployPrefix"
                type="text"
                class="form-control"
                :disabled="!config.autoDeploy"
            />
            <div class="form-text">
                Put in front of the domain to name each created monitor:
                <code>DMARC:&nbsp;</code>
                gives
                <code>DMARC: example.com</code>
            </div>
        </div>

        <h2 class="mt-5 mb-2">Alerting</h2>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-window-days" class="form-label">Evaluation Window (days)</label>
                    <input
                        id="dmarc-window-days"
                        v-model.number="config.windowDays"
                        type="number"
                        class="form-control"
                        min="1"
                        step="1"
                    />
                    <div class="form-text">
                        How far back the alert rules and the DMARC dashboard look. Reports usually arrive once a day, so
                        anything under a week is very noisy.
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-stale-days" class="form-label">Stale Report Threshold (days)</label>
                    <input
                        id="dmarc-stale-days"
                        v-model.number="config.staleDays"
                        type="number"
                        class="form-control"
                        min="0"
                        step="1"
                    />
                    <div class="form-text">
                        Alert if a domain sends no report for this many days — catches a broken
                        <code>_dmarc</code>
                        record.
                    </div>
                </div>
            </div>
        </div>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-fail-rate" class="form-label">Failure Rate Threshold (%)</label>
                    <input
                        id="dmarc-fail-rate"
                        v-model="failRatePercent"
                        type="number"
                        class="form-control"
                        min="0"
                        step="0.1"
                    />
                    <div class="form-text">
                        Go down when more than this share of a domain's messages fail DMARC alignment in the evaluation
                        window.
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-min-failures" class="form-label">Minimum Failures</label>
                    <input
                        id="dmarc-min-failures"
                        v-model.number="config.minFailures"
                        type="number"
                        class="form-control"
                        min="0"
                        step="1"
                    />
                    <div class="form-text">
                        Ignore the failure rate unless at least this many messages failed, so low-volume domains don't
                        cry wolf.
                    </div>
                </div>
            </div>
        </div>

        <div class="my-3 form-check">
            <input
                id="dmarc-alert-new-source"
                v-model="config.alertOnNewSource"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="dmarc-alert-new-source">Alert on new sending source</label>
            <div class="form-text">
                Alert the first time an IP that has never been seen before sends mail as one of your domains. This is
                the spoofing signal.
            </div>
        </div>

        <div class="my-3 form-check">
            <input
                id="dmarc-alert-disposition"
                v-model="config.alertOnDisposition"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="dmarc-alert-disposition">Alert on quarantine or reject</label>
            <div class="form-text">
                Alert when a receiver actually applied your policy to a message, meaning real mail was held back or
                dropped.
            </div>
        </div>

        <h5 class="mt-4 mb-2">SMTP TLS Reporting</h5>

        <p class="form-text mt-0">
            TLS reports arrive in the same mailbox as the DMARC ones and cover the same domain, so the same monitor
            judges both. Where DMARC says whether mail authenticated, these say whether senders could negotiate TLS to
            you at all — a failure here means mail was delivered in the clear or not delivered.
        </p>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-tls-fail-rate" class="form-label">TLS Failure Rate Threshold (%)</label>
                    <input
                        id="dmarc-tls-fail-rate"
                        v-model="tlsFailRatePercent"
                        type="number"
                        class="form-control"
                        min="0"
                        step="0.1"
                    />
                    <div class="form-text">
                        Go down when more than this share of reported sessions failed to negotiate TLS. TLS reporting is
                        noisier than DMARC — a single misconfigured sender retrying is normal — so this sits higher than
                        the DMARC failure rate above.
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="my-3">
                    <label for="dmarc-tls-min-failures" class="form-label">Minimum TLS Failures</label>
                    <input
                        id="dmarc-tls-min-failures"
                        v-model.number="config.tlsMinFailures"
                        type="number"
                        class="form-control"
                        min="0"
                        step="1"
                    />
                    <div class="form-text">
                        Ignore the TLS failure rate unless at least this many sessions failed, so a domain that receives
                        a handful of messages a week does not alert on one of them.
                    </div>
                </div>
            </div>
        </div>

        <div class="my-3 form-check">
            <input
                id="dmarc-alert-tls-cert"
                v-model="config.alertOnTlsCertProblem"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="dmarc-alert-tls-cert">Alert on certificate and policy problems</label>
            <div class="form-text">
                Alert regardless of the rate when a report names an expired certificate, a hostname mismatch, an
                untrusted chain, or an MTA-STS or DANE policy that no longer validates. Those are configuration faults
                on your side that someone has to fix, not the transient failures the rate threshold is for.
            </div>
        </div>

        <h2 class="mt-5 mb-2">Notifications</h2>

        <p class="form-text mt-0">
            Every status notifies except one, and there is nothing to choose here. Mail loss, spoofing and a
            certificate problem take the monitor down. A failing TLS rate, reports going stale, a rising failure rate
            and no reports at all leave it amber, because the domain is not down &mdash; Uptime Kuma would never notify
            on those, so this monitor sends them itself.
        </p>

        <p class="form-text mt-0">
            <strong>An unreadable mailbox is the exception.</strong> It goes amber and says nothing. That the mail
            server is unreachable is a fact about the mail server, which will have a monitor of its own; repeating it
            here would page you twice for one outage. The reports simply resume when the mailbox answers again.
        </p>

        <div class="my-3 form-check">
            <input
                id="dmarc-notify-status-change"
                v-model="config.notifyOnStatusChange"
                class="form-check-input"
                type="checkbox"
            />
            <label class="form-check-label" for="dmarc-notify-status-change">
                Notify whenever the DMARC status changes
            </label>
            <div class="form-text">
                Uptime Kuma only reports a monitor crossing between up and down, so one problem turning into a different
                problem — spoofing becoming mail loss — would pass unmentioned even though it needs a different
                response. With this on, the monitor sends its own message for a status change Uptime Kuma would not have
                reported. That includes a change between two unticked statuses, so those are quieter than the ticked
                ones rather than completely silent.
            </div>
        </div>
    </div>
</template>

<script>

/**
 * The statuses worth offering as alerts, most severe first.
 */

/**
 * Statuses that notify unless the operator says otherwise.
 */

const DEFAULT_CONFIG = {
    domain: "",
    autoDeploy: false,
    autoDeployPrefix: "DMARC: ",
    imap: {
        host: "",
        port: 993,
        secure: true,
        ignoreTls: false,
        username: "",
        password: "",
        folder: "INBOX",
    },
    windowDays: 30,
    retentionDays: 365,
    initialDays: 30,
    maxMessagesPerRun: 500,
    failRateThreshold: 0.02,
    minFailures: 5,
    alertOnNewSource: true,
    alertOnDisposition: true,
    staleDays: 7,
    tlsFailRateThreshold: 0.05,
    tlsMinFailures: 5,
    alertOnTlsCertProblem: true,
    notifyOnStatusChange: true,
};

/**
 * Fold a domain to the form the reports use.
 * @param {*} value Domain as typed or as stored
 * @returns {string} Domain in its canonical form
 */
function canonicalDomain(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Fill in every setting the stored config is missing.
 * @param {object|null|undefined} raw Stored dmarcConfig, if any
 * @returns {object} Config with defaults applied
 */
function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    return {
        ...DEFAULT_CONFIG,
        ...source,
        domain: canonicalDomain(source.domain),
        imap: {
            ...DEFAULT_CONFIG.imap,
            ...(source.imap && typeof source.imap === "object" ? source.imap : {}),
        },
    };
}

export default {
    name: "DmarcMonitorForm",

    props: {
        /** The monitor being edited */
        modelValue: {
            type: Object,
            required: true,
        },
    },

    emits: ["update:modelValue"],

    data() {
        return {
            config: normalizeConfig(this.modelValue.dmarcConfig),
        };
    },

    computed: {
        /**
         * The statuses the notification checkboxes cover.
         * @returns {string[]} Status strings, most severe first
         */

        /**
         * The failure rate threshold as a percentage.
         * @returns {number} Threshold in percent
         */
        failRatePercent: {
            get() {
                const value = Number(this.config.failRateThreshold);
                if (!Number.isFinite(value)) {
                    return 0;
                }
                // Avoid 0.02 * 100 turning into 2.0000000000000004
                return Math.round(value * 10000) / 100;
            },
            set(value) {
                const percent = parseFloat(value);
                this.config.failRateThreshold = Number.isFinite(percent) ? percent / 100 : 0;
            },
        },

        /**
         * The SMTP TLS failure rate threshold as a percentage.
         * @returns {number} Threshold in percent
         */
        tlsFailRatePercent: {
            get() {
                const value = Number(this.config.tlsFailRateThreshold);
                if (!Number.isFinite(value)) {
                    return 0;
                }
                // Avoid 0.05 * 100 turning into 5.000000000000001
                return Math.round(value * 10000) / 100;
            },
            set(value) {
                const percent = parseFloat(value);
                this.config.tlsFailRateThreshold = Number.isFinite(percent) ? percent / 100 : 0;
            },
        },
    },

    watch: {
        config: {
            deep: true,
            handler() {
                this.emitConfig();
            },
        },

        "modelValue.dmarcConfig"(newConfig) {
            if (newConfig && newConfig !== this.config) {
                this.config = normalizeConfig(newConfig);
            }
        },
    },

    created() {
        this.emitConfig();
    },

    methods: {
        /**
         * Fold the typed domain to the form the reports use, once the field is
         * done being edited rather than on every keystroke.
         * @returns {void}
         */
        normalizeDomain() {
            this.config.domain = canonicalDomain(this.config.domain);
        },

        /**
         * Hand the current config back to the parent's v-model.
         * @returns {void}
         */
        emitConfig() {
            this.$emit("update:modelValue", {
                ...this.modelValue,
                dmarcConfig: this.config,
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.dmarc-monitor-form {
    .form-text code {
        word-break: break-word;
    }

}
</style>
