/**
 * Reading and writing the DMARC monitor's JSON config and cursor columns.
 */
const { DEFAULTS } = require("./rules");

const CONFIG_DEFAULTS = {
    domain: "",

    autoDeploy: false,
    autoDeployPrefix: "DMARC: ",

    notifyOnStatusChange: true,

    imap: {
        host: "",
        port: 993,
        secure: true,
        ignoreTls: false,
        username: "",
        password: "",
        folder: "INBOX",
    },

    // How far back the dashboard and the rules look.
    windowDays: DEFAULTS.windowDays,
    // How much history to keep; 0 keeps everything.
    retentionDays: 365,
    // How far back to read on the very first run.
    initialDays: 30,
    maxMessagesPerRun: 500,

    failRateThreshold: DEFAULTS.failRateThreshold,
    minFailures: DEFAULTS.minFailures,
    alertOnNewSource: DEFAULTS.alertOnNewSource,
    alertOnDisposition: DEFAULTS.alertOnDisposition,
    staleDays: DEFAULTS.staleDays,

    tlsFailRateThreshold: DEFAULTS.tlsFailRateThreshold,
    tlsMinFailures: DEFAULTS.tlsMinFailures,
    alertOnTlsCertProblem: DEFAULTS.alertOnTlsCertProblem,
};


/**
 * Parse the stored config, filling in anything missing.
 * @param {string|object|null} raw Value of monitor.dmarc_config
 * @returns {object} Config with defaults applied
 */
function parseConfig(raw) {
    let parsed = {};
    if (raw && typeof raw === "object") {
        parsed = raw;
    } else if (typeof raw === "string" && raw.trim()) {
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            parsed = {};
        }
    }
    return {
        ...CONFIG_DEFAULTS,
        ...parsed,
        imap: { ...CONFIG_DEFAULTS.imap,
            ...(parsed.imap || {}) },
    };
}

/**
 * The config with the IMAP password removed, for anything leaving the server
 * that hasn't asked for sensitive data.
 * @param {string|object|null} raw Value of monitor.dmarc_config
 * @returns {object} Config without the password
 */
function redactConfig(raw) {
    const config = parseConfig(raw);
    return {
        ...config,
        imap: { ...config.imap,
            password: "" },
    };
}

/**
 * Serialise a config for storage, keeping an existing password when the form
 * submits a blank one.
 * @param {object} incoming Config supplied by the client
 * @param {string|object|null} existing Currently stored config
 * @returns {string} JSON to write to monitor.dmarc_config
 */
function serializeConfig(incoming, existing) {
    const current = parseConfig(existing);
    const next = parseConfig(incoming);
    if (!next.imap.password) {
        next.imap.password = current.imap.password;
    }
    return JSON.stringify(next);
}

/**
 * Parse the stored ingestion cursor.
 * @param {string|object|null} raw Value of monitor.dmarc_state
 * @returns {object} Cursor: uidValidity, lastUid, baselined, lastRun
 */
function parseState(raw) {
    if (raw && typeof raw === "object") {
        return raw;
    }
    if (typeof raw === "string" && raw.trim()) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            return {};
        }
    }
    return {};
}

module.exports = {
    parseConfig,
    redactConfig,
    serializeConfig,
    parseState,
    CONFIG_DEFAULTS,
};
