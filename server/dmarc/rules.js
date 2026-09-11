/**
 * Turning report data into an up/down verdict.
 */

const { CERTIFICATE_FAILURES, POLICY_FAILURES } = require("../tlsrpt/parser");

const DAY = 86400;

/** Failure types that mean someone has to change a configuration. */
const CERT_LIKE = new Set([ ...CERTIFICATE_FAILURES, ...POLICY_FAILURES ]);

const DEFAULTS = {
    windowDays: 30,
    tlsFailRateThreshold: 0.05,
    tlsMinFailures: 5,
    alertOnTlsCertProblem: true,
    failRateThreshold: 0.02,
    minFailures: 5,
    alertOnNewSource: true,
    alertOnDisposition: true,
    staleDays: 7,
    // 0 means no limit.
    maxAlerts: 0,
};

/**
 * Fill in defaults for any setting the monitor didn't specify.
 * @param {object} config Raw config from the monitor
 * @returns {object} Config with defaults applied
 */
function withDefaults(config) {
    return { ...DEFAULTS,
        ...(config || {}) };
}

/**
 * Evaluate the alert rules.
 * @param {object} input Aggregated inputs
 * @param {object[]} input.domains Per-domain summary for the window
 * @param {object} input.sourcesByDomain Domain to source rows
 * @param {object[]} input.knownDomains Every domain ever seen, with its newest report
 * @param {object} input.config Monitor config
 * @param {number} input.now Current unix time in seconds
 * @param {boolean} input.baselined Whether a first ingest has already happened
 * @param {object} input.tls SMTP TLS data: summary and failures, or null
 * @returns {object[]} Alerts, most severe first
 */
function evaluate({ domains, sourcesByDomain, knownDomains, config, now, baselined, tls }) {
    const cfg = withDefaults(config);
    const alerts = [];
    const windowStart = now - cfg.windowDays * DAY;

    for (const d of domains) {
        if (d.messages > 0 && d.failed >= cfg.minFailures) {
            const rate = d.failed / d.messages;
            if (rate > cfg.failRateThreshold) {
                alerts.push({
                    rule: "fail-rate",
                    domain: d.domain,
                    severity: 2,
                    message: `${d.domain}: ${(rate * 100).toFixed(1)}% DMARC failures (${d.failed} of ${d.messages} messages)`,
                });
            }
        }

        const sources = sourcesByDomain[d.domain] || [];

        if (cfg.alertOnDisposition) {
            const rejected = sources.reduce((n, s) => n + s.rejected, 0);
            const quarantined = sources.reduce((n, s) => n + s.quarantined, 0);
            if (rejected > 0) {
                alerts.push({
                    rule: "rejected",
                    domain: d.domain,
                    severity: 3,
                    message: `${d.domain}: ${rejected} message(s) rejected by receivers`,
                });
            }
            if (quarantined > 0) {
                alerts.push({
                    rule: "quarantined",
                    domain: d.domain,
                    severity: 3,
                    message: `${d.domain}: ${quarantined} message(s) quarantined by receivers`,
                });
            }
        }

        if (cfg.alertOnNewSource && baselined) {
            const fresh = sources
                .filter((s) => s.failed > 0 && s.firstSeen >= windowStart)
                .sort((a, b) => b.failed - a.failed);

            for (const s of fresh.slice(0, 5)) {
                alerts.push({
                    rule: "new-source",
                    domain: d.domain,
                    severity: 3,
                    message: `${d.domain}: new source ${s.sourceIp} failing DMARC (${s.failed} message(s))`,
                });
            }
            if (fresh.length > 5) {
                alerts.push({
                    rule: "new-source",
                    domain: d.domain,
                    severity: 2,
                    message: `${d.domain}: ${fresh.length - 5} further new failing source(s)`,
                });
            }
        }
    }

    if (cfg.staleDays > 0) {
        for (const k of knownDomains) {
            const ageDays = Math.floor((now - k.lastReport) / DAY);
            if (ageDays > cfg.staleDays) {
                alerts.push({
                    rule: "stale",
                    domain: k.domain,
                    severity: 3,
                    message: `${k.domain}: no report received in ${ageDays} days (check the _dmarc record)`,
                });
            }
        }
    }

    if (tls && tls.summary) {
        const { sessions, failed } = tls.summary;
        const failures = tls.failures || [];

        if (cfg.alertOnTlsCertProblem) {
            const bad = failures.filter((f) => CERT_LIKE.has(f.resultType));
            for (const failure of bad.slice(0, 3)) {
                alerts.push({
                    rule: "tls-cert",
                    domain: failure.domain,
                    severity: 3,
                    message: `${failure.domain}: ${failure.resultType} on ${failure.receivingMxHostname || "an MX host"} (${failure.sessions} session(s))`,
                });
            }
        }

        if (sessions > 0 && failed >= cfg.tlsMinFailures) {
            const rate = failed / sessions;
            if (rate > cfg.tlsFailRateThreshold) {
                alerts.push({
                    rule: "tls-failure",
                    domain: tls.domain || "",
                    severity: 2,
                    message: `${tls.domain || "TLS"}: ${(rate * 100).toFixed(1)}% of sessions failed TLS (${failed} of ${sessions})`,
                });
            }
        }
    }

    alerts.sort((a, b) => b.severity - a.severity);
    return cfg.maxAlerts > 0 ? alerts.slice(0, cfg.maxAlerts) : alerts;
}

/**
 * One-line description of the current state, used as the heartbeat message.
 * @param {object[]} domains Per-domain summary
 * @param {object[]} alerts Alerts from evaluate()
 * @param {number} ingested Number of new reports stored this run
 * @returns {string} Heartbeat message
 */
function summarise(domains, alerts, ingested) {
    const messages = domains.reduce((n, d) => n + d.messages, 0);
    const passed = domains.reduce((n, d) => n + d.passed, 0);
    const rate = messages ? (100 * passed / messages).toFixed(2) : "100.00";
    const ingestedPart = ingested ? `, +${ingested} new report(s)` : "";

    if (alerts.length) {
        const shown = alerts.slice(0, 3).map((a) => a.message).join("; ");
        const more = alerts.length > 3 ? ` (+${alerts.length - 3} more)` : "";
        return `${shown}${more}`;
    }
    return `${domains.length} domain(s), ${messages} message(s), ${rate}% DMARC pass${ingestedPart}`;
}

module.exports = {
    evaluate,
    summarise,
    withDefaults,
    DEFAULTS,
};
