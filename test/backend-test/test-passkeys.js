const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const TestDB = require("../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");
const { UserSettings } = require("../../server/user-settings");
const store = require("../../server/passkey/store");
const config = require("../../server/passkey/config");
const ceremony = require("../../server/passkey/ceremony");
const users = require("../../server/user-management");
const { scratchDir } = require("./helpers");

/**
 * A credential in the shape the library hands back.
 * @param {string} id Credential id
 * @returns {object} Credential
 */
function credential(id) {
    return {
        id,
        publicKey: new Uint8Array([ 1, 2, 3, 4, 5 ]),
        counter: 0,
        transports: [ "internal" ],
    };
}

describe("Storing passkeys", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-passkeys"));
    let alice;
    let bob;

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
        alice = await users.createUser({ username: "alice",
            password: "x" });
        bob = await users.createUser({ username: "bob",
            password: "x" });
    });

    test("the migration applies", async () => {
        assert.ok(await R.knex.schema.hasTable("passkey"));
        assert.ok(await R.knex.schema.hasTable("webauthn_session"));
    });

    test("a passkey belongs to one account, and the list never carries the key", async () => {
        await store.add({ userID: alice,
            credentialID: "cred-a",
            name: "Alice's phone",
            credential: ceremony.pack(credential("cred-a")) });

        const list = await store.listForUser(alice);
        assert.strictEqual(list.length, 1);
        assert.strictEqual(list[0].name, "Alice's phone");
        assert.ok(!("credential" in list[0]), "the credential must not reach the browser");
        assert.deepStrictEqual(await store.listForUser(bob), []);
    });

    test("a credential id is unique across the instance, not per account", async () => {
        await store.add({ userID: alice,
            credentialID: "shared",
            name: "one",
            credential: ceremony.pack(credential("shared")) });

        await assert.rejects(() => store.add({ userID: bob,
            credentialID: "shared",
            name: "two",
            credential: ceremony.pack(credential("shared")) }));
    });

    test("renaming and deleting only work on your own", async () => {
        const id = await store.add({ userID: alice,
            credentialID: "cred-a",
            name: "before",
            credential: ceremony.pack(credential("cred-a")) });

        assert.strictEqual(await store.rename(id, bob, "hijacked"), 0);
        assert.strictEqual((await store.listForUser(alice))[0].name, "before");

        assert.strictEqual(await store.remove(id, bob), 0);
        assert.strictEqual((await store.listForUser(alice)).length, 1);

        assert.strictEqual(await store.rename(id, alice, "after"), 1);
        assert.strictEqual((await store.listForUser(alice))[0].name, "after");
        assert.strictEqual(await store.remove(id, alice), 1);
    });

    test("deleting the account takes its passkeys with it", async () => {
        await store.add({ userID: alice,
            credentialID: "cred-a",
            name: "one",
            credential: ceremony.pack(credential("cred-a")) });

        await R.knex("user").where("id", alice).delete();
        assert.strictEqual(await store.findByCredentialID("cred-a"), null);
    });

    test("a public key survives the round trip through the database", async () => {
        const original = credential("cred-a");
        await store.add({ userID: alice,
            credentialID: "cred-a",
            name: "one",
            credential: ceremony.pack(original) });

        const [ back ] = await store.credentialsForUser(alice);
        const restored = ceremony.unpack(back);
        assert.deepStrictEqual([ ...restored.publicKey ], [ ...original.publicKey ]);
        assert.strictEqual(restored.counter, 0);
        assert.deepStrictEqual(restored.transports, [ "internal" ]);
    });

    test("signing in records when a key was last used", async () => {
        const id = await store.add({ userID: alice,
            credentialID: "cred-a",
            name: "one",
            credential: ceremony.pack(credential("cred-a")) });

        assert.strictEqual((await store.listForUser(alice))[0].lastUsedAt, null);
        await store.touch(id, { ...ceremony.pack(credential("cred-a")),
            counter: 7 });

        const row = await R.knex("passkey").where("id", id).first();
        assert.ok(row.last_used_at, "last_used_at must be set");
        assert.strictEqual(JSON.parse(row.credential).counter, 7, "the counter has to move with it");
    });
});

