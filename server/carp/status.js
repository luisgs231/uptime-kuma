/**
 * CARP/VRRP failover statuses, and the parsing that produces them.
 */
const { UP, DOWN, PENDING } = require("../../src/util");
const { CARP_STATUS_META, statusFromMessage: sharedStatusFromMessage } = require("../../src/monitor-status");

const OK = "ok";
const FAILED_OVER = "failed-over";
const SPLIT_BRAIN = "split-brain";
const VIP_MISSING = "vip-missing";
const UNREACHABLE = "unreachable";
const INIT = "init";
// The cluster is judged from every node at once, not from one node's opinion.
const VIP_DOWN = "vip-down";
const NO_MASTER = "no-master";
const UNKNOWN_HOLDER = "unknown-holder";
const NO_BACKUP = "no-backup";

/** The whole vocabulary, for anything offering a choice of statuses. */
const STATUSES = [ OK, FAILED_OVER, SPLIT_BRAIN, VIP_MISSING, UNREACHABLE, INIT, VIP_DOWN, NO_MASTER, UNKNOWN_HOLDER, NO_BACKUP ];

const MASTER = "master";
const BACKUP = "backup";
const UNKNOWN = "unknown";

/**
 * What the monitor reports: which node holds the address, or that nobody does.
 */
const MASTER_HELD = "MASTER";
// The master holds it, but it is the only node left standing.
const MASTER_ONLY = "MASTER ONLY";
const BACKUP_HELD = "BACKUP";
const NOT_HELD = "DOWN";

const DISPLAY_STATUSES = [ MASTER_HELD, MASTER_ONLY, BACKUP_HELD, NOT_HELD ];

/** Detailed status to the verdict shown on the monitor. */
const DISPLAY_FROM = {
    [OK]: MASTER_HELD,
    [NO_BACKUP]: MASTER_ONLY,
    [FAILED_OVER]: BACKUP_HELD,
    [UNKNOWN_HOLDER]: BACKUP_HELD,
    [INIT]: BACKUP_HELD,
    [SPLIT_BRAIN]: NOT_HELD,
    [NO_MASTER]: NOT_HELD,
    [VIP_DOWN]: NOT_HELD,
    [UNREACHABLE]: NOT_HELD,
    [VIP_MISSING]: NOT_HELD,
};

const DISPLAY_HEARTBEAT = {
    [MASTER_HELD]: UP,
    [MASTER_ONLY]: PENDING,
    [BACKUP_HELD]: PENDING,
    [NOT_HELD]: DOWN,
};

/**
 * What each verdict is called on screen and in a notification.
 */
const DISPLAY_LABELS = {};
for (const display of DISPLAY_STATUSES) {
    DISPLAY_LABELS[display] = CARP_STATUS_META[display].label;
}

/**
 * Reduce a detailed status to the verdict shown on the monitor.
 * @param {string} status Detailed status
 * @returns {string} MASTER, BACKUP or DOWN
 */
function toDisplayStatus(status) {
    return DISPLAY_FROM[status] || NOT_HELD;
}

/**
 * Map a verdict onto the heartbeat status Kuma works in.
 * @param {string} display MASTER, MASTER ONLY, BACKUP or DOWN
 * @returns {number} UP, PENDING or DOWN
 */
function displayToHeartbeatStatus(display) {
    return DISPLAY_HEARTBEAT[display] !== undefined ? DISPLAY_HEARTBEAT[display] : DOWN;
}

/**
 * How each status shows in Uptime Kuma.
 */
const HEARTBEAT_STATUS = {
    [OK]: UP,
    [FAILED_OVER]: PENDING,
    [UNKNOWN_HOLDER]: PENDING,
    [INIT]: PENDING,
    [NO_BACKUP]: PENDING,
    [SPLIT_BRAIN]: DOWN,
    [NO_MASTER]: DOWN,
    [VIP_DOWN]: DOWN,
    [UNREACHABLE]: DOWN,
    [VIP_MISSING]: DOWN,
};

const LABELS = {
    [VIP_DOWN]: "Floating IP down",
    [NO_MASTER]: "No master",
    [UNKNOWN_HOLDER]: "Holder unknown",
    [NO_BACKUP]: "No backup",
    [OK]: "OK",
    [FAILED_OVER]: "Failed over",
    [SPLIT_BRAIN]: "Split brain",
    [VIP_MISSING]: "VIP missing",
    [UNREACHABLE]: "Unreachable",
    [INIT]: "Init",
};

