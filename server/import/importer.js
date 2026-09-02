const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { IMPORT_PLAN, USER_COLUMNS, BATCHED } = require("./plan");

/**
 * Copying one account's data out of another Uptime Kuma database into this
 * one.
 */

/** Rows inserted per statement. Large enough to be quick, small enough to bind. */
const BATCH_SIZE = 500;

/** Rows read from the source at a time when streaming a large table. */
const READ_SIZE = 2000;

/**
 * The columns two tables agree on.
 * @param {object} source Source knex instance
 * @param {object} dest Destination knex instance
 * @param {string} table Table name
 * @returns {Promise<string[]>} Shared column names, without `id`
 */
async function sharedColumns(source, dest, table) {
    const [ from, to ] = await Promise.all([
        source(table).columnInfo(),
        dest(table).columnInfo(),
    ]);

    return {
        shared: Object.keys(from).filter((column) => column !== "id" && column in to),
        destination: new Set(Object.keys(to)),
    };
}

/**
 * Insert rows and record what their ids became.
 * @param {object} dest Destination knex instance
 * @param {string} table Table name
 * @param {object[]} rows Rows to insert, already remapped
 * @param {number[]} sourceIDs The source id of each row, positionally
 * @param {Map|null} idMap Where to record old id to new id, or null
 * @returns {Promise<number>} How many rows were inserted
 */
async function insertRows(dest, table, rows, sourceIDs, idMap) {
    if (rows.length === 0) {
        return 0;
    }

    if (!idMap) {
        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            await dest(table).insert(rows.slice(i, i + BATCH_SIZE));
        }
        return rows.length;
    }

    for (let i = 0; i < rows.length; i++) {
        const inserted = await dest(table).insert(rows[i]);
        const newID = Array.isArray(inserted) ? inserted[0] : inserted;
        idMap.set(String(sourceIDs[i]), newID);
    }
    return rows.length;
}

/**
 * The columns of a row that name something else, and how strictly.
 * @param {object} step The plan entry
 * @returns {object} required and optional column-to-table maps
 */
function referenceColumns(step) {
    const required = {};

    if (step.via) {
        required[step.via.column] = step.via.table;
    }
    for (const [ column, table ] of Object.entries(step.link || {})) {
        required[column] = table;
    }

    return { required,
        optional: step.remap || {} };
}

/**
 * Rewrite one row's foreign keys into this database's id space.
 * @param {object} row The source row
 * @param {object} step The plan entry
 * @param {object} maps Table name to id map
 * @returns {object|null} The row to insert, or null if it should be dropped
 */
function remapRow(row, step, maps) {
    const out = { ...row };
    const { required, optional } = referenceColumns(step);

    for (const [ column, table ] of Object.entries(required)) {
        if (!(column in out)) {
            continue;
        }

        const mapped = maps[table]?.get(String(out[column]));
        if (mapped === undefined) {
            return null;
        }
        out[column] = mapped;
    }

    for (const [ column, table ] of Object.entries(optional)) {
        if (!(column in out) || out[column] === null || out[column] === undefined) {
            continue;
        }

        const mapped = maps[table]?.get(String(out[column]));
        if (mapped === undefined) {
            out[column] = null;
            continue;
        }
        out[column] = mapped;
    }

    // A deferred self-reference is filled in on the second pass.
    for (const column of Object.keys(step.deferred || {})) {
        if (column in out) {
            out[column] = null;
        }
    }

    return out;
}

/**
 * Read the rows of one table that belong to this import.
 * @param {object} source Source knex instance
 * @param {object} step The plan entry
 * @param {number} userID Account in the source
 * @param {object} maps Table name to id map
 * @param {boolean} hasOwnerColumn Whether the owner column exists in the source
 * @returns {object} A knex query builder, or null when nothing can match
 */
function selectFor(source, step, userID, maps, hasOwnerColumn) {
    const query = source(step.table);

    if (step.owner) {
        if (hasOwnerColumn) {
            query.where({ [step.owner]: userID });
        } else if (!step.ownerOptional) {
            return null;
        }
        return query;
    }

    if (step.via) {
        const ids = [ ...(maps[step.via.table]?.keys() ?? []) ];
        if (ids.length === 0) {
            return null;
        }
        query.whereIn(step.via.column, ids);
        return query;
    }

    if (step.link) {
        for (const [ column, table ] of Object.entries(step.link)) {
            const ids = [ ...(maps[table]?.keys() ?? []) ];
            if (ids.length === 0) {
                return null;
            }
            query.whereIn(column, ids);
        }
        return query;
    }

    return null;
}

/**
 * Copy one table.
 * @param {object} input Everything the step needs
 * @param {object} input.source Source knex instance
 * @param {object} input.dest Destination knex instance
 * @param {object} input.step The plan entry
 * @param {number} input.userID Account in the source
 * @param {number} input.newUserID Account in this instance
 * @param {object} input.maps Table name to id map
 * @param {Function} input.onProgress Called after each batch, or undefined
 * @returns {Promise<number>} Rows imported
 */
