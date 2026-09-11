const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");
const TestDB = require("../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");
const { UserSettings } = require("../../server/user-settings");
const { isoCBOR, isoBase64URL } = require("@simplewebauthn/server/helpers");
const ceremony = require("../../server/passkey/ceremony");
const store = require("../../server/passkey/store");
const users = require("../../server/user-management");
const { scratchDir } = require("./helpers");

/**
 * A passkey, end to end, against a software authenticator.
 *
 * The library's own verification is exercised for real here: a key pair is
 * generated, the ceremony is signed exactly as a phone would sign it, and the
 * server verifies the signature. Without this the plumbing could be perfect and
 * nobody could actually sign in.
 */

const ORIGIN = "https://kuma.example.com";
const RP_ID = "kuma.example.com";

/**
 * A software authenticator holding one key pair.
 */
class Authenticator {
    /**
     * Make one key pair, the way a device does when a passkey is enrolled.
     */
    constructor() {
        const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
        this.privateKey = privateKey;
        this.publicKey = publicKey;
        this.credentialID = crypto.randomBytes(32);
        this.counter = 0;
    }

    /** @returns {Uint8Array} The public key in COSE form */
    cosePublicKey() {
        const jwk = this.publicKey.export({ format: "jwk" });
        const x = Buffer.from(jwk.x, "base64url");
        const y = Buffer.from(jwk.y, "base64url");

        // kty EC2, alg ES256, crv P-256, then the coordinates.
        return new Uint8Array(isoCBOR.encode(new Map([
            [ 1, 2 ],
            [ 3, -7 ],
            [ -1, 1 ],
            [ -2, new Uint8Array(x) ],
            [ -3, new Uint8Array(y) ],
        ])));
    }

    /**
     * @param {boolean} attested Whether to include the credential data
     * @returns {Buffer} Authenticator data
     */
    authData(attested) {
        const rpIdHash = crypto.createHash("sha256").update(RP_ID).digest();
        // User present, user verified, backup eligible and backed up, plus the
        // attested credential data on a registration.
        const flags = Buffer.from([ attested ? 0x5d : 0x1d ]);
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(this.counter, 0);

        if (!attested) {
            return Buffer.concat([ rpIdHash, flags, counter ]);
        }

        const aaguid = Buffer.alloc(16);
        const idLength = Buffer.alloc(2);
        idLength.writeUInt16BE(this.credentialID.length, 0);

        return Buffer.concat([
            rpIdHash, flags, counter,
            aaguid, idLength, this.credentialID, Buffer.from(this.cosePublicKey()),
        ]);
    }

    /**
     * @param {string} type webauthn.create or webauthn.get
     * @param {string} challenge The challenge, base64url
     * @returns {Buffer} clientDataJSON
     */
    clientData(type, challenge) {
        return Buffer.from(JSON.stringify({
            type,
            challenge,
            origin: ORIGIN,
            crossOrigin: false,
        }));
    }

    /**
     * Answer a registration ceremony.
     * @param {string} challenge The challenge, base64url
     * @returns {object} A registration response
     */
    register(challenge) {
        const clientDataJSON = this.clientData("webauthn.create", challenge);
        const attestationObject = isoCBOR.encode(new Map([
            [ "fmt", "none" ],
            [ "attStmt", new Map() ],
            [ "authData", new Uint8Array(this.authData(true)) ],
        ]));

        const id = isoBase64URL.fromBuffer(new Uint8Array(this.credentialID));
        return {
            id,
            rawId: id,
            type: "public-key",
            clientExtensionResults: {},
            response: {
                clientDataJSON: isoBase64URL.fromBuffer(new Uint8Array(clientDataJSON)),
                attestationObject: isoBase64URL.fromBuffer(new Uint8Array(attestationObject)),
                transports: [ "internal" ],
            },
        };
    }

    /**
     * Answer a sign-in ceremony.
     * @param {string} challenge The challenge, base64url
     * @returns {object} An authentication response
     */
    authenticate(challenge) {
        this.counter += 1;
        const authData = this.authData(false);
        const clientDataJSON = this.clientData("webauthn.get", challenge);
        const clientDataHash = crypto.createHash("sha256").update(clientDataJSON).digest();

        const signature = crypto.createSign("sha256")
            .update(Buffer.concat([ authData, clientDataHash ]))
            .sign(this.privateKey);

        const id = isoBase64URL.fromBuffer(new Uint8Array(this.credentialID));
        return {
            id,
            rawId: id,
            type: "public-key",
            clientExtensionResults: {},
            response: {
                clientDataJSON: isoBase64URL.fromBuffer(new Uint8Array(clientDataJSON)),
                authenticatorData: isoBase64URL.fromBuffer(new Uint8Array(authData)),
                signature: isoBase64URL.fromBuffer(new Uint8Array(signature)),
                userHandle: null,
            },
        };
    }
}

