/**
 * Persistence and aggregation for DMARC reports.
 */
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { recordPassed } = require("./parser");

const DAY = 86400;

/**
 * Persist one parsed report.
 * @param {number} monitorID Owning monitor
 * @param {object} report Report from parseAggregateReport()
 * @returns {Promise<boolean>} True if stored, false if already known
 */
async function saveReport(monitorID, report) {
    const knex = R.knex;

    const existing = await knex("dmarc_report")
        .where({
            monitor_id: monitorID,
            org_name: report.orgName,
            report_id: report.reportId,
        })
        .first("id");
    if (existing) {
        return false;
    }

    let messageCount = 0;
    let passCount = 0;
    for (const rec of report.records) {
        messageCount += rec.count;
        if (recordPassed(rec)) {
            passCount += rec.count;
        }
    }

    try {
        await knex.transaction(async (trx) => {
            const inserted = await trx("dmarc_report").insert({
                monitor_id: monitorID,
                org_name: report.orgName,
                report_id: report.reportId,
                domain: report.domain,
                date_begin: report.dateBegin,
                date_end: report.dateEnd,
                policy_p: report.policy.p,
                policy_sp: report.policy.sp,
                policy_pct: report.policy.pct,
                policy_adkim: report.policy.adkim,
                policy_aspf: report.policy.aspf,
                message_count: messageCount,
                pass_count: passCount,
                fail_count: messageCount - passCount,
                ingested_at: Math.floor(Date.now() / 1000),
            });

            const reportRowID = Array.isArray(inserted) ? inserted[0] : inserted;

            const rows = report.records.map((rec) => ({
                dmarc_report_id: reportRowID,
                source_ip: rec.sourceIp,
                count: rec.count,
                disposition: rec.disposition,
                dkim_aligned: rec.dkimAligned,
                spf_aligned: rec.spfAligned,
                header_from: rec.headerFrom,
                dkim_domains: rec.dkimResults.map((d) => `${d.domain}=${d.result}`).join(",").slice(0, 512),
                spf_domains: rec.spfResults.map((s) => `${s.domain}=${s.result}`).join(",").slice(0, 512),
            }));

            if (rows.length) {
                await trx.batchInsert("dmarc_record", rows, 100);
            }
        });
        return true;
    } catch (e) {
        if (/UNIQUE|Duplicate entry|constraint/i.test(String(e.message))) {
            log.debug("dmarc", `Report ${report.orgName}/${report.reportId} already stored`);
            return false;
        }
        throw e;
    }
}

/**
 * Per-domain totals over a window, for the overview.
 * @param {number} monitorID Owning monitor
 * @param {number} days Window size in days
 * @returns {Promise<object[]>} One entry per domain, busiest first
 */
async function getDomainSummary(monitorID, days = 30) {
    const since = Math.floor(Date.now() / 1000) - days * DAY;

    const rows = await R.knex("dmarc_report")
        .where("monitor_id", monitorID)
        .where("date_end", ">=", since)
        .groupBy("domain")
        .select("domain")
        .sum({ messages: "message_count" })
        .sum({ passed: "pass_count" })
        .sum({ failed: "fail_count" })
        .count({ reports: "id" })
        .max({ lastReport: "date_end" });

    // The published policy is whatever the newest report for that domain saw.
    const policies = await R.knex("dmarc_report as a")
        .where("a.monitor_id", monitorID)
        .whereNotExists(function () {
            this.select("*").from("dmarc_report as b")
                .whereRaw("b.monitor_id = a.monitor_id")
                .whereRaw("b.domain = a.domain")
                .whereRaw("b.date_end > a.date_end");
        })
        .select("a.domain", "a.policy_p", "a.policy_sp", "a.policy_pct", "a.policy_adkim", "a.policy_aspf");

    const policyByDomain = {};
    for (const p of policies) {
        policyByDomain[p.domain] = p;
    }

    return rows
        .map((r) => ({
            domain: r.domain,
            messages: Number(r.messages) || 0,
            passed: Number(r.passed) || 0,
            failed: Number(r.failed) || 0,
            reports: Number(r.reports) || 0,
            lastReport: Number(r.lastReport) || 0,
            policy: policyByDomain[r.domain] || null,
        }))
        .sort((a, b) => b.messages - a.messages);
}

/**
 * Daily pass/fail buckets for the chart.
 * @param {number} monitorID Owning monitor
 * @param {string|null} domain Restrict to one domain, or null for all
 * @param {number} days Window size in days
 * @returns {Promise<object[]>} Ascending daily buckets
 */
async function getTimeline(monitorID, domain, days = 30) {
    const now = Math.floor(Date.now() / 1000);
    const since = now - days * DAY;

    const q = R.knex("dmarc_report")
        .where("monitor_id", monitorID)
        .where("date_end", ">=", since)
        .select("date_end", "message_count", "pass_count", "fail_count");
    if (domain) {
        q.where("domain", domain);
    }
    const rows = await q;

    const buckets = new Map();
    for (let d = Math.floor(since / DAY); d <= Math.floor(now / DAY); d++) {
        buckets.set(d, { day: d * DAY,
            messages: 0,
            passed: 0,
            failed: 0 });
    }
    for (const r of rows) {
        const key = Math.floor(Number(r.date_end) / DAY);
        const b = buckets.get(key);
        if (b) {
            b.messages += Number(r.message_count) || 0;
            b.passed += Number(r.pass_count) || 0;
            b.failed += Number(r.fail_count) || 0;
        }
    }
    return [ ...buckets.values() ];
}

