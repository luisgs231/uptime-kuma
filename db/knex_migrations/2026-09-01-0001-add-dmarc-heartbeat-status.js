/**
 * A DMARC-specific status carried alongside the generic heartbeat status.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.up = async function (knex) {
    if (await knex.schema.hasColumn("heartbeat", "dmarc_status")) {
        return;
    }
    await knex.schema.alterTable("heartbeat", function (table) {
        table.string("dmarc_status", 32);
    });
};

/**
 * Reverse the column.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.down = function (knex) {
    return knex.schema.alterTable("heartbeat", function (table) {
        table.dropColumn("dmarc_status");
    });
};
