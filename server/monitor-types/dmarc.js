const { MonitorType } = require("./monitor-type");
const { log } = require("../../src/util");
const dayjs = require("dayjs");

const { fetchDocuments } = require("../dmarc/imap");
const { parseAggregateReport, looksLikeDmarc } = require("../dmarc/parser");
const { parseTlsReport, looksLikeTlsReport } = require("../tlsrpt/parser");
const { parseConfig, parseState } = require("../dmarc/config");
const { evaluate, summarise } = require("../dmarc/rules");
const { deployMissingDomains, adoptDomain } = require("../dmarc/autodeploy");
const { previousStatuses, maybeNotify } = require("../dmarc/notify");
const dmarcStatus = require("../dmarc/status");
const { formatStatusPrefix } = require("../../src/monitor-status");
const store = require("../dmarc/store");
const tlsStore = require("../tlsrpt/store");

/**
 * DMARC monitor type.
 */
class DmarcMonitorType extends MonitorType {
    name = "dmarc";

    allowCustomStatus = true;

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        const startTime = dayjs().valueOf();
        let config = parseConfig(monitor.dmarc_config);
        const previousState = parseState(monitor.dmarc_state);
        const now = Math.floor(Date.now() / 1000);

        // Read before the beat is written, so it describes the previous one.
        const context = await previousStatuses(monitor.id);

        const baselined = !!previousState.baselined;

        let ingested = 0;
        let deferred = 0;
        const domainsSeen = new Set();
        const dmarcReports = [];
        const tlsReports = [];

        try {
            const { documents, newState, stats } = await fetchDocuments(config, previousState);
            deferred = stats.skipped;

            for (const doc of documents) {
                if (looksLikeDmarc(doc)) {
                    const report = parseAggregateReport(doc);
                    if (report) {
                        domainsSeen.add(report.domain);
                        dmarcReports.push(report);
                    }
                } else if (looksLikeTlsReport(doc)) {
                    for (const report of parseTlsReport(doc)) {
                        domainsSeen.add(report.domain);
                        tlsReports.push(report);
                    }
                }
            }

            if (!config.domain && domainsSeen.size) {
                config = await adoptDomain(monitor, config, [ ...domainsSeen ].sort()[0]);
            }

            for (const report of dmarcReports) {
                if (report.domain === config.domain && (await store.saveReport(monitor.id, report))) {
                    ingested++;
                }
            }
            for (const report of tlsReports) {
                if (report.domain === config.domain && (await tlsStore.saveReport(monitor.id, report))) {
                    ingested++;
                }
            }

            await store.saveState(monitor, { ...newState,
                baselined: true });
        } catch (e) {
            heartbeat.ping = dayjs().valueOf() - startTime;
            this.applyStatus(heartbeat, dmarcStatus.INGEST_ERROR, `Could not read the mailbox: ${e.message}`, config);
            await this.notifyOnChange(monitor, heartbeat, context, dmarcStatus.INGEST_ERROR, config);
            return;
        }

        if (config.retentionDays > 0) {
            await store.prune(monitor.id, config.retentionDays);
            await tlsStore.prune(monitor.id, config.retentionDays);
        }

        let deployed = [];
        if (config.autoDeploy) {
            const others = [ ...domainsSeen ].filter((d) => d !== config.domain);
            deployed = await deployMissingDomains(monitor, config, others, server);
        }

        heartbeat.ping = dayjs().valueOf() - startTime;

        if (!config.domain) {
            this.applyStatus(
                heartbeat,
                dmarcStatus.NO_DATA,
                "No domain set, and no reports in the mailbox to adopt one from",
                config
            );
            await this.notifyOnChange(monitor, heartbeat, context, dmarcStatus.NO_DATA, config);
            return;
        }

        const domains = (await store.getDomainSummary(monitor.id, config.windowDays))
            .filter((d) => d.domain === config.domain);
        const knownDomains = await store.getKnownDomains(monitor.id);
        const sourcesByDomain = {
            [config.domain]: await store.getSources(monitor.id, config.domain, config.windowDays),
        };
        const tls = {
            domain: config.domain,
            summary: await tlsStore.getSummary(monitor.id, config.domain, config.windowDays),
            failures: await tlsStore.getFailures(monitor.id, config.domain, config.windowDays),
        };

        const alerts = evaluate({ domains,
            sourcesByDomain,
            knownDomains,
            config,
            now,
            baselined,
            tls });

        const hasData = knownDomains.length > 0 || tls.summary.reports > 0;
        const status = dmarcStatus.deriveStatus(alerts, hasData);

        let msg = summarise(domains, alerts, ingested);
        if (deployed.length) {
            msg += `, deployed ${deployed.length} new monitor(s): ${deployed.join(", ")}`;
        }
        if (deferred) {
            msg += `, ${deferred} message(s) deferred to the next check`;
        }

        this.applyStatus(heartbeat, status, msg, config);
        await this.notifyOnChange(monitor, heartbeat, context, status, config);
    }

    /**
     * Record the outcome on the heartbeat.
     * @param {object} heartbeat Heartbeat to update
     * @param {string} status DMARC status
     * @param {string} msg Human readable message
     * @param {object} config Monitor config
     * @returns {void}
     */
    applyStatus(heartbeat, status, msg, config) {
        heartbeat.dmarc_status = status;
        heartbeat.status = dmarcStatus.toHeartbeatStatus(status);
        heartbeat.msg = `${formatStatusPrefix("dmarc", status)}${msg}`;
    }

    /**
     * Notify on a status change Kuma would not report itself.
     * @param {object} monitor Monitor bean
     * @param {object} heartbeat Heartbeat for this beat
     * @param {object} context Result of previousStatuses()
     * @param {string} status The status just decided
     * @param {object} config Monitor config
     * @returns {Promise<void>} Promise
     */
    async notifyOnChange(monitor, heartbeat, context, status, config) {
        await maybeNotify(monitor, heartbeat, {
            ...context,
            status,
            enabled: config.notifyOnStatusChange !== false,
            // A mailbox that cannot be read says nothing about the domain, and
            // whatever made it unreachable has a monitor of its own. Coming
            // back from one is not news either.
            isSilent: dmarcStatus.isSilent(status)
                || (dmarcStatus.isSilent(context.previousStatus) && status === dmarcStatus.OK),
        });
        if (log.debug) {
            log.debug("dmarc", `[${monitor.name}] ${status}`);
        }
    }
}

module.exports = {
    DmarcMonitorType,
};
