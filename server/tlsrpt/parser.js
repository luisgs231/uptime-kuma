/**
 * SMTP TLS reporting (RFC 8460).
 */

/**
 * Whether a document looks like an SMTP TLS report.
 * @param {Buffer|string} buf Decompressed document
 * @returns {boolean} True if it parses as a TLS report
 */
function looksLikeTlsReport(buf) {
    if (!buf) {
        return false;
    }
    const head = buf.subarray ? buf.subarray(0, 4096).toString("utf8") : String(buf).slice(0, 4096);
    return head.includes("\"policies\"") || head.includes("\"organization-name\"");
}

/**
 * Convert an RFC 3339 timestamp to unix seconds.
 * @param {string} value Timestamp
 * @returns {number} Unix seconds, or 0 when unparseable
 */
function toEpoch(value) {
    if (!value) {
        return 0;
    }
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

/**
 * Read the first present key from an object.
 * @param {object} obj Source object
 * @param {string[]} keys Candidate keys in order of preference
 * @param {*} fallback Value when none are present
 * @returns {*} The value found
 */
function pick(obj, keys, fallback) {
    if (!obj || typeof obj !== "object") {
        return fallback;
    }
    for (const key of keys) {
        if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
            return obj[key];
        }
    }
    return fallback;
}

/**
 * Coerce to a non-negative integer.
 * @param {*} value Raw value
 * @returns {number} Parsed count, 0 when unparseable
 */
function count(value) {
    const n = parseInt(value, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Parse an SMTP TLS report.
 * @param {Buffer|string} data Decompressed JSON document
 * @returns {object[]} Normalised per-domain reports; empty if this isn't one
 */
function parseTlsReport(data) {
    let doc;
    try {
        doc = JSON.parse(data.toString("utf8"));
    } catch (e) {
        return [];
    }
    if (!doc || typeof doc !== "object" || !Array.isArray(doc.policies)) {
        return [];
    }

    const orgName = String(pick(doc, [ "organization-name", "organization_name" ], "unknown"));
    const reportId = String(pick(doc, [ "report-id", "report_id" ], ""));
    if (!reportId) {
        return [];
    }

    const range = pick(doc, [ "date-range", "date_range" ], {});
    const dateBegin = toEpoch(pick(range, [ "start-datetime", "start_datetime" ], ""));
    const dateEnd = toEpoch(pick(range, [ "end-datetime", "end_datetime" ], ""));
    const contactInfo = String(pick(doc, [ "contact-info", "contact_info" ], ""));

    const out = [];
    for (const entry of doc.policies) {
        const policy = pick(entry, [ "policy" ], {});
        const domain = String(pick(policy, [ "policy-domain", "policy_domain" ], "")).toLowerCase();
        if (!domain) {
            continue;
        }
        const summary = pick(entry, [ "summary" ], {});

        const failures = [];
        for (const failure of pick(entry, [ "failure-details", "failure_details" ], []) || []) {
            failures.push({
                resultType: String(pick(failure, [ "result-type", "result_type" ], "unknown")).toLowerCase(),
                sendingMtaIp: String(pick(failure, [ "sending-mta-ip", "sending_mta_ip" ], "")),
                receivingMxHostname: String(pick(failure, [ "receiving-mx-hostname", "receiving_mx_hostname" ], "")),
                receivingIp: String(pick(failure, [ "receiving-ip", "receiving_ip" ], "")),
                failedSessionCount: count(pick(failure, [ "failed-session-count", "failed_session_count" ], 0)),
            });
        }

        out.push({
            orgName,
            reportId,
            contactInfo,
            domain,
            dateBegin,
            dateEnd,
            policyType: String(pick(policy, [ "policy-type", "policy_type" ], "unknown")).toLowerCase(),
            successCount: count(pick(summary, [ "total-successful-session-count", "total_successful_session_count" ], 0)),
            failureCount: count(pick(summary, [ "total-failure-session-count", "total_failure_session_count" ], 0)),
            failures,
        });
    }
    return out;
}

/**
 * Failure result types that mean TLS could not be established or verified.
 */
const CERTIFICATE_FAILURES = new Set([
    "certificate-expired",
    "certificate-host-mismatch",
    "certificate-not-trusted",
    "validation-failure",
]);

const POLICY_FAILURES = new Set([
    "sts-policy-fetch-error",
    "sts-policy-invalid",
    "sts-webpki-invalid",
    "tlsa-invalid",
    "dnssec-invalid",
    "dane-required",
]);

module.exports = {
    parseTlsReport,
    looksLikeTlsReport,
    CERTIFICATE_FAILURES,
    POLICY_FAILURES,
};
