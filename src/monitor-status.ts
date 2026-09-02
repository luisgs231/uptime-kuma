/*!
* // The status vocabulary the added monitor types report, shared by both
* sides.
*/

/**
 * How one status of one monitor type is presented.
 */
export interface MonitorStatusMeta {
    label: string;
    color: string;
    description: string;
    /** Rendered louder than the rest; for the one status nobody may scroll past. */
    loud?: boolean;
}

/**
 * DMARC statuses, most severe first.
 */
export const DMARC_STATUS_META: Record<string, MonitorStatusMeta> = {
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
        description:
            "A certificate or TLS policy is being rejected - an expired certificate, a hostname mismatch, or an MTA-STS policy that no longer validates.",
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
        // The same green the rest of the dashboard uses for an up monitor.
        color: "primary",
        description: "Reports are arriving and mail is authenticating.",
    },
};

/**
 * CARP verdicts: which node holds the floating address, and whether the pair
 * still has somewhere to fail over to.
 */
export const CARP_STATUS_META: Record<string, MonitorStatusMeta> = {
    MASTER: {
        label: "MASTER",
        color: "primary",
        description: "The master is holding the floating address.",
    },
    "MASTER ONLY": {
        label: "MASTER ONLY",
        color: "warning",
        description:
            "The master is holding the floating address, but no other node is standing by - so there is nothing left to fail over to.",
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

/** Every monitor type that reports its own statuses instead of Up/Down/Pending. */
export const MONITOR_STATUS_META: Record<string, Record<string, MonitorStatusMeta>> = {
    dmarc: DMARC_STATUS_META,
    carp: CARP_STATUS_META,
};

/**
 * Shown when a heartbeat carries a status this build does not know about, so a
 * newer server talking to an older page says something rather than nothing.
 */
export const UNKNOWN_STATUS_META: MonitorStatusMeta = {
    label: "Unknown",
    color: "secondary",
    description: "This monitor reported a status this page does not recognise.",
};

/** Label to status, per type, for reading a status back out of a message. */
const BY_LABEL: Record<string, Record<string, string>> = {};
for (const type of Object.keys(MONITOR_STATUS_META)) {
    const index: Record<string, string> = {};
    for (const status of Object.keys(MONITOR_STATUS_META[type])) {
        index[MONITOR_STATUS_META[type][status].label.toLowerCase()] = status;
    }
    BY_LABEL[type] = index;
}

/**
 * Whether a monitor type reports statuses of its own.
 * @param {string} type Monitor type
 * @returns {boolean} True when it has a vocabulary here
 */
export function hasStatusVocabulary(type: string | null | undefined): boolean {
    return !!type && Object.prototype.hasOwnProperty.call(MONITOR_STATUS_META, type);
}

/**
 * Look up how a status is presented.
 * @param {string} type Monitor type
 * @param {string} status The type's own status
 * @returns {object|null} Metadata, or null when the type has no vocabulary
 */
export function getStatusMeta(
    type: string | null | undefined,
    status: string | null | undefined
): MonitorStatusMeta | null {
    if (!hasStatusVocabulary(type) || !status) {
        return null;
    }
    return MONITOR_STATUS_META[type as string][status] || UNKNOWN_STATUS_META;
}

/**
 * Split "[Mail loss] 12 messages rejected" into its label and the rest.
 * @param {string} msg Heartbeat message
 * @returns {object} label (null when there is no prefix) and body
 */
export function splitStatusMessage(msg: string | null | undefined): { label: string | null; body: string } {
    const text = String(msg ?? "");
    const match = /^\[([^\]]+)\]\s*/.exec(text);
    if (!match) {
        return { label: null,
            body: text };
    }
    return { label: match[1].trim(),
        body: text.slice(match[0].length) };
}

/**
 * A heartbeat message without the status it starts with.
 * @param {string} msg Heartbeat message
 * @returns {string} The message body
 */
export function stripStatusPrefix(msg: string | null | undefined): string {
    return splitStatusMessage(msg).body;
}

/**
 * Read the status back out of a heartbeat message.
 * @param {string} type Monitor type
 * @param {string} msg Heartbeat message
 * @returns {string|null} The type's own status, or null when it cannot be read
 */
export function statusFromMessage(
    type: string | null | undefined,
    msg: string | null | undefined
): string | null {
    if (!hasStatusVocabulary(type)) {
        return null;
    }
    const { label } = splitStatusMessage(msg);
    if (!label) {
        return null;
    }
    return BY_LABEL[type as string][label.toLowerCase()] || null;
}

/**
 * Work out how to present a heartbeat, preferring a stored status.
 * @param {string} type Monitor type
 * @param {object} heartbeat A heartbeat, needing at most `msg` and a status field
 * @returns {object|null} Metadata, or null to fall back to Up/Down/Pending
 */
export function heartbeatStatusMeta(
    type: string | null | undefined,
    heartbeat: { msg?: string | null; dmarcStatus?: string | null } | null | undefined
): MonitorStatusMeta | null {
    if (!hasStatusVocabulary(type) || !heartbeat) {
        return null;
    }
    if (type === "dmarc" && heartbeat.dmarcStatus) {
        return getStatusMeta(type, heartbeat.dmarcStatus);
    }
    const status = statusFromMessage(type, heartbeat.msg);
    return status ? getStatusMeta(type, status) : null;
}

/**
 * The "[Label] " a monitor puts in front of its heartbeat message.
 * @param {string} type Monitor type
 * @param {string} status The type's own status
 * @returns {string} The prefix, including its trailing space
 */
export function formatStatusPrefix(type: string, status: string): string {
    const meta = getStatusMeta(type, status);
    return `[${meta && meta !== UNKNOWN_STATUS_META ? meta.label : status}] `;
}
