/**
 * Fetching DMARC report mail over IMAP.
 */
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");
const { log } = require("../../src/util");
const { extractDocuments } = require("./parser");

const DEFAULT_PORT_TLS = 993;
const DEFAULT_PORT_PLAIN = 143;

/**
 * Decide what to fetch, given the stored cursor and the mailbox we just
 * opened.
 * @param {object} state Stored cursor: uidValidity and lastUid
 * @param {object} mailbox Mailbox info from the server
 * @param {number} initialDays How far back to look when there is no usable cursor
 * @param {number} now Current unix time in seconds
 * @returns {object} Fetch plan: mode, range or since, and the reason
 */
function planFetch(state, mailbox, initialDays, now) {
    const stored = state || {};
    const uidValidity = String(mailbox.uidValidity);

    if (!stored.uidValidity) {
        return {
            mode: "date",
            since: new Date((now - initialDays * 86400) * 1000),
            reason: "first run",
        };
    }
    if (String(stored.uidValidity) !== uidValidity) {
        return {
            mode: "date",
            since: new Date((now - initialDays * 86400) * 1000),
            reason: `UIDVALIDITY changed (${stored.uidValidity} -> ${uidValidity}), rescanning`,
        };
    }
    return {
        mode: "uid",
        range: `${(stored.lastUid || 0) + 1}:*`,
        lastUid: stored.lastUid || 0,
        reason: "incremental",
    };
}

/**
 * Connect to the mailbox and pull any report documents not yet seen.
 * @param {object} config Monitor config (imap settings, initialDays, maxMessagesPerRun)
 * @param {object} state Stored cursor from the previous run
 * @returns {Promise<object>} documents, newState and stats
 */
async function fetchDocuments(config, state) {
    const imap = config.imap || {};
    if (!imap.host) {
        throw new Error("IMAP host is required");
    }
    if (!imap.username) {
        throw new Error("IMAP username is required");
    }

    const secure = imap.secure !== false;
    const client = new ImapFlow({
        host: imap.host,
        port: Number(imap.port) || (secure ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN),
        secure,
        auth: {
            user: imap.username,
            pass: imap.password || "",
        },
        tls: {
            rejectUnauthorized: !imap.ignoreTls,
        },
        // Without these a wedged server would hold the check open indefinitely.
        connectionTimeout: 20000,
        greetingTimeout: 15000,
        socketTimeout: 120000,
        logger: false,
        emitLogs: false,
    });

    const folder = imap.folder || "INBOX";
    const maxMessages = Number(config.maxMessagesPerRun) || 500;
    const now = Math.floor(Date.now() / 1000);

    const documents = [];
    const stats = { messages: 0,
        attachments: 0,
        skipped: 0 };
    let newState = { ...(state || {}) };

    await client.connect();
    try {
        // readOnly keeps the server from setting \Seen on everything we touch.
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
            const mailbox = client.mailbox;
            const plan = planFetch(state, mailbox, Number(config.initialDays) || 30, now);
            log.debug("dmarc", `Mailbox ${folder}: ${plan.reason}`);

            let uids;
            if (plan.mode === "date") {
                uids = await client.search({ since: plan.since }, { uid: true });
            } else {
                uids = (await client.search({ uid: plan.range }, { uid: true }))
                    .filter((uid) => uid > plan.lastUid);
            }
            uids = (uids || []).sort((a, b) => a - b);

            if (uids.length > maxMessages) {
                stats.skipped = uids.length - maxMessages;
                log.info("dmarc", `${uids.length} messages to read, processing the oldest ${maxMessages} this run`);
                uids = uids.slice(0, maxMessages);
            }

            let highestUid = plan.mode === "uid" ? plan.lastUid : 0;

            if (uids.length) {
                for await (const msg of client.fetch(uids, { uid: true,
                    source: true }, { uid: true })) {
                    stats.messages++;
                    if (msg.uid > highestUid) {
                        highestUid = msg.uid;
                    }
                    try {
                        const parsed = await simpleParser(msg.source);
                        for (const attachment of parsed.attachments || []) {
                            const found = extractDocuments(attachment.content);
                            stats.attachments += found.length;
                            documents.push(...found);
                        }
                        // A few senders inline the report instead of attaching it.
                        if (!(parsed.attachments || []).length && parsed.text) {
                            documents.push(...extractDocuments(Buffer.from(parsed.text)));
                        }
                    } catch (e) {
                        log.warn("dmarc", `Could not parse message uid ${msg.uid}: ${e.message}`);
                    }
                }
            }

            newState = {
                uidValidity: String(mailbox.uidValidity),
                lastUid: highestUid,
                lastRun: now,
            };
        } finally {
            lock.release();
        }
    } finally {
        try {
            await client.logout();
        } catch (e) {
            client.close();
        }
    }

    return { documents,
        newState,
        stats };
}

module.exports = {
    fetchDocuments,
    planFetch,
};
