/**
 * Drop the status page history API columns again.
 *
 * The feature they backed was replaced by API-key access before it was ever
 * switched on anywhere. 2026-09-13-0000 is left in place rather than deleted:
 * it has already run on deployed instances, and knex refuses to start when a
 * migration it recorded is missing from the directory.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("status_page", "api_history_enabled"))) {
        return;
    }
    await knex.schema.alterTable("status_page", function (table) {
        table.dropColumn("api_history_enabled");
        table.dropColumn("api_history_max");
    });
};

/**
 * Put them back.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.down = async function (knex) {
    if (await knex.schema.hasColumn("status_page", "api_history_enabled")) {
        return;
    }
    await knex.schema.alterTable("status_page", function (table) {
        table.boolean("api_history_enabled").notNullable().defaultTo(false);
        table.integer("api_history_max").notNullable().defaultTo(100);
    });
};