/**
 * Per-source-IP aggregation, with the date each source was first seen.
 * first_seen ignores the time window - a source is new relative to everything
 * on record, not to the period being displayed - but it does respect the
 * domain filter.
 * @param {number} monitorID Owning monitor
 * @param {string|null} domain Restrict to one domain, or null for all
 * @param {number} days Window size in days
 * @returns {Promise<object[]>} One entry per source IP, busiest first
 */
async function getSources(monitorID, domain, days = 30) {
    const since = Math.floor(Date.now() / 1000) - days * DAY;
    const knex = R.knex;

    const passExpr = "CASE WHEN r.dkim_aligned = 1 OR r.spf_aligned = 1 THEN r.count ELSE 0 END";

    const build = (windowed) => {
        const q = knex("dmarc_record as r")
            .join("dmarc_report as p", "p.id", "r.dmarc_report_id")
            .where("p.monitor_id", monitorID);
        if (domain) {
            q.where("p.domain", domain);
        }
        if (windowed) {
            q.where("p.date_end", ">=", since);
        }
        return q;
    };

    const rows = await build(true)
        .groupBy("r.source_ip")
        .select("r.source_ip")
        .sum({ messages: "r.count" })
        .select(knex.raw(`SUM(${passExpr}) as passed`))
        .select(knex.raw("SUM(CASE WHEN r.dkim_aligned = 1 THEN r.count ELSE 0 END) as dkim_passed"))
        .select(knex.raw("SUM(CASE WHEN r.spf_aligned = 1 THEN r.count ELSE 0 END) as spf_passed"))
        .select(knex.raw("SUM(CASE WHEN p.policy_p IS NOT NULL AND r.disposition = 'quarantine' THEN r.count ELSE 0 END) as quarantined"))
        .select(knex.raw("SUM(CASE WHEN r.disposition = 'reject' THEN r.count ELSE 0 END) as rejected"))
        .max({ headerFrom: "r.header_from" });

    const firstSeen = await build(false)
        .groupBy("r.source_ip")
        .select("r.source_ip")
        .min({ firstSeen: "p.date_begin" });

    const firstSeenByIP = {};
    for (const f of firstSeen) {
        firstSeenByIP[f.source_ip] = Number(f.firstSeen) || 0;
    }

    return rows
        .map((r) => {
            const messages = Number(r.messages) || 0;
            const passed = Number(r.passed) || 0;
            return {
                sourceIp: r.source_ip,
                messages,
                passed,
                failed: messages - passed,
                dkimPassed: Number(r.dkim_passed) || 0,
                spfPassed: Number(r.spf_passed) || 0,
                quarantined: Number(r.quarantined) || 0,
                rejected: Number(r.rejected) || 0,
                headerFrom: r.headerFrom || "",
                firstSeen: firstSeenByIP[r.source_ip] || 0,
            };
        })
        .sort((a, b) => b.messages - a.messages);
}

/**
 * Most recently received reports, for the detail table.
 * @param {number} monitorID Owning monitor
 * @param {string|null} domain Restrict to one domain, or null for all
 * @param {number} limit Maximum rows; not capped
 * @returns {Promise<object[]>} Newest first
 */
async function getRecentReports(monitorID, domain, limit = 50) {
    const q = R.knex("dmarc_report")
        .where("monitor_id", monitorID)
        .orderBy("date_end", "desc")
        .limit(limit > 0 ? limit : 50)
        .select("id", "org_name", "report_id", "domain", "date_begin", "date_end",
            "policy_p", "message_count", "pass_count", "fail_count");
    if (domain) {
        q.where("domain", domain);
    }
    return (await q).map((r) => ({
        id: r.id,
        orgName: r.org_name,
        reportId: r.report_id,
        domain: r.domain,
        dateBegin: Number(r.date_begin),
        dateEnd: Number(r.date_end),
        policy: r.policy_p,
        messages: Number(r.message_count),
        passed: Number(r.pass_count),
        failed: Number(r.fail_count),
    }));
}

/**
 * Persist the ingestion cursor.
 * @param {object} monitor Monitor bean
 * @param {object} state New cursor
 * @returns {Promise<void>} Promise
 */
async function saveState(monitor, state) {
    const json = JSON.stringify(state);
    await R.knex("monitor").where("id", monitor.id).update({ dmarc_state: json });
    monitor.dmarc_state = json;
}

/**
 * Every domain ever seen for this monitor, with its newest report.
 * @param {number} monitorID Owning monitor
 * @returns {Promise<object[]>} Domains with their newest report timestamp
 */
async function getKnownDomains(monitorID) {
    const rows = await R.knex("dmarc_report")
        .where("monitor_id", monitorID)
        .groupBy("domain")
        .select("domain")
        .max({ lastReport: "date_end" });

    return rows.map((r) => ({
        domain: r.domain,
        lastReport: Number(r.lastReport) || 0,
    }));
}

/**
 * Drop reports older than the retention window. dmarc_record rows go with them
 * through ON DELETE CASCADE, which SQLite honours because the server enables
 * the foreign_keys pragma.
 * @param {number} monitorID Owning monitor
 * @param {number} retentionDays Days of history to keep; 0 disables pruning
 * @returns {Promise<number>} Number of reports removed
 */
async function prune(monitorID, retentionDays) {
    if (!retentionDays || retentionDays <= 0) {
        return 0;
    }
    const cutoff = Math.floor(Date.now() / 1000) - retentionDays * DAY;
    const removed = await R.knex("dmarc_report")
        .where("monitor_id", monitorID)
        .where("date_end", "<", cutoff)
        .delete();
    if (removed) {
        log.info("dmarc", `Pruned ${removed} report(s) older than ${retentionDays} days`);
    }
    return removed;
}

module.exports = {
    saveReport,
    saveState,
    getKnownDomains,
    getDomainSummary,
    getTimeline,
    getSources,
    getRecentReports,
    prune,
};
