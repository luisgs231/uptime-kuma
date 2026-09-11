const {
    generateRegistrationOptions,
    verifyRegistrationResponse,
    generateAuthenticationOptions,
    verifyAuthenticationResponse,
} = require("@simplewebauthn/server");
const { isoBase64URL } = require("@simplewebauthn/server/helpers");
const { R } = require("redbean-node");
const { log } = require("../../src/util");
const config = require("./config");
const store = require("./store");

/**
 * The two halves of a WebAuthn ceremony.
 */

/**
 * The user handle written into the authenticator.
 *
 * It has to be stable - change it and every enrolled key stops matching its
 * account - and it must not be the username, because a handle is stored on the
 * device and shown in the phone's own passkey list, where a rename would leave
 * it stale forever. The row id is neither.
 * @param {object} user User row
 * @returns {Uint8Array} The handle
 */
function handleFor(user) {
    return new TextEncoder().encode(String(user.id));
}

/**
 * Store a credential in a shape that survives JSON.
 * @param {object} credential Credential from the library
 * @returns {object} Serialisable credential
 */
function pack(credential) {
    return {
        id: credential.id,
        publicKey: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports || [],
    };
}

/**
 * Turn a stored credential back into what the library expects.
 * @param {object} credential Stored credential
 * @returns {object} Credential for the library
 */
function unpack(credential) {
    return {
        ...credential,
        publicKey: isoBase64URL.toBuffer(credential.publicKey),
    };
}

/**
 * Start enrolling a passkey for an account that is already signed in.
 * @param {object} user User row
 * @param {string|null} origin Origin the browser sent
 * @returns {Promise<object>} ceremonyID and the options for the browser
 */
async function registerBegin(user, origin) {
    const rp = await config.resolve(origin);
    const existing = await store.credentialsForUser(user.id);

    const options = await generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpID,
        userID: handleFor(user),
        userName: user.username,
        userDisplayName: user.username,
        attestationType: "none",
        // Offering a key the account already has is how a browser knows to say
        // "you already registered this device" rather than silently enrolling
        // a second credential for it.
        excludeCredentials: existing.map((c) => ({
            id: c.id,
            transports: c.transports,
        })),
        authenticatorSelection: {
            residentKey: "required",
            userVerification: "preferred",
        },
    });

    const ceremonyID = await store.storeCeremony({
        userID: user.id,
        purpose: store.REGISTER,
        data: {
            challenge: options.challenge,
            rpID: rp.rpID,
            origins: rp.origins,
        },
    });

    return { ceremonyID,
        options };
}

/**
 * Finish enrolling a passkey.
 * @param {object} user User row
 * @param {object} input The response
 * @param {string} input.ceremonyID Ceremony this answers
 * @param {object} input.response What the browser produced
 * @param {string} input.name What to call it
 * @param {string} input.userAgent Browser that enrolled it
 * @returns {Promise<object>} The stored passkey
 * @throws {Error} If the ceremony is unknown, expired or does not verify
 */
async function registerFinish(user, { ceremonyID, response, name, userAgent }) {
    const ceremony = await store.takeCeremony(ceremonyID, store.REGISTER);
    if (!ceremony || ceremony.userID !== user.id) {
        throw new Error("That registration has expired. Start again.");
    }

    const verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: ceremony.data.challenge,
        expectedOrigin: ceremony.data.origins,
        expectedRPID: ceremony.data.rpID,
        requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
        throw new Error("That passkey could not be verified.");
    }

    const credential = verification.registrationInfo.credential;

    if (await store.findByCredentialID(credential.id)) {
        throw new Error("That passkey is already registered.");
    }

    const id = await store.add({
        userID: user.id,
        credentialID: credential.id,
        name: store.nameFor(name, userAgent),
        credential: pack(credential),
    });

    log.info("passkey", `Account ${user.username} registered a passkey`);

    const row = await R.knex("passkey").where("id", id).first();
    return store.toPublic(row);
}

/**
 * Start signing in with a passkey.
 *
 * No username is asked for and none is needed: the authenticator names the
 * account by handing back a credential, which is what the credential id is
 * looked up by when the ceremony finishes.
 * @param {string|null} origin Origin the browser sent
 * @returns {Promise<object>} ceremonyID and the options for the browser
 */
async function loginBegin(origin) {
    const rp = await config.resolve(origin);

    const options = await generateAuthenticationOptions({
        rpID: rp.rpID,
        userVerification: "preferred",
    });

    const ceremonyID = await store.storeCeremony({
        userID: null,
        purpose: store.LOGIN,
        data: {
            challenge: options.challenge,
            rpID: rp.rpID,
            origins: rp.origins,
        },
    });

    return { ceremonyID,
        options };
}

/**
 * Finish signing in with a passkey.
 * @param {object} input The response
 * @param {string} input.ceremonyID Ceremony this answers
 * @param {object} input.response What the browser produced
 * @returns {Promise<object>} The user row that owns the passkey
 * @throws {Error} If the ceremony or the passkey is not usable
 */
async function loginFinish({ ceremonyID, response }) {
    const ceremony = await store.takeCeremony(ceremonyID, store.LOGIN);
    if (!ceremony) {
        throw new Error("That sign-in has expired. Try again.");
    }

    const row = await store.findByCredentialID(response?.id);
    if (!row) {
        throw new Error("That passkey is not registered here.");
    }

    const user = await R.knex("user").where({ id: row.user_id,
        active: 1 }).first();
    if (!user) {
        throw new Error("That passkey is not registered here.");
    }

    const stored = JSON.parse(row.credential);

    const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ceremony.data.challenge,
        expectedOrigin: ceremony.data.origins,
        expectedRPID: ceremony.data.rpID,
        credential: unpack(stored),
        requireUserVerification: false,
    });

    if (!verification.verified) {
        throw new Error("That passkey could not be verified.");
    }

    // The counter is how an authenticator that can be cloned gives itself away.
    // Keys in secure elements report zero and never move; the check is only
    // meaningful when the number is actually counting.
    await store.touch(row.id, {
        ...stored,
        counter: verification.authenticationInfo.newCounter,
    });

    log.info("passkey", `Account ${user.username} signed in with a passkey`);
    return user;
}

module.exports = {
    handleFor,
    pack,
    unpack,
    registerBegin,
    registerFinish,
    loginBegin,
    loginFinish,
};
