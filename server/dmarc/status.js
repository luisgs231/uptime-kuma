/**
 * DMARC-specific statuses.
 */
const { UP, DOWN, PENDING } = require("../../src/util");
const { DMARC_STATUS_META } = require("../../src/monitor-status");

const OK = "ok";
const NO_DATA = "no-data";
const DEGRADED = "degraded";
const STALE = "stale";
const SPOOFING = "spoofing";
const MAIL_LOSS = "mail-loss";
const INGEST_ERROR = "ingest-error";
const TLS_FAILURE = "tls-failure";
const CERT_PROBLEM = "cert-problem";

/**
 * Most to least severe.
 */
const SEVERITY = [ INGEST_ERROR, MAIL_LOSS, SPOOFING, CERT_PROBLEM, TLS_FAILURE, STALE, DEGRADED, NO_DATA, OK ];

/** Which rule in rules.js produces which status. */
const RULE_STATUS = {
    "rejected": MAIL_LOSS,
    "quarantined": MAIL_LOSS,
    "new-source": SPOOFING,
    "stale": STALE,
    "fail-rate": DEGRADED,
    "tls-cert": CERT_PROBLEM,
    "tls-failure": TLS_FAILURE,
};

/**
 * Statuses that never send a notification of their own.
 */
const SILENT = [ INGEST_ERROR ];

/**
 * Whether a status is one this monitor stays quiet about.
 * @param {string|null} status DMARC status
 * @returns {boolean} True if it must not notify
 */
function isSilent(status) {
    return SILENT.includes(status);
}

/**
 * Which numeric status each colour in the vocabulary stands for.
 */
const HEARTBEAT_STATUS = {};
for (const status of Object.keys(DMARC_STATUS_META)) {
    const color = DMARC_STATUS_META[status].color;
    HEARTBEAT_STATUS[status] = color === "danger" ? DOWN : PENDING;
}
HEARTBEAT_STATUS[OK] = UP;

/**
 * The label and the plain English line for each status.
 */
const LABELS = {};
const DESCRIPTIONS = {};
for (const status of Object.keys(DMARC_STATUS_META)) {
    LABELS[status] = DMARC_STATUS_META[status].label;
    DESCRIPTIONS[status] = DMARC_STATUS_META[status].description;
}

/**
 * Reduce a set of alerts to the single worst DMARC status.
 * @param {object[]} alerts Alerts from rules.evaluate()
 * @param {boolean} hasData Whether any reports exist at all
 * @returns {string} The DMARC status
 */
function deriveStatus(alerts, hasData) {
    if (!hasData) {
        return NO_DATA;
    }
    let worst = OK;
    for (const alert of alerts) {
        const status = RULE_STATUS[alert.rule];
        if (status && SEVERITY.indexOf(status) < SEVERITY.indexOf(worst)) {
            worst = status;
        }
    }
    return worst;
}

/**
 * Map a DMARC status onto the heartbeat status Kuma works in.
 * @param {string} status DMARC status
 * @returns {number} UP, PENDING or DOWN
 */
function toHeartbeatStatus(status) {
    return HEARTBEAT_STATUS[status] !== undefined ? HEARTBEAT_STATUS[status] : DOWN;
}

module.exports = {
    OK,
    TLS_FAILURE,
    CERT_PROBLEM,
    NO_DATA,
    DEGRADED,
    STALE,
    SPOOFING,
    MAIL_LOSS,
    INGEST_ERROR,
    SEVERITY,
    RULE_STATUS,
    LABELS,
    DESCRIPTIONS,
    SILENT,
    isSilent,
    deriveStatus,
    toHeartbeatStatus,
};
