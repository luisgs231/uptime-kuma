/**
 * Notifying on every DMARC status change.
 */
const { log, PENDING } = require("../../src/util");

/**
 * Decide whether this monitor must send its own notification.
 * @param {object} input Decision inputs
 * @param {boolean} input.isFirstBeat Whether this is the monitor's first beat
 * @param {string|null} input.previousStatus Fork status of the previous beat
 * @param {string} input.status Fork status of this beat
 * @param {boolean} input.kumaWillNotify Whether Kuma's own logic will notify
 * @param {boolean} input.enabled Whether status-change notification is enabled
 * @param {boolean} input.isAmber Whether this beat is one Kuma will never report
 * @param {boolean} input.isSilent Whether this transition must not be reported
 * @returns {boolean} True if this monitor should send a notification itself
 */
function shouldNotifyStatusChange({
    isFirstBeat,
    previousStatus,
    status,
    kumaWillNotify,
    enabled,
    isAmber,
    isSilent,
}) {
    if (isFirstBeat || isSilent) {
        return false;
    }
    // Kuma is about to report this transition itself.
    if (kumaWillNotify) {
        return false;
    }
    if (!previousStatus || previousStatus === status) {
        return false;
    }
    // Kuma never notifies on an amber monitor, and an amber verdict here is a
    // silent failover or a domain that has stopped reporting - the failures
    // these monitors exist to catch. Those are not optional.
    return isAmber ? true : enabled;
}

/**
 * Read the previous heartbeat's statuses.
 * @param {number} monitorID Monitor id
 * @returns {Promise<object>} previousKumaStatus, previousStatus and isFirstBeat
 */
async function previousStatuses(monitorID) {
    const { R } = require("redbean-node");
    const row = await R.knex("heartbeat")
        .where("monitor_id", monitorID)
        .orderBy("id", "desc")
        .first("status", "dmarc_status", "msg");

    return {
        isFirstBeat: !row,
        previousKumaStatus: row ? Number(row.status) : undefined,
        previousStatus: row ? row.dmarc_status || null : null,
        previousMsg: row ? row.msg || "" : "",
    };
}

/**
 * Send a notification for a DMARC status change Kuma would not report.
 * @param {object} monitor Monitor bean
 * @param {object} heartbeat Heartbeat bean for this beat
 * @param {object} context Result of previousStatuses() plus the new statuses
 * @returns {Promise<boolean>} Whether a notification was sent
 */
async function maybeNotify(monitor, heartbeat, context) {
    const Monitor = require("../model/monitor");

    const kumaWillNotify = Monitor.isImportantForNotification(
        context.isFirstBeat,
        context.previousKumaStatus,
        heartbeat.status
    );

    if (!shouldNotifyStatusChange({ ...context,
        kumaWillNotify,
        isAmber: heartbeat.status === PENDING })) {
        return false;
    }

    log.info(
        "dmarc",
        `[${monitor.name}] status ${context.previousStatus} -> ${context.status}, notifying`
    );
    await Monitor.sendNotification(false, monitor, heartbeat);
    return true;
}

module.exports = {
    shouldNotifyStatusChange,
    previousStatuses,
    maybeNotify,
};
