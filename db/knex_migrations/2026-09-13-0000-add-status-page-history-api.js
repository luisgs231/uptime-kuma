/**
 * Opt-in, read-only heartbeat history on the status page API.
 *
 * Both columns are plain boolean/integer with scalar defaults, which knex
 * renders correctly on SQLite and MariaDB alike - unlike a TEXT default, which
 * needs the column compiler in server/utils/knex.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.up = async function (knex) {
    if (await knex.schema.hasColumn("status_page", "api_history_enabled")) {
        return;
    }
    await knex.schema.alterTable("status_page", function (table) {
        table.boolean("api_history_enabled").notNullable().defaultTo(false);
        table.integer("api_history_max").notNullable().defaultTo(100);
    });
};

/**
 * Drop the columns again.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.down = async function (knex) {
    if (!(await knex.schema.hasColumn("status_page", "api_history_enabled"))) {
        return;
    }
    await knex.schema.alterTable("status_page", function (table) {
        table.dropColumn("api_history_enabled");
        table.dropColumn("api_history_max");
    });
};
