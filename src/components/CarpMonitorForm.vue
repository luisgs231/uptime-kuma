<template>
    <div class="carp-monitor-form">
        <h2 class="mb-2">Cluster</h2>

        <p class="form-text mt-0">
            The failure this monitor exists to catch is a
            <strong>silent failover</strong>
            : the pair flips to the backup, every address still answers, and nobody notices for weeks — with no
            redundancy left the whole time. An ordinary uptime check cannot see it, because a working failover is
            exactly what CARP is for.
        </p>

        <div class="my-3">
            <label for="carp-floating-ip" class="form-label">Floating IP</label>
            <input
                id="carp-floating-ip"
                v-model="config.floatingIp"
                type="text"
                class="form-control"
                placeholder="192.0.2.1"
            />
            <div class="form-text">
                The shared address the pair presents. It is probed directly as well as looked up on each node: whoever
                holds it, a floating address that does not answer means the service behind it is down.
            </div>
        </div>

        <div class="my-3">
            <label for="carp-master-ip" class="form-label">Master Node</label>
            <input
                id="carp-master-ip"
                v-model="config.masterIp"
                type="text"
                class="form-control"
                placeholder="192.0.2.2"
            />
            <div class="form-text">
                The node that should normally hold the floating address. The VIP being held by anyone else is what
                counts as a failover. Leave this blank if you genuinely do not mind which node holds it — the monitor
                then only complains when nobody does.
            </div>
        </div>

        <div class="my-3">
            <label for="carp-backup-ips" class="form-label">Other Nodes</label>
            <textarea
                id="carp-backup-ips"
                v-model="backupIpsText"
                class="form-control"
                rows="3"
                spellcheck="false"
                placeholder="192.0.2.3"
            ></textarea>
            <div class="form-text">
                One address per line. Every node listed here is queried too, and that is the point: a node reports only
                its own VIPs, so two nodes both claiming MASTER for the same address — split brain, which drops and
                duplicates traffic — is completely invisible from either one on its own. Asking only the master would
                also mean an unreachable master looks identical to a master that has handed the address over.
            </div>
        </div>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="carp-probe-port" class="form-label">Probe Port</label>
                    <input
                        id="carp-probe-port"
                        v-model.number="config.probePort"
                        type="number"
                        class="form-control"
                        min="0"
                        step="1"
                        placeholder="0"
                    />
                    <div class="form-text">
                        How each address above is tested for life. <strong>0 means ping</strong>, which is the default.
                        If the hosts drop ICMP — firewalls often do — put a TCP port here instead, such as 443 for the
                        OPNsense web GUI. A refused connection still counts as alive: it proves something answered.
                    </div>
                </div>
            </div>
        </div>

        <div v-if="!config.floatingIp" class="alert alert-warning" role="alert">
            No floating IP is configured, so this monitor has nothing to watch and will report that the VIP is missing.
        </div>

        <div v-else-if="nodeCount < 2" class="alert alert-warning" role="alert">
            Fewer than two nodes are configured. Split brain can only be seen by comparing what several nodes say, so
            with one node this monitor reports that node's opinion and nothing more.
        </div>

        <h2 class="mt-5 mb-2">API access <span class="fw-normal text-secondary">optional</span></h2>

        <p class="form-text mt-0">
            With credentials, each node is asked for its VIP status over the OPNsense API. The same credentials are used
            for every node, and the address list above supplies the hosts, so the URL is built per node rather than
            configured once. This is the only way to know which node actually holds the address.
        </p>

        <div class="alert alert-warning" role="alert">
            <strong>Reached by IP address?</strong> Tick <em>Ignore TLS errors</em>. A firewall's certificate has no IP
            in its subject alternative names, so verification cannot succeed and every check will fail on the
            certificate rather than telling you anything about CARP.
        </div>

        <div v-if="!config.apiKey || !config.apiSecret" class="alert alert-warning" role="alert">
            <strong>No credentials: falling back to reachability.</strong>
            The monitor will still report the floating address being down, and will report a failover when the master
            itself stops answering &mdash; a node that does not respond cannot be holding the address. It will
            <em>not</em> see a failover where the master is still running but demoted, and it cannot detect split brain
            at all, since both nodes answering says nothing about which one is master.
        </div>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="carp-scheme" class="form-label">Scheme</label>
                    <select id="carp-scheme" v-model="config.scheme" class="form-select">
                        <option value="https">https</option>
                        <option value="http">http</option>
                    </select>
                    <div class="form-text">
                        The API key and secret travel as HTTP basic auth, so plain http hands them to anything on the
                        path between here and the firewall.
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="my-3">
                    <label for="carp-port" class="form-label">Port</label>
                    <input
                        id="carp-port"
                        v-model.number="config.port"
                        type="number"
                        class="form-control"
                        min="1"
                        max="65535"
                        step="1"
                    />
                    <div class="form-text">The port each node's web interface listens on.</div>
                </div>
            </div>
        </div>

        <div class="my-3">
            <label for="carp-api-key" class="form-label">API Key</label>
            <input
                id="carp-api-key"
                v-model="config.apiKey"
                type="text"
                class="form-control"
                autocomplete="off"
                spellcheck="false"
            />
            <div class="form-text">
                Issued under System → Access → Users. A read-only account is enough: this monitor only ever reads the
                VIP status.
            </div>
        </div>

        <div class="my-3">
            <label for="carp-api-secret" class="form-label">API Secret</label>
            <input
                id="carp-api-secret"
                v-model="config.apiSecret"
                type="password"
                class="form-control"
                autocomplete="new-password"
                placeholder="Unchanged"
            />
            <div class="form-text">
                Leave this blank to keep the secret that is already saved. The stored secret is never sent back to the
                browser, so an empty field means "unchanged" rather than "no secret".
            </div>
        </div>

        <div class="my-3 form-check">
            <input id="carp-ignore-tls" v-model="config.ignoreTls" class="form-check-input" type="checkbox" />
            <label class="form-check-label" for="carp-ignore-tls">Ignore TLS Error</label>
            <div class="form-text">
                Accept self-signed or mismatched certificates. OPNsense ships with a self-signed certificate, so unless
                you have replaced it this is commonly needed — but it does mean the connection is no longer
                authenticated, so only turn it on for a firewall you reach over a network you trust.
            </div>
        </div>

        <h2 class="mt-5 mb-2">Alerting</h2>

        <div class="row">
            <div class="col-md-6">
                <div class="my-3">
                    <label for="carp-vhid" class="form-label">VHID</label>
                    <input
                        id="carp-vhid"
                        v-model="vhid"
                        type="number"
                        class="form-control"
                        min="1"
                        max="255"
                        step="1"
                        placeholder="Any"
                    />
                    <div class="form-text">
                        Optional. A node carrying several virtual addresses reports one row per VHID; setting this
                        narrows the check to the one you mean. Leave it blank to match on the floating address alone.
                    </div>
                </div>
            </div>
            <div class="col-md-6">
                <div class="my-3">
                    <label for="carp-timeout" class="form-label">Timeout (seconds)</label>
                    <input
                        id="carp-timeout"
                        v-model.number="config.timeout"
                        type="number"
                        class="form-control"
                        min="1"
                        max="300"
                        step="1"
                    />
                    <div class="form-text">
                        How long to wait for each node's API. A node that does not answer in time is reported as
                        unreachable, which says nothing about whether its VIPs are healthy.
                    </div>
                </div>
            </div>
        </div>

        <h2 class="mt-4 mb-2">Statuses</h2>

        <p class="form-text mt-0">
            This monitor reports one of four states instead of up and down:
            <strong>MASTER</strong>
            when the node that should hold the floating address is holding it,
            <strong>MASTER ONLY</strong>
            when it is holding it but no other node is left to take over,
            <strong>BACKUP</strong>
            when something else is holding it or it could not be confirmed, and
            <strong>DOWN</strong>
            when nothing is. MASTER ONLY and BACKUP stay amber &mdash; the pair is still carrying traffic, so calling
            it down would be a lie &mdash; but both of them notify anyway. Uptime Kuma never notifies on an amber
            monitor, and a silent failover and a silently dead backup are the failures this monitor exists to catch,
            so it sends those itself.
        </p>
    </div>
