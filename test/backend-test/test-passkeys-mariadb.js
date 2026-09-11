const { describe, test, before, after } = require("node:test");
const assert = require("node:assert");
const path = require("path");

/**
 * The passkey schema against MariaDB.
 */
const CONNECTION = process.env.TEST_MYSQL;

describe("Passkeys on MariaDB", { skip: CONNECTION ? false : "TEST_MYSQL not set" }, () => {
    let db;
    let store;
    let ceremony;
    let Settings;
    let UserSettings;
    let userID;

    before(async () => {
        const KumaColumnCompiler = require("../../server/utils/knex/lib/dialects/mysql2/schema/mysql2-columncompiler");
        const { getDialectByNameOrAlias } = require("knex/lib/dialects");
        const mysql2 = getDialectByNameOrAlias("mysql2");
        mysql2.prototype.columnCompiler = function () {
            return new KumaColumnCompiler(this, ...arguments);
        };

        const url = new URL(CONNECTION);
        const ownDatabase = `${url.pathname.replace(/^\//, "") || "kuma_test"}_passkeys`;

        const withoutDatabase = new URL(CONNECTION);
        withoutDatabase.pathname = "/";
        const admin = require("knex")({ client: "mysql2",
            connection: withoutDatabase.toString() });
        await admin.raw(`CREATE DATABASE IF NOT EXISTS \`${ownDatabase}\` CHARACTER SET utf8mb4`);
        await admin.destroy();

        url.pathname = `/${ownDatabase}`;
        db = require("knex")({
            client: "mysql2",
            connection: url.toString(),
            pool: { min: 0,
                max: 5 },
        });

        const [ tables ] = await db.raw("SHOW TABLES");
        await db.raw("SET FOREIGN_KEY_CHECKS = 0");
        for (const row of tables) {
            await db.raw(`DROP TABLE IF EXISTS \`${Object.values(row)[0]}\``);
        }
        await db.raw("SET FOREIGN_KEY_CHECKS = 1");

        const { R } = require("redbean-node");
        R.setup(db);
        await require("../../db/knex_init_db.js").createTables();
        await db.migrate.latest({ directory: path.resolve(__dirname, "../../db/knex_migrations") });

        store = require("../../server/passkey/store");
        ceremony = require("../../server/passkey/ceremony");
        Settings = require("../../server/settings").Settings;
        UserSettings = require("../../server/user-settings").UserSettings;

        const inserted = await db("user").insert({ username: "alice",
            password: "x",
            active: 1 });
        userID = Array.isArray(inserted) ? inserted[0] : inserted;
    });

    after(async () => {
        Settings?.stopCacheCleaner();
        UserSettings?.stopCacheCleaner();
        if (db) {
            await db.destroy();
        }
    });

    test("the migration applies", async () => {
        assert.ok(await db.schema.hasTable("passkey"));
        assert.ok(await db.schema.hasTable("webauthn_session"));
    });

    test("the credential column is big enough for an attestation, not TEXT", async () => {
        const [ rows ] = await db.raw(
            "SELECT DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'passkey' AND COLUMN_NAME = 'credential'"
        );
        // Plain TEXT caps at 64 KB, and a truncated record is a passkey that
        // enrolled successfully and can never sign anybody in again.
        assert.strictEqual(rows[0].DATA_TYPE, "mediumtext");
    });

    test("the credential id is indexable and unique on MySQL too", async () => {
        await store.add({ userID,
            credentialID: "cred-a",
            name: "one",
            credential: ceremony.pack({ id: "cred-a",
                publicKey: new Uint8Array([ 1, 2, 3 ]),
                counter: 0,
                transports: [] }) });

        await assert.rejects(() => store.add({ userID,
            credentialID: "cred-a",
            name: "two",
            credential: ceremony.pack({ id: "cred-a",
                publicKey: new Uint8Array([ 4 ]),
                counter: 0,
                transports: [] }) }));
    });

    test("a long public key round trips through MEDIUMTEXT", async () => {
        const big = new Uint8Array(200 * 1024).fill(7);
        await store.add({ userID,
            credentialID: "cred-big",
            name: "big",
            credential: ceremony.pack({ id: "cred-big",
                publicKey: big,
                counter: 0,
                transports: [] }) });

        const row = await store.findByCredentialID("cred-big");
        const back = ceremony.unpack(JSON.parse(row.credential));
        assert.strictEqual(back.publicKey.length, big.length, "a truncated key is a passkey that can never sign in");
    });

    test("deleting the account cascades, with the foreign key MySQL actually enforces", async () => {
        await db("passkey").insert({
            user_id: userID,
            credential_id: "cred-cascade",
            name: "one",
            credential: "{}",
            created_at: "2026-09-10 00:00:00",
        });
        await db("user").where("id", userID).delete();
        assert.strictEqual(await store.findByCredentialID("cred-cascade"), null);
    });
});
