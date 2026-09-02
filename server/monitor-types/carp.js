const { MonitorType } = require("./monitor-type");
const axios = require("axios");
const https = require("https");
const dayjs = require("dayjs");
const { previousStatuses, maybeNotify } = require("../dmarc/notify");
const { ping } = require("../util-server");
const net = require("net");

const carpStatus = require("../carp/status");
const { formatStatusPrefix } = require("../../src/monitor-status");

/**
 * Where OPNsense reports the state of its virtual IPs.
 */
const VIP_STATUS_PATH = "/api/diagnostics/interface/get_vip_status";

/** Node's TLS failures, which all want the same advice. */

const CONFIG_DEFAULTS = {
    floatingIp: "",

    // The node that should normally hold it, and the others that should not.
    masterIp: "",
    backupIps: [],

    scheme: "https",
    port: 443,

    apiKey: "",
    apiSecret: "",

    ignoreTls: false,

    // Narrows which VIP is meant when a node carries several.
    vhid: null,

    probePort: 0,

    notifyOnStatusChange: true,

    timeout: 10,
};


/**
 * Parse the stored config, filling in anything missing.
 * @param {string|object|null} raw Value of monitor.carp_config
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
    const selector = parsed.selector && typeof parsed.selector === "object" ? parsed.selector : {};
    return {
        ...CONFIG_DEFAULTS,
        ...parsed,
        selector,
        expectedRole: carpStatus.normaliseRole(parsed.expectedRole),
        timeout: Number(parsed.timeout) > 0 ? Number(parsed.timeout) : CONFIG_DEFAULTS.timeout,
    };
}

/**
 * The config with the API secret removed, for anything leaving the server that
 * has not asked for sensitive data - the monitor list the browser receives, in
 * particular.
 * @param {string|object|null} raw Value of monitor.carp_config
 * @returns {object} Config without the secret
 */
function redactConfig(raw) {
    return {
        ...parseConfig(raw),
        apiSecret: "",
    };
}

/**
 * Build the VIP status URL from the configured base URL.
 * @param {string} url Configured base URL
 * @returns {string} Absolute URL of the VIP status endpoint
 * @throws {Error} If no URL is configured, or it is not an http(s) URL
 */
function buildEndpoint(url) {
    const base = String(url ?? "")
        .trim()
        .replace(/\/+$/, "");
    if (!base) {
        throw new Error("No firewall URL is configured");
    }

    let parsed;
    try {
        parsed = new URL(base);
    } catch (e) {
        throw new Error(`"${base}" is not a valid URL. It should look like https://opnsense.lan`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error(`"${base}" is not an http or https URL`);
    }

    return base.endsWith(VIP_STATUS_PATH) ? base : base + VIP_STATUS_PATH;
}



/**
 * CARP failover monitor type.
 */
/** TLS failures that mean verification cannot succeed against this host. */
const TLS_FAILURES = [
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "CERT_HAS_EXPIRED",
];

/**
 * Turn a request failure into something worth reading.
 * @param {Error} e The thrown error
 * @returns {string} A short, actionable description
 */
function describeError(e) {
    const code = e.code || "";
    if (TLS_FAILURES.includes(code) || /altnames|self.signed|certificate/i.test(e.message || "")) {
        return "certificate not accepted - enable \"Ignore TLS errors\", a firewall reached by IP cannot match its certificate";
    }
    if (code === "ECONNREFUSED") {
        return "connection refused";
    }
    if (code === "ETIMEDOUT" || code === "ECONNABORTED") {
        return "no response";
    }
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
        return "address not resolvable";
    }
    if (code === "EHOSTUNREACH" || code === "ENETUNREACH") {
        return "host unreachable";
    }
    return e.message;
}

class CarpMonitorType extends MonitorType {
    name = "carp";

    allowCustomStatus = true;

    /**
     * @inheritdoc
     */
    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        const startTime = dayjs().valueOf();
        const config = parseConfig(monitor.carp_config);

        if (!config.floatingIp) {
            this.applyStatus(heartbeat, carpStatus.VIP_MISSING, "No floating IP is configured", config);
            return;
        }

        // Does the shared address answer at all? Nothing else matters if not.
        const floatingIpUp = await this.isReachable(config.floatingIp, config);

        const addresses = [ config.masterIp, ...(config.backupIps || []) ].filter(Boolean);

        const apiAvailable = !!(config.apiKey && config.apiSecret);

        const nodes = [];
        for (const ip of addresses) {
            if (apiAvailable) {
                nodes.push(await this.queryNode(ip, config));
            } else {
                nodes.push({ ip,
                    reachable: await this.isReachable(ip, config),
                    role: null,
                    error: "" });
            }
        }

