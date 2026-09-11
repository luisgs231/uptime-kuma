/**
 * Signing in with the device rather than with a password.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasTable("passkey"))) {
        await knex.schema.createTable("passkey", function (table) {
            table.increments("id");
            table.integer("user_id").unsigned().notNullable()
                .references("id").inTable("user")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            // The credential id the authenticator chose, base64url. Text
            // rather than a blob so both dialects index it identically, and
            // because every layer above this handles it as the string the
            // browser sends. A discoverable credential id is 16 to 64 bytes,
            // so 88 characters at the outside; 255 stays well inside MySQL's
            // index length limit even at four bytes per character.
            table.string("credential_id", 255).notNullable().unique();

            // What the owner calls it in their own list. Supplied by the
            // client, never trusted for anything but display.
            table.string("name", 100).notNullable();

            // The whole credential record as the library serialises it: public
            // key, counter, transports, backup flags. One opaque column rather
            // than a column per field, because the shape of this record is the
            // library's rather than ours - it has grown before, and each growth
            // would otherwise be a migration plus a mapping that could quietly
            // drop a field. Nothing here is queried by any of it.
            table.text("credential", "mediumtext").notNullable();

            table.datetime("created_at").notNullable();
            // Signing in touches this, so somebody looking at their own list
            // can tell the phone in their pocket from the laptop they sold.
            table.datetime("last_used_at").nullable();

            table.index("user_id");
        });
    }

    if (!(await knex.schema.hasTable("webauthn_session"))) {
        await knex.schema.createTable("webauthn_session", function (table) {
            table.string("id", 36).notNullable().primary();

            // Null for a sign-in: at the moment the challenge is issued nobody
            // has said who they are. That is the flow rather than a gap - the
            // authenticator names the account by handing back a credential,
            // which is what makes signing in without a username possible.
            table.integer("user_id").unsigned().nullable()
                .references("id").inTable("user")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");

            table.string("purpose", 16).notNullable();
            table.text("data").notNullable();
            table.datetime("created_at").notNullable();
            table.datetime("expires_at").notNullable();

            // Abandoned ceremonies are the normal case, not the exception:
            // somebody presses the button and then puts the phone down.
            // Nothing else deletes those rows, so the sweeper does, and this
            // is what it walks.
            table.index("expires_at");
        });
    }
};

/**
 * Undo the migration.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.down = async function (knex) {
    await knex.schema.dropTableIfExists("webauthn_session");
    await knex.schema.dropTableIfExists("passkey");
};
