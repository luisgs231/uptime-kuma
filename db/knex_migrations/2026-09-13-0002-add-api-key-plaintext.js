/**
 * Keep the API key itself, so it can be shown again rather than only once.
 *
 * `key` stays the hash and remains what verification checks - this column is
 * only for display. Keys created before it exist stay NULL: their plaintext was
 * never stored and cannot be recovered.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.up = async function (knex) {
    if (await knex.schema.hasColumn("api_key", "key_plain")) {
        return;
    }
    await knex.schema.alterTable("api_key", function (table) {
        table.text("key_plain").nullable();
    });
};

/**
 * Drop it again.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.down = async function (knex) {
    if (!(await knex.schema.hasColumn("api_key", "key_plain"))) {
        return;
    }
    await knex.schema.alterTable("api_key", function (table) {
        table.dropColumn("key_plain");
    });
};
