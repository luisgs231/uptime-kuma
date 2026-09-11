const { Settings } = require("../settings");

/**
 * Which domain a passkey belongs to.
 */

/**
 * Whether a browser will do WebAuthn against this origin at all.
 * @param {URL} url Parsed origin
 * @returns {boolean} True if the origin is a secure context
 */
function isSecureContext(url) {
    if (url.protocol === "https:") {
        return true;
    }
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

/**
 * Parse an origin, returning null rather than throwing on anything unusable.
 * @param {string|null|undefined} value Origin or base URL
 * @returns {URL|null} Parsed URL, or null
 */
function parseOrigin(value) {
    if (typeof value !== "string" || !value.trim()) {
        return null;
    }
    try {
        return new URL(value.trim());
    } catch (e) {
        return null;
    }
}

/**
 * Work out the relying party for a ceremony.
 *
 * The base URL wins when one is set, so a passkey stays bound to the address
 * the instance is normally reached at rather than to whichever hostname this
 * particular browser happened to use. Without one there is nothing else to go
 * on, so the browser's own origin is taken - which is correct for a single
 * hostname and is the only thing that can work for one that is not configured.
 * @param {string|null} origin Origin the browser sent
 * @returns {Promise<object>} rpID, rpName and the origins that may be used
 * @throws {Error} If no usable origin can be worked out
 */
async function resolve(origin) {
    const configured = parseOrigin(await Settings.get("primaryBaseURL"));
    const asked = parseOrigin(origin);
    const url = configured || asked;

    if (!url) {
        throw new Error("Passkeys need a Primary Base URL, or a browser that sends an origin.");
    }
    if (!isSecureContext(url)) {
        throw new Error("Passkeys need HTTPS, or localhost.");
    }
    // A ceremony started from somewhere other than the configured address
    // cannot be completed: the browser signs over its own origin, and the
    // library checks it against this list.
    if (configured && asked && configured.origin !== asked.origin) {
        throw new Error(`Passkeys are bound to ${configured.origin}, but this page was opened at ${asked.origin}.`);
    }

    const title = await Settings.get("title");

    return {
        rpID: url.hostname,
        rpName: (typeof title === "string" && title.trim()) ? title.trim() : "Uptime Kuma",
        origins: [ url.origin ],
    };
}

/**
 * Whether this instance can do passkeys, for a sign-in page that should not
 * offer a button which cannot work.
 * @param {string|null} origin Origin the browser sent
 * @returns {Promise<boolean>} True if a ceremony could be started
 */
async function available(origin) {
    try {
        await resolve(origin);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * The origin a socket connected from.
 * @param {object} socket Socket.io socket
 * @returns {string|null} Origin header, or null
 */
function originOf(socket) {
    return socket?.handshake?.headers?.origin || null;
}

module.exports = {
    resolve,
    available,
    originOf,
    isSecureContext,
    parseOrigin,
};