</template>

<script>
import { CARP_STATUS_META } from "../monitor-status.ts";

/**
 * The verdicts a monitor can promote.
 */

const DEFAULT_CONFIG = {
    floatingIp: "",
    masterIp: "",
    backupIps: [],
    scheme: "https",
    port: 443,
    probePort: 0,
    apiKey: "",
    apiSecret: "",
    ignoreTls: false,
    vhid: null,
    timeout: 10,
};

/**
 * Split a textarea's contents into a list of trimmed, non-empty entries.
 * @param {string} text Raw textarea value
 * @returns {string[]} One entry per non-blank line
 */
function splitLines(text) {
    return String(text ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
}

/**
 * Fill in every setting the stored config is missing.
 * @param {object|null|undefined} raw Stored carpConfig, if any
 * @returns {object} Config with defaults applied
 */
function normalizeConfig(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const vhid = Number(source.vhid);
    const port = Number(source.port);
    const timeout = Number(source.timeout);

    return {
        ...DEFAULT_CONFIG,
        ...source,
        scheme: source.scheme === "http" ? "http" : "https",
        port: Number.isFinite(port) && port > 0 ? Math.floor(port) : DEFAULT_CONFIG.port,
        apiSecret: "",
        ignoreTls: source.ignoreTls === true,
        backupIps: Array.isArray(source.backupIps) ? [...source.backupIps] : splitLines(source.backupIps),
        vhid: Number.isFinite(vhid) && vhid > 0 ? Math.floor(vhid) : null,
        timeout: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : DEFAULT_CONFIG.timeout,
    };
}

export default {
    name: "CarpMonitorForm",

    props: {
        /** The monitor being edited */
        modelValue: {
            type: Object,
            required: true,
        },
    },

    emits: ["update:modelValue"],

    data() {
        const config = normalizeConfig(this.modelValue.carpConfig);
        return {
            config,
            backupIpsText: config.backupIps.join("\n"),
        };
    },

    computed: {
        /**
         * The verdicts the notification checkboxes cover.
         * @returns {object[]} Status descriptors
         */

        /**
         * How many nodes this monitor will query.
         * @returns {number} Master plus backups
         */
        nodeCount() {
            return (this.config.masterIp ? 1 : 0) + this.config.backupIps.length;
        },

        /**
         * The VHID, with an empty field meaning "match on address alone".
         * @returns {number|string} VHID, or an empty string when unset
         */
        vhid: {
            get() {
                return this.config.vhid ?? "";
            },
            set(value) {
                const vhid = parseInt(value, 10);
                this.config.vhid = Number.isFinite(vhid) && vhid > 0 ? vhid : null;
            },
        },
    },

    watch: {
        backupIpsText(value) {
            this.config.backupIps = splitLines(value);
        },

        config: {
            deep: true,
            handler() {
                this.emitConfig();
            },
        },

        "modelValue.carpConfig"(newConfig) {
            if (newConfig && newConfig !== this.config) {
                this.config = normalizeConfig(newConfig);
                this.backupIpsText = this.config.backupIps.join("\n");
            }
        },
    },

    created() {
        this.emitConfig();
    },

    methods: {
        /**
         * Hand the current config back to the parent's v-model.
         * @returns {void}
         */
        emitConfig() {
            this.$emit("update:modelValue", {
                ...this.modelValue,
                carpConfig: this.config,
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.carp-monitor-form {
    textarea {
        font-family: monospace;
    }

    .badge {
        min-width: 96px;
        font-size: 0.8rem;
    }

    .badge.bg-warning {
        color: $dark-font-color2;
    }

    .description {
        font-size: 0.85rem;
    }

}
</style>