const DESCRIPTIONS = {
    [VIP_DOWN]: "The floating address is not responding, so the service it fronts is down.",
    [NO_MASTER]: "The floating address is up but no node claims to be master for it.",
    [UNKNOWN_HOLDER]: "The floating address is up, but no node could be queried to find out which one holds it.",
    [NO_BACKUP]:
        "The master holds the floating address, but no other node is standing by. Nothing is broken yet - and there is nowhere left to fail over to, so the next fault takes the service down.",
    [OK]: "The VIP is held by the node that is supposed to hold it.",
    [FAILED_OVER]:
        "The VIP has moved to the other node. Traffic is still flowing, which is why nobody noticed, but the pair has no redundancy left until the reason is found.",
    [SPLIT_BRAIN]:
        "The same VIP is being claimed as MASTER in more than one place. Both nodes answering for one address means dropped and duplicated traffic; usually the CARP interfaces cannot see each other.",
    [VIP_MISSING]: "The firewall did not report the VIP this monitor watches. It may have been renumbered or removed.",
    [UNREACHABLE]:
        "The firewall's API could not be reached or refused the request, so the CARP state is unknown. This says nothing about whether the VIPs are healthy.",
    [INIT]:
        "CARP has not settled on a role. Briefly normal after a reboot; lasting INIT usually means the interface is down.",
};

// Where the VIP rows might be, for a payload that is not already an array.
const ROW_KEYS = [ "rows", "vips", "vip", "items", "data" ];

// Aliases seen across OPNsense versions. First non-empty one wins.
const FIELD_ALIASES = {
    interface: [ "interface", "if", "interface_name" ],
    vhid: [ "vhid", "vhid_txt" ],
    mode: [ "mode", "type" ],
    status: [ "status", "status_txt", "carp_status" ],
    address: [ "address", "subnet", "ipaddress", "ip" ],
};

/**
 * Read the first alias that carries a value.
 * @param {object} row One raw VIP entry
 * @param {string[]} keys Field names to try, in order of preference
 * @returns {string|null} The trimmed value, or null if no alias had one
 */
function pick(row, keys) {
    for (const key of keys) {
        const value = row[key];
        if (value === null || value === undefined) {
            continue;
        }
        const text = String(value).trim();
        if (text !== "") {
            return text;
        }
    }
    return null;
}

/**
 * Normalise a VHID to a number.
 * @param {string|number|null} raw Raw vhid field
 * @returns {number|null} The VHID, or null if there is not one
 */
