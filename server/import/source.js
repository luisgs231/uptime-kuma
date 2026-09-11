const fs = require("fs");
const { log } = require("../../src/util");
const { SUMMARY_TABLES } = require("./plan");

/**
 * Opening somebody else's Uptime Kuma database and describing what is in it.
 */

/** How long to wait for a database that is not going to answer. */
const CONNECT_TIMEOUT_MS = 10000;

/** Tables that make a database recognisably Uptime Kuma rather than something else. */
const REQUIRED_TABLES = [ "user", "monitor", "heartbeat" ];

/**
 * Build a knex handle for a source database.
 * @param {object} config Either { type: "sqlite", path } or
 *                        { type: "mysql", host, port, database, username, password }
 * @returns {object} A knex instance
 * @throws The configuration is unusable
 */
function connect(config) {
    if (config.type === "sqlite") {
        if (!config.path || !fs.existsSync(config.path)) {
            throw new Error("The uploaded database file could not be found. Please upload it again.");
        }

        const Dialect = require("knex/lib/dialects/sqlite3/index.js");
        Dialect.prototype._driver = () => require("@louislam/sqlite3");

        return require("knex")({
            client: Dialect,
            connection: { filename: config.path },
            useNullAsDefault: true,
        });
    }

    if (config.type === "mysql") {
        if (!config.host || !config.database) {
            throw new Error("Please give at least a host and a database name.");
        }

        return require("knex")({
            client: "mysql2",
            connection: {
                host: config.host,
                port: Number(config.port) || 3306,
                user: config.username || "root",
                password: config.password || "",
                database: config.database,
                connectTimeout: CONNECT_TIMEOUT_MS,
            },
            pool: { min: 0,
                max: 2 },
            acquireConnectionTimeout: CONNECT_TIMEOUT_MS,
        });
    }

    throw new Error(`Unknown source type "${config.type}".`);
}

/**
 * Turn a driver error into something worth showing somebody.
 * @param {Error} e The driver's error
 * @param {object} config The source being opened
 * @returns {string} A message that says what to change
 */
function describeError(e, config) {
    const code = e.code || "";
    const message = String(e.message || "");

    if (code === "ECONNREFUSED") {
        return `Nothing is listening on ${config.host}:${config.port || 3306}.`;
    }
    if (code === "ETIMEDOUT" || code === "ENOTFOUND" || message.includes("getaddrinfo")) {
        return `${config.host} could not be reached.`;
    }
    if (code === "ER_ACCESS_DENIED_ERROR") {
        return "The database refused those credentials.";
    }
    if (code === "ER_BAD_DB_ERROR") {
        return `The database "${config.database}" does not exist on that server.`;
    }
    if (code === "SQLITE_NOTADB" || message.includes("file is not a database")) {
        return "That file is not a SQLite database.";
    }
    if (message.includes("Unable to acquire a connection")) {
        return `${config.host} did not answer within ${CONNECT_TIMEOUT_MS / 1000} seconds.`;
    }
    return message;
}

/**
 * Which of these tables the source actually has.
 * @param {object} db Source knex instance
 * @param {string[]} tables Table names to look for
 * @returns {Promise<Set<string>>} The ones that exist
 */
async function presentTables(db, tables) {
    const found = new Set();
    for (const table of tables) {
        if (await db.schema.hasTable(table)) {
            found.add(table);
        }
    }
    return found;
}

/**
 * Confirm this is an Uptime Kuma database before reading anything else from
 * it.
 * @param {object} db Source knex instance
 * @returns {Promise<void>} Promise
 * @throws It is not one
 */
async function assertLooksLikeKuma(db) {
    const present = await presentTables(db, REQUIRED_TABLES);
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));

    if (missing.length) {
        throw new Error(
            `This does not look like an Uptime Kuma database - it has no ${missing.join(", ")} table.`
        );
    }
}

/**
 * Count rows belonging to one account, tolerating a table that is not there.
 * @param {object} db Source knex instance
 * @param {string} table Table name
 * @param {object} where Selection
 * @returns {Promise<number|null>} The count, or null when the table is absent
 */
async function countOwned(db, table, where) {
    if (!(await db.schema.hasTable(table))) {
        return null;
    }

    try {
        const query = db(table);
        if (where) {
            query.where(where);
        }
        const row = await query.count({ count: "*" }).first();
        return Number(row.count);
    } catch (e) {
        log.debug("import", `Could not count ${table}: ${e.message}`);
        return null;
    }
}

/**
 * The accounts in the source, with enough detail to choose between them.
 * @param {object} db Source knex instance
 * @returns {Promise<object[]>} Accounts, oldest first
 */
async function listUsers(db) {
    const hasAdminColumn = await db.schema.hasColumn("user", "is_admin");

    const columns = [ "id", "username", "active" ];
    if (hasAdminColumn) {
        columns.push("is_admin");
    }

    const rows = await db("user").select(columns).orderBy("id", "asc");

    const users = [];
    for (const row of rows) {
        users.push({
            id: row.id,
            username: row.username,
            active: !!row.active,
            isAdmin: !!row.is_admin,
            monitors: (await countOwned(db, "monitor", { user_id: row.id })) ?? 0,
        });
    }
    return users;
}

/**
 * What would come across for one account.
 * @param {object} db Source knex instance
 * @param {number} userID Account in the source
 * @returns {Promise<object>} Counts by table
 */
async function summarise(db, userID) {
    const monitorIDs = (await db("monitor").where({ user_id: userID }).select("id")).map((m) => m.id);

    const counts = {};
    for (const table of SUMMARY_TABLES) {
        if (table === "heartbeat") {
            counts[table] = monitorIDs.length
                ? await countOwned(db, "heartbeat", null).then(async () => {
                    const row = await db("heartbeat").whereIn("monitor_id", monitorIDs).count({ count: "*" }).first();
                    return Number(row.count);
                })
                : 0;
            continue;
        }

        if (table === "tag" || table === "status_page") {
            const hasOwner = (await db.schema.hasTable(table)) && (await db.schema.hasColumn(table, "user_id"));
            counts[table] = await countOwned(db, table, hasOwner ? { user_id: userID } : null);
            continue;
        }

        counts[table] = await countOwned(db, table, { user_id: userID });
    }

    return counts;
}

/**
 * Open a source, check it, and describe it, then close it again.
 * @param {object} config Source configuration
 * @returns {Promise<object>} ok, users, and the source's own description
 */
async function inspect(config) {
    let db;
    try {
        db = connect(config);
        await assertLooksLikeKuma(db);

        const users = await listUsers(db);
        const version = await db("setting")
            .where({ key: "database_version" })
            .first("value")
            .catch(() => null);

        return {
            ok: true,
            users,
            databaseVersion: version?.value ?? null,
            monitors: users.reduce((total, u) => total + u.monitors, 0),
        };
    } catch (e) {
        return { ok: false,
            msg: describeError(e, config) };
    } finally {
        if (db) {
            await db.destroy().catch(() => {});
        }
    }
}

module.exports = {
    connect,
    describeError,
    assertLooksLikeKuma,
    listUsers,
    summarise,
    inspect,
    presentTables,
    REQUIRED_TABLES,
};
