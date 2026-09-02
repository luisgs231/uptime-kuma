/**
 * Schema for the SMTP TLS reporting, blocklist and CARP monitors.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("monitor", "rbl_config"))) {
        await knex.schema.alterTable("monitor", function (table) {
            table.text("rbl_config");
            table.text("carp_config");
        });
    }
    if (await knex.schema.hasTable("tlsrpt_report")) {
        return;
    }
    await knex.schema
        .createTable("tlsrpt_report", function (table) {
            table.increments("id");
            table.integer("monitor_id").unsigned().notNullable()
                .references("id").inTable("monitor").onDelete("CASCADE");

            table.string("org_name", 255).notNullable();
            table.string("report_id", 255).notNullable();
            table.string("contact_info", 255);
            table.string("domain", 255).notNullable();

            // Unix seconds; bigInteger so this outlives 2038 on MySQL.
            table.bigInteger("date_begin").notNullable();
            table.bigInteger("date_end").notNullable();

            table.string("policy_type", 32);
            table.integer("success_count").notNullable().defaultTo(0);
            table.integer("failure_count").notNullable().defaultTo(0);
            table.bigInteger("ingested_at").notNullable();

            table.unique([ "monitor_id", "org_name", "report_id", "domain" ], { indexName: "tlsrpt_report_unique" });
            table.index([ "monitor_id", "domain", "date_end" ], "tlsrpt_report_lookup");
        })
        .createTable("tlsrpt_failure", function (table) {
            table.increments("id");
            table.integer("tlsrpt_report_id").unsigned().notNullable()
                .references("id").inTable("tlsrpt_report").onDelete("CASCADE");

            table.string("result_type", 64).notNullable();
            table.string("sending_mta_ip", 45);
            table.string("receiving_mx_hostname", 255);
            table.string("receiving_ip", 45);
            table.integer("failed_session_count").notNullable().defaultTo(0);

            table.index([ "tlsrpt_report_id" ], "tlsrpt_failure_report");
            table.index([ "result_type" ], "tlsrpt_failure_type");
        });
};

/**
 * Reverse the schema.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.down = function (knex) {
    return knex.schema
        .dropTableIfExists("tlsrpt_failure")
        .dropTableIfExists("tlsrpt_report")
        .alterTable("monitor", function (table) {
            table.dropColumn("rbl_config");
            table.dropColumn("carp_config");
        });
};
