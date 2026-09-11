/**
 * Schema for several people sharing one instance.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.up = async function (knex) {
    if (!(await knex.schema.hasColumn("user", "is_admin"))) {
        await knex.schema.alterTable("user", function (table) {
            table.boolean("is_admin").notNullable().defaultTo(false);
        });

        const owner = await knex("user").orderBy("id", "asc").first("id");
        if (owner) {
            await knex("user").where("id", owner.id).update({ is_admin: true });
        }
    }

    if (!(await knex.schema.hasTable("user_setting"))) {
        await knex.schema.createTable("user_setting", function (table) {
            table.increments("id");
            table
                .integer("user_id")
                .unsigned()
                .notNullable()
                .references("id")
                .inTable("user")
                .onDelete("CASCADE")
                .onUpdate("CASCADE");
            table.string("key", 200).notNullable();
            // JSON, the same encoding the system `setting` table uses.
            table.text("value");
            table.unique([ "user_id", "key" ], { indexName: "user_setting_unique" });
        });
    }

    for (const table of [ "tag", "status_page" ]) {
        if (!(await knex.schema.hasColumn(table, "user_id"))) {
            await knex.schema.alterTable(table, function (t) {
                t.integer("user_id").unsigned();
                t.index("user_id", `${table}_user_id`);
            });
        }
    }

    const owner = await knex("user").where("is_admin", true).orderBy("id", "asc").first("id");
    if (!owner) {
        return;
    }

    await knex("tag").whereNull("user_id").update({ user_id: owner.id });
    await knex("status_page").whereNull("user_id").update({ user_id: owner.id });

    for (const key of [
        "tlsExpiryNotifyDays",
        "steamAPIKey",
        "globalpingApiToken",
        "searchEngineIndex",
        "keepDataPeriodDays",
    ]) {
        const existing = await knex("setting").where("key", key).first("value");
        if (!existing || existing.value === null || existing.value === undefined) {
            continue;
        }
        const already = await knex("user_setting").where({ user_id: owner.id,
            key }).first("id");
        if (already) {
            continue;
        }
        await knex("user_setting").insert({ user_id: owner.id,
            key,
            value: existing.value });
    }
};

/**
 * Reverse the schema.
 * @param {import("knex").Knex} knex Knex instance
 * @returns {Promise<void>} Promise
 */
exports.down = async function (knex) {
    await knex.schema.dropTableIfExists("user_setting");

    for (const table of [ "tag", "status_page" ]) {
        if (await knex.schema.hasColumn(table, "user_id")) {
            await knex.schema.alterTable(table, function (t) {
                t.dropColumn("user_id");
            });
        }
    }

    if (await knex.schema.hasColumn("user", "is_admin")) {
        await knex.schema.alterTable("user", function (t) {
            t.dropColumn("is_admin");
        });
    }
};
