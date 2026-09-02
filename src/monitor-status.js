"use strict";
/*!
* // The status vocabulary the added monitor types report, shared by both
* sides.
*/
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatStatusPrefix = exports.heartbeatStatusMeta = exports.statusFromMessage = exports.stripStatusPrefix = exports.splitStatusMessage = exports.getStatusMeta = exports.hasStatusVocabulary = exports.UNKNOWN_STATUS_META = exports.MONITOR_STATUS_META = exports.CARP_STATUS_META = exports.DMARC_STATUS_META = void 0;
exports.DMARC_STATUS_META = {
    "ingest-error": {
        label: "Ingest error",
        color: "warning",
        description: "The mailbox could not be read, so everything shown here may be out of date.",
    },
    "mail-loss": {
        label: "Mail loss",
        color: "danger",
        description: "Receivers are quarantining or rejecting mail, so real messages are being lost.",
    },
    spoofing: {
        label: "Spoofing",
        color: "danger",
        loud: true,
        description: "A source not seen before is sending mail as you, and it fails DMARC.",
    },
    "cert-problem": {
        label: "Certificate problem",
        color: "danger",
        description: "A certificate or TLS policy is being rejected - an expired certificate, a hostname mismatch, or an MTA-STS policy that no longer validates.",
    },
    "tls-failure": {
        label: "TLS failure",
        color: "warning",
        description: "Senders are failing to establish TLS to this domain more often than expected.",
    },
    stale: {
        label: "Stale",
        color: "warning",
        description: "Reports have stopped arriving. Usually a broken _dmarc record rather than a mail problem.",
    },
    degraded: {
        label: "Degraded",
        color: "warning",
        description: "More messages are failing DMARC than expected, but no receiver has acted on it yet.",
    },
    "no-data": {
        label: "No data",
        color: "secondary",
        description: "Nothing received yet. Reports usually arrive once a day, so allow 24 hours.",
    },
    ok: {
        label: "OK",
        color: "primary",
        description: "Reports are arriving and mail is authenticating.",
    },
};
exports.CARP_STATUS_META = {
    MASTER: {
        label: "MASTER",
        color: "primary",
        description: "The master is holding the floating address.",
    },
    "MASTER ONLY": {
        label: "MASTER ONLY",
        color: "warning",
        description: "The master is holding the floating address, but no other node is standing by - so there is nothing left to fail over to.",
    },
    BACKUP: {
        label: "BACKUP",
        color: "warning",
        description: "Something other than the master is holding it, or which node holds it could not be confirmed.",
    },
    DOWN: {
        label: "DOWN",
        color: "danger",
        description: "Nothing is holding the floating address, or it is not answering.",
    },
};
exports.MONITOR_STATUS_META = {
    dmarc: exports.DMARC_STATUS_META,
    carp: exports.CARP_STATUS_META,
};
exports.UNKNOWN_STATUS_META = {
    label: "Unknown",
    color: "secondary",
    description: "This monitor reported a status this page does not recognise.",
};
const BY_LABEL = {};
for (const type of Object.keys(exports.MONITOR_STATUS_META)) {
    const index = {};
    for (const status of Object.keys(exports.MONITOR_STATUS_META[type])) {
        index[exports.MONITOR_STATUS_META[type][status].label.toLowerCase()] = status;
    }
    BY_LABEL[type] = index;
}
function hasStatusVocabulary(type) {
    return !!type && Object.prototype.hasOwnProperty.call(exports.MONITOR_STATUS_META, type);
}
exports.hasStatusVocabulary = hasStatusVocabulary;
function getStatusMeta(type, status) {
    if (!hasStatusVocabulary(type) || !status) {
        return null;
    }
    return exports.MONITOR_STATUS_META[type][status] || exports.UNKNOWN_STATUS_META;
}
exports.getStatusMeta = getStatusMeta;
function splitStatusMessage(msg) {
    const text = String(msg !== null && msg !== void 0 ? msg : "");
    const match = /^\[([^\]]+)\]\s*/.exec(text);
    if (!match) {
        return { label: null,
            body: text };
    }
    return { label: match[1].trim(),
        body: text.slice(match[0].length) };
}
exports.splitStatusMessage = splitStatusMessage;
function stripStatusPrefix(msg) {
    return splitStatusMessage(msg).body;
}
exports.stripStatusPrefix = stripStatusPrefix;
function statusFromMessage(type, msg) {
    if (!hasStatusVocabulary(type)) {
        return null;
    }
    const { label } = splitStatusMessage(msg);
    if (!label) {
        return null;
    }
    return BY_LABEL[type][label.toLowerCase()] || null;
}
exports.statusFromMessage = statusFromMessage;
function heartbeatStatusMeta(type, heartbeat) {
    if (!hasStatusVocabulary(type) || !heartbeat) {
        return null;
    }
    if (type === "dmarc" && heartbeat.dmarcStatus) {
        return getStatusMeta(type, heartbeat.dmarcStatus);
    }
    const status = statusFromMessage(type, heartbeat.msg);
    return status ? getStatusMeta(type, status) : null;
}
exports.heartbeatStatusMeta = heartbeatStatusMeta;
function formatStatusPrefix(type, status) {
    const meta = getStatusMeta(type, status);
    return `[${meta && meta !== exports.UNKNOWN_STATUS_META ? meta.label : status}] `;
}
exports.formatStatusPrefix = formatStatusPrefix;