describe("A passkey, end to end", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-passkey-roundtrip"));
    let alice;
    let user;

    before(async () => {
        await testDB.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    beforeEach(async () => {
        await R.knex("webauthn_session").delete();
        await R.knex("passkey").delete();
        await R.knex("user_setting").delete();
        await R.knex("user").delete();
        await Settings.set("primaryBaseURL", ORIGIN);
        alice = await users.createUser({ username: "alice",
            password: "x" });
        user = await R.knex("user").where("id", alice).first();
    });

    test("register, then sign in with it", async () => {
        const device = new Authenticator();

        const begun = await ceremony.registerBegin(user, ORIGIN);
        assert.strictEqual(begun.options.rp.id, RP_ID);

        const stored = await ceremony.registerFinish(user, {
            ceremonyID: begun.ceremonyID,
            response: device.register(begun.options.challenge),
            name: "",
            userAgent: "Mozilla/5.0 (iPhone)",
        });
        assert.strictEqual(stored.name, "iPhone", "the device is named from the browser");

        const login = await ceremony.loginBegin(ORIGIN);
        const signedIn = await ceremony.loginFinish({
            ceremonyID: login.ceremonyID,
            response: device.authenticate(login.options.challenge),
        });

        assert.strictEqual(signedIn.id, alice, "the credential is what names the account");
        assert.strictEqual(signedIn.username, "alice");

        const list = await store.listForUser(alice);
        assert.ok(list[0].lastUsedAt, "signing in records when the key was used");
    });

    test("the counter moves with each sign-in", async () => {
        const device = new Authenticator();
        const begun = await ceremony.registerBegin(user, ORIGIN);
        await ceremony.registerFinish(user, { ceremonyID: begun.ceremonyID,
            response: device.register(begun.options.challenge),
            name: "one",
            userAgent: "" });

        for (const expected of [ 1, 2 ]) {
            const login = await ceremony.loginBegin(ORIGIN);
            await ceremony.loginFinish({ ceremonyID: login.ceremonyID,
                response: device.authenticate(login.options.challenge) });

            const row = await R.knex("passkey").where("user_id", alice).first();
            assert.strictEqual(JSON.parse(row.credential).counter, expected);
        }
    });

    test("a replayed assertion is refused, because the challenge is spent", async () => {
        const device = new Authenticator();
        const begun = await ceremony.registerBegin(user, ORIGIN);
        await ceremony.registerFinish(user, { ceremonyID: begun.ceremonyID,
            response: device.register(begun.options.challenge),
            name: "one",
            userAgent: "" });

        const login = await ceremony.loginBegin(ORIGIN);
        const response = device.authenticate(login.options.challenge);
        await ceremony.loginFinish({ ceremonyID: login.ceremonyID,
            response });

        await assert.rejects(
            () => ceremony.loginFinish({ ceremonyID: login.ceremonyID,
                response }),
            /expired/,
            "the same assertion must not be usable twice"
        );
    });

    test("a signature from a different key is refused", async () => {
        const device = new Authenticator();
        const begun = await ceremony.registerBegin(user, ORIGIN);
        await ceremony.registerFinish(user, { ceremonyID: begun.ceremonyID,
            response: device.register(begun.options.challenge),
            name: "one",
            userAgent: "" });

        // Same credential id, different private key: what a forged assertion
        // looks like.
        const impostor = new Authenticator();
        impostor.credentialID = device.credentialID;

        const login = await ceremony.loginBegin(ORIGIN);
        await assert.rejects(
            () => ceremony.loginFinish({ ceremonyID: login.ceremonyID,
                response: impostor.authenticate(login.options.challenge) }),
            /could not be verified/
        );
    });

    test("a key registered for one account does not sign in another", async () => {
        const device = new Authenticator();
        const begun = await ceremony.registerBegin(user, ORIGIN);
        await ceremony.registerFinish(user, { ceremonyID: begun.ceremonyID,
            response: device.register(begun.options.challenge),
            name: "one",
            userAgent: "" });

        await users.createUser({ username: "bob",
            password: "x" });

        const login = await ceremony.loginBegin(ORIGIN);
        const signedIn = await ceremony.loginFinish({ ceremonyID: login.ceremonyID,
            response: device.authenticate(login.options.challenge) });
        assert.strictEqual(signedIn.username, "alice");
    });

    test("a deactivated account cannot sign in with its passkey", async () => {
        const device = new Authenticator();
        const begun = await ceremony.registerBegin(user, ORIGIN);
        await ceremony.registerFinish(user, { ceremonyID: begun.ceremonyID,
            response: device.register(begun.options.challenge),
            name: "one",
            userAgent: "" });

        await R.knex("user").where("id", alice).update({ active: 0 });

        const login = await ceremony.loginBegin(ORIGIN);
        await assert.rejects(
            () => ceremony.loginFinish({ ceremonyID: login.ceremonyID,
                response: device.authenticate(login.options.challenge) }),
            /not registered here/
        );
    });

    test("the same key cannot be registered twice", async () => {
        const device = new Authenticator();
        const first = await ceremony.registerBegin(user, ORIGIN);
        await ceremony.registerFinish(user, { ceremonyID: first.ceremonyID,
            response: device.register(first.options.challenge),
            name: "one",
            userAgent: "" });

        const second = await ceremony.registerBegin(user, ORIGIN);
        assert.strictEqual(second.options.excludeCredentials.length, 1, "the browser is told what it already has");

        await assert.rejects(
            () => ceremony.registerFinish(user, { ceremonyID: second.ceremonyID,
                response: device.register(second.options.challenge),
                name: "two",
                userAgent: "" }),
            /already registered/
        );
    });
});
