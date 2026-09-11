const { R } = require("redbean-node");
const dayjs = require("dayjs");
dayjs.extend(require("dayjs/plugin/utc"));
const crypto = require("crypto");
const { log } = require("../../src/util");

/**
 * Reading and writing passkeys, and the challenges held between the two halves
 * of a ceremony.
 */

/** How long an unfinished ceremony stays usable. */
const CEREMONY_TTL_MS = 5 * 60 * 1000;

const REGISTER = "register";
const LOGIN = "login";

/**
 * Now, in the format both dialects store.
 * @returns {string} Timestamp
 */
function now() {
    return R.isoDateTime(dayjs.utc());
}

/**
 * A passkey as its owner sees it, without the credential itself.
 * @param {object} row Row from the passkey table
 * @returns {object} Safe to send to the browser
 */
function toPublic(row) {
    return {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
    };
}

/**
 * Every passkey an account owns.
 * @param {number} userID Account id
 * @returns {Promise<object[]>} Passkeys, newest last
 */
async function listForUser(userID) {
    const rows = await R.knex("passkey").where("user_id", userID).orderBy("id", "asc");
    return rows.map(toPublic);
}

/**
 * The credential records the library needs to verify an account's keys.
 * @param {number} userID Account id
 * @returns {Promise<object[]>} Credentials as the library serialised them
 */
async function credentialsForUser(userID) {
    const rows = await R.knex("passkey").where("user_id", userID);
    return rows.map((row) => JSON.parse(row.credential));
}

/**
 * Find a passkey by the credential id the authenticator handed back.
 * @param {string} credentialID Credential id, base64url
 * @returns {Promise<object|null>} The row, or null
 */
async function findByCredentialID(credentialID) {
    const row = await R.knex("passkey").where("credential_id", credentialID).first();
    return row || null;
}

/**
 * Store a newly registered passkey.
 * @param {object} input The passkey
 * @param {number} input.userID Owner
 * @param {string} input.credentialID Credential id, base64url
 * @param {string} input.name Display name
 * @param {object} input.credential Credential record to serialise
 * @returns {Promise<number>} The new row's id
 */
async function add({ userID, credentialID, name, credential }) {
    const [ id ] = await R.knex("passkey").insert({
        user_id: userID,
        credential_id: credentialID,
        name,
        credential: JSON.stringify(credential),
        created_at: now(),
        last_used_at: null,
    });
    return id;
}

/**
 * Rename a passkey, if it belongs to this account.
 * @param {number} id Passkey id
 * @param {number} userID Account that must own it
 * @param {string} name New name
 * @returns {Promise<number>} Rows changed
 */
async function rename(id, userID, name) {
    return R.knex("passkey").where({ id,
        user_id: userID }).update({ name });
}

/**
 * Delete a passkey, if it belongs to this account.
 * @param {number} id Passkey id
 * @param {number} userID Account that must own it
 * @returns {Promise<number>} Rows deleted
 */
async function remove(id, userID) {
    return R.knex("passkey").where({ id,
        user_id: userID }).delete();
}

/**
 * Record that a passkey was just used, and store the counter the
 * authenticator reported.
 * @param {number} id Passkey id
 * @param {object} credential Updated credential record
 * @returns {Promise<void>} Promise
 */
async function touch(id, credential) {
    await R.knex("passkey").where("id", id).update({
        last_used_at: now(),
        credential: JSON.stringify(credential),
    });
}

/**
 * Hold the challenge for one ceremony.
 *
 * Server-side rather than in a signed token: a challenge exists to be used
 * exactly once, and a stateless token cannot be spent - it stays valid until it
 * expires, which turns "once" into "as often as you like for the next five
 * minutes". Deleting the row is what spends it.
 * @param {object} input The ceremony
 * @param {number|null} input.userID Owner, or null for a sign-in
 * @param {string} input.purpose register or login
 * @param {object} input.data Whatever the second half needs
 * @returns {Promise<string>} The ceremony id
 */
async function storeCeremony({ userID = null, purpose, data }) {
    const id = crypto.randomUUID();
    await R.knex("webauthn_session").insert({
        id,
        user_id: userID,
        purpose,
        data: JSON.stringify(data),
        created_at: now(),
        expires_at: R.isoDateTime(dayjs.utc().add(CEREMONY_TTL_MS, "millisecond")),
    });
    return id;
}

/**
 * Spend a ceremony: read it and delete it in the same breath.
 * @param {string} id Ceremony id
 * @param {string} purpose The purpose it must have been issued for
 * @returns {Promise<object|null>} The stored data, or null if there is none
 */
async function takeCeremony(id, purpose) {
    if (typeof id !== "string" || !id) {
        return null;
    }
    const row = await R.knex("webauthn_session").where({ id,
        purpose }).first();

    // Gone either way, whether it was usable or not.
    await R.knex("webauthn_session").where("id", id).delete();

    if (!row) {
        return null;
    }
    if (dayjs.utc(row.expires_at).isBefore(dayjs.utc())) {
        return null;
    }
    return {
        userID: row.user_id,
        data: JSON.parse(row.data),
    };
}

/**
 * Delete ceremonies nobody finished.
 * @returns {Promise<number>} Rows deleted
 */
async function sweep() {
    const deleted = await R.knex("webauthn_session").where("expires_at", "<", now()).delete();
    if (deleted) {
        log.debug("passkey", `Swept ${deleted} abandoned ceremonies`);
    }
    return deleted;
}

/**
 * A name for a key its owner will recognise, when they did not supply one.
 * @param {string} given Name the client sent
 * @param {string} userAgent User agent of the browser that enrolled it
 * @returns {string} Display name
 */
function nameFor(given, userAgent) {
    const trimmed = typeof given === "string" ? given.trim() : "";
    if (trimmed) {
        return [ ...trimmed ].slice(0, 100).join("");
    }
    const probes = [
        [ "iPhone", "iPhone" ],
        [ "iPad", "iPad" ],
        [ "Android", "Android device" ],
        [ "Macintosh", "Mac" ],
        [ "Windows", "Windows PC" ],
        [ "Linux", "Linux computer" ],
    ];
    for (const [ needle, name ] of probes) {
        if (typeof userAgent === "string" && userAgent.includes(needle)) {
            return name;
        }
    }
    return "Passkey";
}

module.exports = {
    CEREMONY_TTL_MS,
    REGISTER,
    LOGIN,
    toPublic,
    listForUser,
    credentialsForUser,
    findByCredentialID,
    add,
    rename,
    remove,
    touch,
    storeCeremony,
    takeCeremony,
    sweep,
    nameFor,
};