        const { status, message } = apiAvailable
            ? carpStatus.evaluateCluster({
                floatingIp: config.floatingIp,
                floatingIpUp,
                masterIp: config.masterIp,
                nodes,
            })
            : carpStatus.evaluatePing({
                floatingIp: config.floatingIp,
                floatingIpUp,
                masterIp: config.masterIp,
                nodes,
            });

        const unreachable = nodes.filter((n) => !n.reachable);
        let detail = message;
        if (apiAvailable && unreachable.length && status !== carpStatus.VIP_DOWN) {
            detail += ` (${unreachable.length} node(s) unreachable: ${unreachable.map((n) => `${n.ip} - ${n.error}`).join("; ")})`;
        }

        heartbeat.ping = dayjs().valueOf() - startTime;
        this.applyStatus(heartbeat, status, detail, config);

        const context = await previousStatuses(monitor.id);
        await maybeNotify(monitor, heartbeat, {
            ...context,
            previousStatus: carpStatus.statusFromMessage(context.previousMsg),
            status: carpStatus.toDisplayStatus(status),
            enabled: config.notifyOnStatusChange !== false,
        });
    }

    /**
     * Record the outcome on the heartbeat.
     * @param {object} heartbeat Heartbeat to update
     * @param {string} status CARP status
     * @param {string} message Human readable message
     * @param {object} config Monitor config
     * @returns {void}
     */
    applyStatus(heartbeat, status, message, config) {
        const display = carpStatus.toDisplayStatus(status);
        heartbeat.status = carpStatus.displayToHeartbeatStatus(display);
        heartbeat.msg = `${formatStatusPrefix("carp", display)}${message}`;
    }

    /**
     * Whether an address is answering.
     * @param {string} address Address to probe
     * @param {object} config Monitor config
     * @returns {Promise<boolean>} True if it answered
     */
    async isReachable(address, config) {
        const port = Number(config.probePort);
        const timeout = (Number(config.timeout) || 10) * 1000;

        if (!port) {
            try {
                await ping(address, 2);
                return true;
            } catch (e) {
                return false;
            }
        }

        return new Promise((resolve) => {
            const socket = new net.Socket();
            let settled = false;
            const finish = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                resolve(result);
            };
            socket.setTimeout(timeout);
            socket.once("connect", () => finish(true));
            socket.once("timeout", () => finish(false));
            socket.once("error", (e) => finish(e.code === "ECONNREFUSED"));
            socket.connect(port, address);
        });
    }

    /**
     * Ask one node which role it holds for the configured VIP.
     * @param {string} ip Node address
     * @param {object} config Monitor config
     * @returns {Promise<object>} ip, reachable, role and error
     */
    async queryNode(ip, config) {
        const result = { ip,
            reachable: false,
            role: null,
            error: "" };

        try {
            const url = buildEndpoint(`${config.scheme}://${ip}:${config.port}`);
            const response = await axios.get(url, {
                auth: { username: config.apiKey,
                    password: config.apiSecret },
                httpsAgent: new https.Agent({ rejectUnauthorized: !config.ignoreTls }),
                timeout: (config.timeout || 10) * 1000,
                maxRedirects: 0,
                validateStatus: () => true,
            });

            if (response.status === 401 || response.status === 403) {
                result.error = "authentication rejected (check the API key and secret)";
                return result;
            }
            if (response.status === 404) {
                result.error = "API path not found (unsupported OPNsense version?)";
                return result;
            }
            if (response.status >= 300) {
                result.error = `HTTP ${response.status}`;
                return result;
            }

            const vips = carpStatus.parseVipStatus(response.data);
            const selector = config.vhid ? { vhid: config.vhid,
                address: config.floatingIp } : { address: config.floatingIp };
            let vip = carpStatus.findVip(vips, selector);
            if (!vip && config.vhid) {
                vip = carpStatus.findVip(vips, { vhid: config.vhid });
            }

            result.reachable = true;
            result.role = vip ? carpStatus.normaliseRole(vip.status) : null;
            if (!vip) {
                result.error = "VIP not present on this node";
            }
        } catch (e) {
            result.error = describeError(e);
        }
        return result;
    }
}

/**
 * Serialise a config for storage, keeping the stored API secret when the form
 * submits a blank one.
 * @param {object} incoming Config supplied by the client
 * @param {string|object|null} existing Currently stored config
 * @returns {string} JSON to write to monitor.carp_config
 */
function serializeConfig(incoming, existing) {
    const current = parseConfig(existing);
    const next = parseConfig(incoming);
    if (!next.apiSecret) {
        next.apiSecret = current.apiSecret;
    }
    return JSON.stringify(next);
}

module.exports = {
    CarpMonitorType,
    describeError,
    serializeConfig,
    parseConfig,
    redactConfig,
    buildEndpoint,
    VIP_STATUS_PATH,
};
