/**
 * Persistence and aggregation for SMTP TLS reports.
 */
const { R } = require("redbean-node");
const { log } = require("../../src/util");

const DAY = 86400;

/**
 * Persist one per-domain TLS report.
 * @param {number} monitorID Owning monitor
 * @param {object} report One entry from parseTlsReport()
 * @returns {Promise<boolean>} True if stored, false if already known
 */
async function saveReport(monitorID, report) {
    const knex = R.knex;

    const existing = await knex("tlsrpt_report")
        .where({
            monitor_id: monitorID,
            org_name: report.orgName,
            report_id: report.reportId,
            domain: report.domain,
        })
        .first("id");
    if (existing) {
        return false;
    }

    try {
        await knex.transaction(async (trx) => {
            const inserted = await trx("tlsrpt_report").insert({
                monitor_id: monitorID,
                org_name: report.orgName,
                report_id: report.reportId,
                contact_info: report.contactInfo,
                domain: report.domain,
                date_begin: report.dateBegin,
                date_end: report.dateEnd,
                policy_type: report.policyType,
                success_count: report.successCount,
                failure_count: report.failureCount,
                ingested_at: Math.floor(Date.now() / 1000),
            });
            const reportRowID = Array.isArray(inserted) ? inserted[0] : inserted;

            const rows = report.failures.map((f) => ({
                tlsrpt_report_id: reportRowID,
                result_type: f.resultType,
                sending_mta_ip: f.sendingMtaIp,
                receiving_mx_hostname: f.receivingMxHostname,
                receiving_ip: f.receivingIp,
                failed_session_count: f.failedSessionCount,
            }));
            if (rows.length) {
                await trx.batchInsert("tlsrpt_failure", rows, 100);
            }
        });
        return true;
    } catch (e) {
        if (/UNIQUE|Duplicate entry|constraint/i.test(String(e.message))) {
            log.debug("tlsrpt", `Report ${report.orgName}/${report.reportId} for ${report.domain} already stored`);
            return false;
        }
        throw e;
    }
}

/**
 * Session totals for a domain over a window.
 * @param {number} monitorID Owning monitor
 * @param {string|null} domain Restrict to one domain, or null for all
 * @param {number} days Window size in days
 * @returns {Promise<object>} sessions, succeeded, failed, reports and lastReport
 */
async function getSummary(monitorID, domain, days = 30) {
    const since = Math.floor(Date.now() / 1000) - days * DAY;

    const q = R.knex("tlsrpt_report")
        .where("monitor_id", monitorID)
        .where("date_end", ">=", since);
    if (domain) {
        q.where("domain", domain);
    }

    const rows = await q
        .sum({ succeeded: "success_count" })
        .sum({ failed: "failure_count" })
        .count({ reports: "id" })
        .max({ lastReport: "date_end" });

    const succeeded = Number(rows[0].succeeded) || 0;
    const failed = Number(rows[0].failed) || 0;
    return {
        sessions: succeeded + failed,
        succeeded,
        failed,
        reports: Number(rows[0].reports) || 0,
        lastReport: Number(rows[0].lastReport) || 0,
    };
}

/**
 * Failures grouped by what went wrong and where.
 * @param {number} monitorID Owning monitor
 * @param {string|null} domain Restrict to one domain, or null for all
 * @param {number} days Window size in days
 * @returns {Promise<object[]>} Failure groups, worst first
 */
async function getFailures(monitorID, domain, days = 30) {
    const since = Math.floor(Date.now() / 1000) - days * DAY;

    const q = R.knex("tlsrpt_failure as f")
        .join("tlsrpt_report as r", "r.id", "f.tlsrpt_report_id")
        .where("r.monitor_id", monitorID)
        .where("r.date_end", ">=", since);
    if (domain) {
        q.where("r.domain", domain);
    }

    const rows = await q
        .groupBy("f.result_type", "f.receiving_mx_hostname", "r.domain")
        .select("f.result_type", "f.receiving_mx_hostname", "r.domain")
        .sum({ sessions: "f.failed_session_count" })
        .count({ occurrences: "f.id" });

    return rows
        .map((r) => ({
            resultType: r.result_type,
            receivingMxHostname: r.receiving_mx_hostname || "",
            domain: r.domain,
            sessions: Number(r.sessions) || 0,
            occurrences: Number(r.occurrences) || 0,
        }))
        .sort((a, b) => b.sessions - a.sessions);
}

/**
 * Every domain that has ever sent a TLS report, with its newest.
 * @param {number} monitorID Owning monitor
 * @returns {Promise<object[]>} Domains with their newest report timestamp
 */
async function getKnownDomains(monitorID) {
    const rows = await R.knex("tlsrpt_report")
        .where("monitor_id", monitorID)
        .groupBy("domain")
        .select("domain")
        .max({ lastReport: "date_end" });

    return rows.map((r) => ({ domain: r.domain,
        lastReport: Number(r.lastReport) || 0 }));
}

/**
 * Drop reports older than the retention window.
 * @param {number} monitorID Owning monitor
 * @param {number} retentionDays Days to keep; 0 disables pruning
 * @returns {Promise<number>} Reports removed
 */
async function prune(monitorID, retentionDays) {
    if (!retentionDays || retentionDays <= 0) {
        return 0;
    }
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * DAY;
    const removed = await R.knex("tlsrpt_report")
        .where("monitor_id", monitorID)
        .where("date_end", "<", cutoff)
        .delete();
    if (removed) {
        log.info("tlsrpt", `Pruned ${removed} TLS report(s) older than ${retentionDays} days`);
    }
    return removed;
}

module.exports = {
    saveReport,
    getSummary,
    getFailures,
    getKnownDomains,
    prune,
};
