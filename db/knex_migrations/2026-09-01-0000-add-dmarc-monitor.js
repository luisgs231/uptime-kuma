/**
 * Schema for the DMARC monitor type.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("monitor", "dmarc_config"))) {
        await knex.schema.alterTable("monitor", function (table) {
            table.text("dmarc_config");
            table.text("dmarc_state");
        });
    }
    if (await knex.schema.hasTable("dmarc_report")) {
        return;
    }
    await knex.schema
        .createTable("dmarc_report", function (table) {
            table.increments("id");
            table.integer("monitor_id").unsigned().notNullable()
                .references("id").inTable("monitor").onDelete("CASCADE");

            table.string("org_name", 255).notNullable();
            table.string("report_id", 255).notNullable();
            table.string("domain", 255).notNullable();

            table.bigInteger("date_begin").notNullable();
            table.bigInteger("date_end").notNullable();

            table.string("policy_p", 20);
            table.string("policy_sp", 20);
            table.integer("policy_pct");
            table.string("policy_adkim", 8);
            table.string("policy_aspf", 8);

            table.integer("message_count").notNullable().defaultTo(0);
            table.integer("pass_count").notNullable().defaultTo(0);
            table.integer("fail_count").notNullable().defaultTo(0);
            table.bigInteger("ingested_at").notNullable();

            // Makes re-reading the same mail a no-op.
            table.unique([ "monitor_id", "org_name", "report_id" ], { indexName: "dmarc_report_unique" });
            table.index([ "monitor_id", "domain", "date_end" ], "dmarc_report_lookup");
        })
        .createTable("dmarc_record", function (table) {
            table.increments("id");
            table.integer("dmarc_report_id").unsigned().notNullable()
                .references("id").inTable("dmarc_report").onDelete("CASCADE");

            table.string("source_ip", 45).notNullable();
            table.integer("count").notNullable().defaultTo(0);
            table.string("disposition", 20);

            // The *aligned* results, which is what DMARC actually evaluates.
            table.boolean("dkim_aligned").notNullable().defaultTo(false);
            table.boolean("spf_aligned").notNullable().defaultTo(false);

            table.string("header_from", 255);
            table.string("dkim_domains", 512);
            table.string("spf_domains", 512);

            table.index([ "dmarc_report_id" ], "dmarc_record_report");
            table.index([ "source_ip" ], "dmarc_record_ip");
        });
};

/**
 * Reverse the DMARC schema.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.down = function (knex) {
    return knex.schema
        .dropTableIfExists("dmarc_record")
        .dropTableIfExists("dmarc_report")
        .alterTable("monitor", function (table) {
            table.dropColumn("dmarc_config");
            table.dropColumn("dmarc_state");
        });
};
