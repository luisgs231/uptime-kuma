/**
 * Creating a monitor for each domain found in the mailbox.
 */
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { parseConfig } = require("./config");

const MAX_PER_RUN = 20;

/**
 * Domains that already have a DMARC monitor.
 * @returns {Promise<Set<string>>} Domain names already covered
 */
async function coveredDomains() {
    const rows = await R.knex("monitor").where("type", "dmarc").select("id", "dmarc_config");
    const covered = new Set();
    for (const row of rows) {
        const domain = parseConfig(row.dmarc_config).domain;
        if (domain) {
            covered.add(domain);
        }
    }
    return covered;
}

/**
 * Assign a domain to a monitor that does not have one yet.
 * @param {object} monitor Monitor bean
 * @param {object} config Parsed config
 * @param {string} domain Domain to adopt
 * @returns {Promise<object>} The updated config
 */
async function adoptDomain(monitor, config, domain) {
    const next = { ...config,
        domain };
    const update = { dmarc_config: JSON.stringify(next) };

    if (config.autoDeploy) {
        update.name = `${config.autoDeployPrefix || "DMARC: "}${domain}`;
        monitor.name = update.name;
    }

    await R.knex("monitor").where("id", monitor.id).update(update);
    monitor.dmarc_config = update.dmarc_config;
    log.info("dmarc", `Monitor ${monitor.id} adopted ${domain}`);
    return next;
}

/**
 * Create a monitor for one domain, copying this monitor's mailbox settings.
 * @param {object} source Monitor to copy settings from
 * @param {object} config Parsed config of the source monitor
 * @param {string} domain Domain the new monitor will watch
 * @returns {Promise<object>} The stored monitor bean
 */
async function createDomainMonitor(source, config, domain) {
    const bean = R.dispense("monitor");

    bean.name = `${config.autoDeployPrefix || "DMARC: "}${domain}`;
    bean.type = "dmarc";
    bean.user_id = source.user_id;
    bean.active = true;
    bean.interval = source.interval;
    bean.retry_interval = source.retry_interval;
    bean.resend_interval = source.resend_interval;
    // Retrying an IMAP fetch recovers nothing a later check would not.
    bean.maxretries = 0;
    bean.parent = source.parent;

    // Same mailbox, its own domain and its own cursor.
    bean.dmarc_config = JSON.stringify({ ...config,
        domain });

    await R.store(bean);

    const links = await R.knex("monitor_notification")
        .where("monitor_id", source.id)
        .select("notification_id");
    for (const link of links) {
        const relation = R.dispense("monitor_notification");
        relation.monitor_id = bean.id;
        relation.notification_id = link.notification_id;
        await R.store(relation);
    }
    return bean;
}

/**
 * Create monitors for domains seen in the mailbox that do not have one.
 * @param {object} monitor Monitor that did the fetch
 * @param {object} config Its parsed config
 * @param {string[]} domainsSeen Domains present in the reports just read
 * @param {object} server UptimeKumaServer instance
 * @returns {Promise<string[]>} Domains a monitor was created for
 */
async function deployMissingDomains(monitor, config, domainsSeen, server) {
    if (!domainsSeen.length) {
        return [];
    }

    const covered = await coveredDomains();
    const missing = domainsSeen.filter((d) => !covered.has(d)).sort();
    if (!missing.length) {
        return [];
    }

    const batch = missing.slice(0, MAX_PER_RUN);
    if (missing.length > batch.length) {
        log.info("dmarc", `${missing.length} domains without a monitor, creating ${batch.length} this run`);
    }

    const created = [];
    for (const domain of batch) {
        try {
            const bean = await createDomainMonitor(monitor, config, domain);
            const stored = await R.findOne("monitor", " id = ? ", [ bean.id ]);

            if (server) {
                server.monitorList[stored.id] = stored;
                await stored.start(server.io);
                const list = await server.getMonitorJSONList(monitor.user_id, stored.id);
                if (list && list[stored.id]) {
                    server.io.to(monitor.user_id).emit("updateMonitorIntoList", list);
                }
            }

            created.push(domain);
            log.info("dmarc", `Auto-deployed monitor for ${domain} (id ${stored.id})`);
        } catch (e) {
            // One bad domain must not stop the rest, nor fail the check.
            log.error("dmarc", `Could not auto-deploy monitor for ${domain}: ${e.message}`);
        }
    }
    return created;
}

module.exports = {
    deployMissingDomains,
    coveredDomains,
    adoptDomain,
    MAX_PER_RUN,
};