async function importTable({ source, dest, step, userID, newUserID, maps, onProgress }) {
    const { table } = step;

    // A table this build has and the source does not, or the other way round.
    if (!(await source.schema.hasTable(table)) || !(await dest.schema.hasTable(table))) {
        log.debug("import", `Skipping ${table}: not present in both databases`);
        return 0;
    }

    const { shared: columns, destination } = await sharedColumns(source, dest, table);
    if (columns.length === 0) {
        return 0;
    }

    const hasOwnerColumn = step.owner ? await source.schema.hasColumn(table, step.owner) : false;
    const query = selectFor(source, step, userID, maps, hasOwnerColumn);
    if (!query) {
        return 0;
    }

    const needsMap = !BATCHED.has(table) && !step.link;
    const idMap = needsMap ? new Map() : null;
    if (idMap) {
        maps[table] = idMap;
    }

    const readColumns = [ ...columns ];
    if (!readColumns.includes("id")) {
        readColumns.push("id");
    }

    let imported = 0;
    let offset = 0;

    for (;;) {
        const rows = await query.clone().select(readColumns).orderBy("id", "asc").limit(READ_SIZE).offset(offset);
        if (rows.length === 0) {
            break;
        }
        offset += rows.length;

        const prepared = [];
        const sourceIDs = [];

        for (const row of rows) {
            const mapped = remapRow(row, step, maps);
            if (!mapped) {
                continue;
            }

            const out = {};
            for (const column of columns) {
                out[column] = mapped[column];
            }

            if (step.owner && destination.has(step.owner)) {
                out[step.owner] = newUserID;
            }

            prepared.push(out);
            sourceIDs.push(row.id);
        }

        imported += await insertRows(dest, table, prepared, sourceIDs, idMap);

        if (onProgress) {
            onProgress({ table,
                imported });
        }

        if (rows.length < READ_SIZE) {
            break;
        }
    }

    return imported;
}

/**
 * Fill in the references a table makes to itself.
 * @param {object} input What the second pass needs
 * @param {object} input.source Source knex instance
 * @param {object} input.dest Destination knex instance
 * @param {object} input.step The plan entry
 * @param {number} input.userID Account in the source
 * @param {object} input.maps Table name to id map
 * @returns {Promise<number>} Rows updated
 */
async function applyDeferred({ source, dest, step, userID, maps }) {
    if (!step.deferred) {
        return 0;
    }

    const map = maps[step.table];
    if (!map || map.size === 0) {
        return 0;
    }

    let updated = 0;

    for (const [ column, table ] of Object.entries(step.deferred)) {
        if (!(await source.schema.hasColumn(step.table, column))) {
            continue;
        }

        const rows = await source(step.table)
            .where({ [step.owner]: userID })
            .whereNotNull(column)
            .select([ "id", column ]);

        for (const row of rows) {
            const newID = map.get(String(row.id));
            const newTarget = maps[table]?.get(String(row[column]));

            if (newID === undefined || newTarget === undefined) {
                continue;
            }

            await dest(step.table).where({ id: newID }).update({ [column]: newTarget });
            updated++;
        }
    }

    return updated;
}

/**
 * Copy an account's data from another Uptime Kuma into this one.
 * @param {object} input What the import needs
 * @param {object} input.source Source knex instance
 * @param {object} input.dest Destination knex instance
 * @param {number} input.sourceUserID Account in the source
 * @param {number} input.newUserID Account in this instance
 * @param {Function} input.onProgress Called after each batch, or undefined
 * @returns {Promise<object>} Rows imported per table
 */
async function importAccount({ source, dest, sourceUserID, newUserID, onProgress }) {
    const maps = {};
    const counts = {};

    // The account itself first, so everything else has something to point at.
    const columns = (await sharedColumns(source, dest, "user")).shared.filter((c) => USER_COLUMNS.includes(c));
    if (columns.length) {
        const row = await source("user").where({ id: sourceUserID }).first(columns);
        if (row) {
            const update = {};
            for (const column of columns) {
                if (row[column] !== undefined) {
                    update[column] = row[column];
                }
            }
            if (Object.keys(update).length) {
                await dest("user").where({ id: newUserID }).update(update);
            }
        }
    }

    maps.user = new Map([ [ String(sourceUserID), newUserID ] ]);

    for (const step of IMPORT_PLAN) {
        counts[step.table] = await importTable({
            source,
            dest,
            step,
            userID: sourceUserID,
            newUserID,
            maps,
            onProgress,
        });
    }

    for (const step of IMPORT_PLAN) {
        if (step.deferred) {
            await applyDeferred({ source,
                dest,
                step,
                userID: sourceUserID,
                maps });
        }
    }

    return counts;
}

/**
 * Import into a freshly created account, removing it again if anything fails.
 * @param {object} input What the import needs
 * @param {object} input.source Source knex instance
 * @param {object} input.dest Destination knex instance
 * @param {number} input.sourceUserID Account in the source
 * @param {number} input.newUserID Account in this instance
 * @param {Function} input.onProgress Called after each batch, or undefined
 * @returns {Promise<object>} Rows imported per table
 */
async function importAccountOrUndo({ source, dest, sourceUserID, newUserID, onProgress }) {
    try {
        return await importAccount({ source,
            dest,
            sourceUserID,
            newUserID,
            onProgress });
    } catch (e) {
        log.error("import", `Import failed, removing the part-imported account: ${e.message}`);
        try {
            const { deleteUser } = require("../user-management");
            await deleteUser(newUserID);
        } catch (cleanupError) {
            log.error("import", `Could not remove the part-imported account: ${cleanupError.message}`);
        }
        throw e;
    }
}

/**
 * The destination knex handle.
 * @returns {object} This instance's knex
 */
function destination() {
    return R.knex;
}

module.exports = {
    sharedColumns,
    remapRow,
    selectFor,
    importTable,
    applyDeferred,
    importAccount,
    importAccountOrUndo,
    destination,
    BATCH_SIZE,
    READ_SIZE,
};