function normaliseVhid(raw) {
    if (raw === null || raw === undefined) {
        return null;
    }
    const parsed = parseInt(String(raw).trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Normalise a reported CARP role to master, backup, init or unknown.
 * @param {string|null} raw Raw status field
 * @returns {string} One of "master", "backup", "init", "unknown"
 */
function normaliseStatus(raw) {
    if (raw === null || raw === undefined) {
        return UNKNOWN;
    }
    const [ first ] = String(raw).trim().toLowerCase().split(/[\s(,/]+/);
    if (first === MASTER || first === BACKUP || first === INIT) {
        return first;
    }
    return UNKNOWN;
}

/**
 * Find the VIP rows in whatever shape the API returned.
 * @param {*} payload Decoded response body
 * @returns {object[]} Raw VIP entries
 */
function extractRows(payload) {
    if (Array.isArray(payload)) {
        return payload.filter((row) => row && typeof row === "object");
    }
    if (!payload || typeof payload !== "object") {
        return [];
    }
    for (const key of ROW_KEYS) {
        if (Array.isArray(payload[key])) {
            return payload[key].filter((row) => row && typeof row === "object");
        }
    }
    return [];
}

/**
 * Parse an OPNsense VIP status payload into normalised entries.
 * @param {*} payload Decoded body of GET /api/diagnostics/interface/get_vip_status
 * @returns {object[]} Entries of { interface, vhid, mode, status, address }
 */
function parseVipStatus(payload) {
    return extractRows(payload).map((row) => {
        const mode = pick(row, FIELD_ALIASES.mode);
        return {
            interface: pick(row, FIELD_ALIASES.interface),
            vhid: normaliseVhid(pick(row, FIELD_ALIASES.vhid)),
            mode: mode === null ? null : mode.toLowerCase(),
            status: normaliseStatus(pick(row, FIELD_ALIASES.status)),
            address: pick(row, FIELD_ALIASES.address),
        };
    });
}

/**
 * Normalise a configured expected role.
 * @param {string|null} raw Configured role
 * @returns {string|null} "master", "backup", or null when not being checked
 */
function normaliseRole(raw) {
    const role = String(raw ?? "").trim().toLowerCase();
    return role === MASTER || role === BACKUP ? role : null;
}

/**
 * An address with any prefix length removed, lowercased for comparison.
 * @param {*} value Address, possibly written as a subnet
 * @returns {string} Bare address
 */
function bareAddress(value) {
    return String(value ?? "").trim().toLowerCase().replace(/\/\d+$/, "");
}

/**
 * Build the predicates a VIP must satisfy to match a selector.
 * @param {object} selector vhid, address and/or interface
 * @returns {Function[]} Predicates
 */
function selectorTests(selector) {
    const tests = [];

    const wantedVhid = normaliseVhid(selector.vhid);
    if (wantedVhid !== null) {
        tests.push((vip) => vip.vhid === wantedVhid);
    }

    const wantedAddress = bareAddress(selector.address);
    if (wantedAddress) {
        tests.push((vip) => bareAddress(vip.address) === wantedAddress);
    }

    const wantedInterface = String(selector.interface ?? "").trim().toLowerCase();
    if (wantedInterface) {
        tests.push((vip) => (vip.interface || "").toLowerCase() === wantedInterface);
    }

    return tests;
}

/**
 * Select a VIP by vhid, address or interface.
 * @param {object[]} vips Entries from parseVipStatus()
 * @param {object} selector Any of vhid, address, interface
 * @returns {object|null} The first matching VIP, or null
 */
function findVip(vips, selector) {
    if (!Array.isArray(vips) || !selector || typeof selector !== "object") {
        return null;
    }
    const tests = selectorTests(selector);
    if (tests.length === 0) {
        return null;
    }
    return vips.find((vip) => tests.every((test) => test(vip))) || null;
}

/**
 * Describe a VIP the way an alert should name it.
 * @param {object|null} vip A normalised VIP entry
 * @returns {string} e.g. "vhid 1 on vtnet0 (192.168.1.1)"
 */
function describeVip(vip) {
    if (!vip) {
        return "the VIP";
    }
    const parts = [ vip.vhid === null ? "an unnumbered VIP" : `vhid ${vip.vhid}` ];
    if (vip.interface) {
        parts.push(`on ${vip.interface}`);
    }
    if (vip.address) {
        parts.push(`(${vip.address})`);
    }
    return parts.join(" ");
}

/**
 * Describe a selector, for saying what could not be found.
 * @param {object} selector Any of vhid, address, interface
 * @returns {string} e.g. "vhid 1 on interface vtnet0"
 */
function describeSelector(selector) {
    const parts = [];
    if (normaliseVhid(selector?.vhid) !== null) {
        parts.push(`vhid ${normaliseVhid(selector.vhid)}`);
    }
    if (String(selector?.address ?? "").trim()) {
        parts.push(`address ${String(selector.address).trim()}`);
    }
    if (String(selector?.interface ?? "").trim()) {
        parts.push(`interface ${String(selector.interface).trim()}`);
    }
    return parts.join(" on ");
}

/**
 * Explain that the selected VIP is not in the reported set.
 * @param {object[]} vips Entries from parseVipStatus()
 * @param {object} selector The configured selector
 * @returns {string} Message naming what was looked for and what was there
 */
function missingMessage(vips, selector) {
    const wanted = describeSelector(selector);
    if (!wanted) {
        return "No VIP is selected, so there is nothing to watch. Set a vhid, an address or an interface.";
    }
    if (vips.length === 0) {
        return `The firewall reported no VIPs at all, so ${wanted} could not be checked.`;
    }
    const shown = vips.slice(0, 5).map(describeVip).join(", ");
    const more = vips.length > 5 ? `, and ${vips.length - 5} more` : "";
    return `No VIP matches ${wanted}. The firewall reported ${vips.length}: ${shown}${more}.`;
}

/**
 * Find a VHID being claimed as MASTER in more than one place.
 * @param {object[]} vips Entries from parseVipStatus()
 * @param {object} selected The VIP the selector matched
 * @returns {object[]|null} The conflicting entries, or null if there are none
 */
function findSplitBrain(vips, selected) {
    const byVhid = new Map();
    for (const vip of vips) {
        if (vip.vhid === null || vip.status !== MASTER) {
            continue;
        }
        const group = byVhid.get(vip.vhid) || [];
        group.push(vip);
        byVhid.set(vip.vhid, group);
    }

    const own = byVhid.get(selected.vhid);
    if (own && own.length > 1) {
        return own;
    }
    for (const group of byVhid.values()) {
        if (group.length > 1) {
            return group;
        }
    }
    return null;
}

/**
 * Find a VIP that has not settled on a role.
 * @param {object[]} vips Entries from parseVipStatus()
 * @param {object} selected The VIP the selector matched
 * @returns {object|null} The unsettled VIP, or null
 */
function findUnsettled(vips, selected) {
    if (selected.status === INIT || selected.status === UNKNOWN) {
        return selected;
    }
    return vips.find((vip) => vip.status === INIT && (vip.mode === null || vip.mode === "carp")) || null;
}

/**
 * Work out what the CARP state means.
 * @param {object} options Options
 * @param {object[]} options.vips Entries from parseVipStatus()
 * @param {object} options.selector Which VIP this monitor watches
 * @param {string|null} options.expectedRole "master", "backup", or null to not check
 * @returns {object} { status, message }
 */
function evaluate({ vips, selector, expectedRole }) {
    const list = Array.isArray(vips) ? vips : [];
    const wanted = normaliseRole(expectedRole);
    const vip = findVip(list, selector);

    if (!vip) {
        return {
            status: VIP_MISSING,
            message: missingMessage(list, selector || {}),
        };
    }

    const role = vip.status.toUpperCase();

    if (wanted && (vip.status === MASTER || vip.status === BACKUP) && vip.status !== wanted) {
        return {
            status: FAILED_OVER,
            message: `${describeVip(vip)} is ${role}, expected ${wanted.toUpperCase()}`,
        };
    }

    const conflict = findSplitBrain(list, vip);
    if (conflict) {
        const where = conflict.map((entry) => entry.interface || "an unnamed interface").join(" and ");
        return {
            status: SPLIT_BRAIN,
            message: `vhid ${conflict[0].vhid} is MASTER in ${conflict.length} places at once: ${where}`,
        };
    }

    const unsettled = findUnsettled(list, vip);
    if (unsettled) {
        if (unsettled === vip) {
            const detail =
                vip.status === INIT
                    ? "the interface is down or CARP has not settled"
                    : "the firewall did not report a CARP role for it";
            return {
                status: INIT,
                message: `${describeVip(vip)} is ${role}: ${detail}`,
            };
        }
        return {
            status: INIT,
            message: `${describeVip(vip)} is ${role}, but ${describeVip(unsettled)} is INIT`,
        };
    }

    const suffix = wanted ? ", as expected" : "";
    return {
        status: OK,
        message: `${describeVip(vip)} is ${role}${suffix}`,
    };
}

/**
 * Map a CARP status onto the heartbeat status Kuma works in.
 * @param {string} status CARP status
 * @returns {number} UP, PENDING or DOWN
 */
function toHeartbeatStatus(status) {
    return HEARTBEAT_STATUS[status] !== undefined ? HEARTBEAT_STATUS[status] : DOWN;
}

/**
 * Name the nodes an alert is about, with the verb that agrees with the count.
 * @param {object[]} nodes Nodes to name
 * @returns {string} e.g. "10.0.0.2 and 10.0.0.3 are"
 */
function describeNodes(nodes) {
    const ips = nodes.map((n) => n.ip);
    if (ips.length === 1) {
        return `${ips[0]} is`;
    }
    return `${ips.slice(0, -1).join(", ")} and ${ips[ips.length - 1]} are`;
}

/**
 * Judge the pair from the floating address and every node's own answer.
 * @param {object} input Cluster observation
 * @param {string} input.floatingIp The shared address
 * @param {boolean} input.floatingIpUp Whether the floating address responded
 * @param {string} input.masterIp The node expected to hold it
 * @param {object[]} input.nodes Per node: ip, reachable, role, error
 * @returns {object} status and message
 */
function evaluateCluster({ floatingIp, floatingIpUp, masterIp, nodes }) {
    const vip = floatingIp || "the floating address";

    if (!floatingIpUp) {
        return { status: VIP_DOWN,
            message: `${vip} is not responding` };
    }

    const reachable = (nodes || []).filter((n) => n.reachable);
    if (!reachable.length) {
        return {
            status: UNKNOWN_HOLDER,
            message: `${vip} is up, but no node could be queried (${(nodes || []).length} tried)`,
        };
    }

    const masters = reachable.filter((n) => n.role === MASTER);

    if (masters.length > 1) {
        return {
            status: SPLIT_BRAIN,
            message: `${masters.map((n) => n.ip).join(" and ")} both claim MASTER for ${vip}`,
        };
    }

    if (masters.length === 0) {
        if (reachable.some((n) => n.role === INIT)) {
            return { status: INIT,
                message: `${vip} is up but no node holds it yet; an interface is still initialising` };
        }
        return { status: NO_MASTER,
            message: `${vip} is up but no node claims MASTER for it` };
    }

    const holder = masters[0];
    if (masterIp && holder.ip !== masterIp) {
        return {
            status: FAILED_OVER,
            message: `${vip} is held by ${holder.ip}, not the master ${masterIp}`,
        };
    }

    const others = (nodes || []).filter((n) => n.ip !== holder.ip);
    if (others.length && !others.some((n) => n.reachable && n.role === BACKUP)) {
        const why = others.some((n) => n.reachable)
            ? `no other node is standing by as BACKUP (${others
                .map((n) => `${n.ip} is ${n.reachable ? String(n.role || "unknown").toUpperCase() : "unreachable"}`)
                .join(", ")})`
            : `${describeNodes(others)} not answering`;
        return {
            status: NO_BACKUP,
            message: `${vip} is held by the master ${holder.ip}, but ${why}, so there is nothing left to fail over to`,
        };
    }

    return { status: OK,
        message: `${vip} is held by the master ${holder.ip}` };
}

/**
 * Recover a status from a heartbeat message.
 * @param {string} msg Heartbeat message
 * @returns {string|null} The status, or null when the message has no label
 */
function statusFromMessage(msg) {
    return sharedStatusFromMessage("carp", msg);
}

/**
 * Judge the pair from reachability alone, when no API credentials are set.
 * @param {object} input Cluster observation
 * @param {string} input.floatingIp The shared address
 * @param {boolean} input.floatingIpUp Whether the floating address responded
 * @param {string} input.masterIp The node expected to hold it
 * @param {object[]} input.nodes Per node: ip and reachable
 * @returns {object} status and message
 */
function evaluatePing({ floatingIp, floatingIpUp, masterIp, nodes }) {
    const vip = floatingIp || "the floating address";
    const list = nodes || [];

    if (!floatingIpUp) {
        return { status: VIP_DOWN,
            message: `${vip} is not responding` };
    }

    const reachable = list.filter((n) => n.reachable);
    if (list.length && !reachable.length) {
        return {
            status: UNKNOWN_HOLDER,
            message: `${vip} is up but no node answers, so which one holds it cannot be inferred`,
        };
    }

    const master = masterIp ? list.find((n) => n.ip === masterIp) : null;
    if (master && !master.reachable) {
        return {
            status: FAILED_OVER,
            message: `${vip} is up but the master ${masterIp} is not answering, so it cannot be holding it (inferred from reachability; no API access)`,
        };
    }

    if (!masterIp) {
        return { status: OK,
            message: `${vip} is up (reachability only; no master configured to compare against)` };
    }

    const others = list.filter((n) => n.ip !== masterIp);
    if (others.length && !others.some((n) => n.reachable)) {
        return {
            status: NO_BACKUP,
            message: `${vip} is held by the master ${masterIp}, but ${describeNodes(others)} not answering, so there is nothing left to fail over to (inferred from reachability; no API access)`,
        };
    }

    return {
        status: OK,
        message: `${vip} and the master ${masterIp} are both up (inferred from reachability; a failover with the master still running would not be seen)`,
    };
}

module.exports = {
    MASTER_HELD,
    MASTER_ONLY,
    BACKUP_HELD,
    NOT_HELD,
    DISPLAY_STATUSES,
    DISPLAY_LABELS,
    toDisplayStatus,
    displayToHeartbeatStatus,
    statusFromMessage,
    evaluatePing,
    VIP_DOWN,
    NO_MASTER,
    UNKNOWN_HOLDER,
    NO_BACKUP,
    HEARTBEAT_STATUS,
    evaluateCluster,
    OK,
    FAILED_OVER,
    SPLIT_BRAIN,
    VIP_MISSING,
    UNREACHABLE,
    INIT,
    MASTER,
    BACKUP,
    UNKNOWN,
    STATUSES,
    LABELS,
    DESCRIPTIONS,
    parseVipStatus,
    findVip,
    describeVip,
    normaliseRole,
    evaluate,
    toHeartbeatStatus,
};