describe("A challenge is spent once", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-passkey-ceremony"));

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
    });

    test("taking it returns what was stored", async () => {
        const id = await store.storeCeremony({ purpose: store.LOGIN,
            data: { challenge: "abc" } });
        const taken = await store.takeCeremony(id, store.LOGIN);
        assert.strictEqual(taken.data.challenge, "abc");
        assert.strictEqual(taken.userID, null, "a sign-in names nobody");
    });

    test("taking it twice does not", async () => {
        const id = await store.storeCeremony({ purpose: store.LOGIN,
            data: { challenge: "abc" } });
        await store.takeCeremony(id, store.LOGIN);
        assert.strictEqual(await store.takeCeremony(id, store.LOGIN), null, "replaying it must fail");
    });

    test("a registration challenge cannot be spent as a sign-in", async () => {
        const id = await store.storeCeremony({ purpose: store.REGISTER,
            data: { challenge: "abc" } });
        assert.strictEqual(await store.takeCeremony(id, store.LOGIN), null);
    });

    test("an expired challenge is refused, and gone either way", async () => {
        const id = await store.storeCeremony({ purpose: store.LOGIN,
            data: { challenge: "abc" } });
        await R.knex("webauthn_session").where("id", id).update({ expires_at: "2000-01-01 00:00:00" });

        assert.strictEqual(await store.takeCeremony(id, store.LOGIN), null);
        assert.strictEqual(await R.knex("webauthn_session").where("id", id).first(), undefined);
    });

    test("nonsense is refused rather than thrown at", async () => {
        assert.strictEqual(await store.takeCeremony("no-such-id", store.LOGIN), null);
        assert.strictEqual(await store.takeCeremony(null, store.LOGIN), null);
    });

    test("the sweeper takes the abandoned ones and leaves the live ones", async () => {
        const live = await store.storeCeremony({ purpose: store.LOGIN,
            data: {} });
        const dead = await store.storeCeremony({ purpose: store.LOGIN,
            data: {} });
        await R.knex("webauthn_session").where("id", dead).update({ expires_at: "2000-01-01 00:00:00" });

        assert.strictEqual(await store.sweep(), 1);
        assert.ok(await R.knex("webauthn_session").where("id", live).first());
    });
});

describe("Which domain a passkey belongs to", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-passkey-config"));

    before(async () => {
        await testDB.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    beforeEach(async () => {
        await Settings.set("primaryBaseURL", "");
        Settings.stopCacheCleaner();
    });

    test("the browser's origin is used when nothing is configured", async () => {
        const rp = await config.resolve("https://kuma.example.com");
        assert.strictEqual(rp.rpID, "kuma.example.com");
        assert.deepStrictEqual(rp.origins, [ "https://kuma.example.com" ]);
    });

    test("the configured base URL wins over the browser's origin", async () => {
        await Settings.set("primaryBaseURL", "https://kuma.example.com");
        const rp = await config.resolve("https://kuma.example.com");
        assert.strictEqual(rp.rpID, "kuma.example.com");
    });

    test("a ceremony from a different address is refused rather than half-working", async () => {
        await Settings.set("primaryBaseURL", "https://kuma.example.com");
        await assert.rejects(
            () => config.resolve("https://other.example.com"),
            /bound to/,
            "a key signed over the wrong origin can never verify"
        );
    });

    test("plain http is refused, because no browser will do it", async () => {
        await assert.rejects(() => config.resolve("http://kuma.example.com"), /HTTPS/);
    });

    test("localhost is allowed, because browsers treat it as secure", async () => {
        const rp = await config.resolve("http://localhost:3001");
        assert.strictEqual(rp.rpID, "localhost");
    });

    test("with nothing to go on at all, it says so", async () => {
        await assert.rejects(() => config.resolve(null), /Primary Base URL/);
    });

    test("available() answers without throwing", async () => {
        assert.strictEqual(await config.available("https://kuma.example.com"), true);
        assert.strictEqual(await config.available("http://kuma.example.com"), false);
        assert.strictEqual(await config.available(null), false);
    });
});

describe("Naming a key its owner will recognise", () => {
    test("what they typed wins", () => {
        assert.strictEqual(store.nameFor("  the yellow YubiKey  ", "Mozilla/5.0 (iPhone)"), "the yellow YubiKey");
    });

    test("otherwise the device is guessed from the browser", () => {
        assert.strictEqual(store.nameFor("", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"), "iPhone");
        assert.strictEqual(store.nameFor("", "Mozilla/5.0 (Macintosh; Intel Mac OS X)"), "Mac");
        assert.strictEqual(store.nameFor("", "Mozilla/5.0 (Windows NT 10.0)"), "Windows PC");
        assert.strictEqual(store.nameFor("", "Mozilla/5.0 (X11; Linux x86_64)"), "Linux computer");
    });

    test("and failing that it is just a passkey", () => {
        assert.strictEqual(store.nameFor("", "something else entirely"), "Passkey");
        assert.strictEqual(store.nameFor(null, ""), "Passkey");
    });

    test("a very long name is cut by characters, not bytes", () => {
        const name = store.nameFor("é".repeat(200), "");
        assert.strictEqual([ ...name ].length, 100);
    });
});

describe("Signing in with a passkey", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-passkey-login"));

    before(async () => {
        await testDB.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    test("an expired ceremony is refused before anything is looked up", async () => {
        await assert.rejects(
            () => ceremony.loginFinish({ ceremonyID: "no-such-id",
                response: { id: "whatever" } }),
            /expired/
        );
    });

    test("an unknown credential is refused", async () => {
        const id = await store.storeCeremony({ purpose: store.LOGIN,
            data: { challenge: "abc",
                rpID: "localhost",
                origins: [ "http://localhost:3001" ] } });

        await assert.rejects(
            () => ceremony.loginFinish({ ceremonyID: id,
                response: { id: "not-registered" } }),
            /not registered/
        );
    });

    test("the user handle is the row id, so renaming an account keeps its keys", () => {
        assert.deepStrictEqual(
            [ ...ceremony.handleFor({ id: 42,
                username: "alice" }) ],
            [ ...new TextEncoder().encode("42") ]
        );
    });
});
