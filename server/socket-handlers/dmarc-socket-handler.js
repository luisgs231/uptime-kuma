const { checkLogin } = require("../util-server");
const { log } = require("../../src/util");
const store = require("../dmarc/store");
const tlsStore = require("../tlsrpt/store");

const MIN_DAYS = 1;


/**
 * Clamp a client-supplied window to something sane.
 * @param {*} days Raw value from the client
 * @returns {number} Window in days
 */
function safeDays(days) {
    const n = parseInt(days, 10);
    if (!Number.isFinite(n) || n < MIN_DAYS) {
        return 30;
    }
    return n;
}

/**
 * Normalise the optional domain filter.
 * @param {*} domain Raw value from the client
 * @returns {string|null} Domain, or null for "all domains"
 */
function safeDomain(domain) {
    if (typeof domain !== "string" || !domain.trim()) {
        return null;
    }
    return domain.trim().toLowerCase();
}

/**
 * Confirm the monitor belongs to the logged-in user.
 * @param {Socket} socket Socket connection
 * @param {*} monitorID Monitor id from the client
 * @returns {Promise<number>} The validated monitor id
 */
async function ownedMonitorID(socket, monitorID) {
    const { R } = require("redbean-node");
    const id = parseInt(monitorID, 10);
    if (!Number.isFinite(id)) {
        throw new Error("Invalid monitor id");
    }
    const row = await R.knex("monitor").where({ id,
        user_id: socket.userID }).first("id");
    if (!row) {
        throw new Error("Monitor not found");
    }
    return id;
}

/**
 * Socket handlers backing the DMARC report pages.
 * @param {Socket} socket Socket connection
 * @returns {void}
 */
module.exports.dmarcSocketHandler = (socket) => {
    socket.on("getDmarcSummary", async (monitorID, days, callback) => {
        try {
            checkLogin(socket);
            const id = await ownedMonitorID(socket, monitorID);
            callback({
                ok: true,
                data: { domains: await store.getDomainSummary(id, safeDays(days)) },
            });
        } catch (e) {
            log.warn("dmarc", `getDmarcSummary failed: ${e.message}`);
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("getDmarcDomains", async (monitorID, callback) => {
        try {
            checkLogin(socket);
            const id = await ownedMonitorID(socket, monitorID);
            callback({
                ok: true,
                data: await store.getKnownDomains(id),
            });
        } catch (e) {
            log.warn("dmarc", `getDmarcDomains failed: ${e.message}`);
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("getDmarcTimeline", async (monitorID, domain, days, callback) => {
        try {
            checkLogin(socket);
            const id = await ownedMonitorID(socket, monitorID);
            callback({
                ok: true,
                data: await store.getTimeline(id, safeDomain(domain), safeDays(days)),
            });
        } catch (e) {
            log.warn("dmarc", `getDmarcTimeline failed: ${e.message}`);
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("getDmarcSources", async (monitorID, domain, days, callback) => {
        try {
            checkLogin(socket);
            const id = await ownedMonitorID(socket, monitorID);
            callback({
                ok: true,
                data: await store.getSources(id, safeDomain(domain), safeDays(days)),
            });
        } catch (e) {
            log.warn("dmarc", `getDmarcSources failed: ${e.message}`);
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("getTlsrptSummary", async (monitorID, domain, days, callback) => {
        try {
            checkLogin(socket);
            const id = await ownedMonitorID(socket, monitorID);
            callback({
                ok: true,
                data: await tlsStore.getSummary(id, safeDomain(domain), safeDays(days)),
            });
        } catch (e) {
            log.warn("dmarc", `getTlsrptSummary failed: ${e.message}`);
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("getTlsrptFailures", async (monitorID, domain, days, callback) => {
        try {
            checkLogin(socket);
            const id = await ownedMonitorID(socket, monitorID);
            callback({
                ok: true,
                data: await tlsStore.getFailures(id, safeDomain(domain), safeDays(days)),
            });
        } catch (e) {
            log.warn("dmarc", `getTlsrptFailures failed: ${e.message}`);
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("getDmarcReports", async (monitorID, domain, limit, callback) => {
        try {
            checkLogin(socket);
            const id = await ownedMonitorID(socket, monitorID);
            const n = parseInt(limit, 10);
            callback({
                ok: true,
                data: await store.getRecentReports(id, safeDomain(domain), Number.isFinite(n) ? n : 50),
            });
        } catch (e) {
            log.warn("dmarc", `getDmarcReports failed: ${e.message}`);
            callback({ ok: false,
                msg: e.message });
        }
    });
};
