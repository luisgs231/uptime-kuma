const { R } = require("redbean-node");

/**
 * Ownership checks for the things an account can address by id.
 */

/** What the caller is told, whatever actually went wrong. */
const NOT_FOUND = "Not found.";

/**
 * Fetch a row only if it belongs to this account.
 * @param {string} table Table name
 * @param {number} id Row id
 * @param {number} userID Account that must own it
 * @returns {Promise<Bean|null>} The row, or null
 */
async function findOwned(table, id, userID) {
    if (id === null || id === undefined || !userID) {
        return null;
    }
    return R.findOne(table, " id = ? AND user_id = ? ", [ id, userID ]);
}

/**
 * Fetch a row, insisting that it belongs to this account.
 * @param {string} table Table name
 * @param {number} id Row id
 * @param {number} userID Account that must own it
 * @returns {Promise<Bean>} The row
 * @throws It does not exist, or belongs to somebody else
 */
async function requireOwned(table, id, userID) {
    const bean = await findOwned(table, id, userID);
    if (!bean) {
        throw new Error(NOT_FOUND);
    }
    return bean;
}

/**
 * The monitor with this id, if this account owns it.
 * @param {number} monitorID Monitor id
 * @param {number} userID Account that must own it
 * @returns {Promise<Bean>} The monitor
 * @throws It does not exist, or belongs to somebody else
 */
async function requireOwnedMonitor(monitorID, userID) {
    return requireOwned("monitor", monitorID, userID);
}

/**
 * The tag with this id, if this account owns it.
 * @param {number} tagID Tag id
 * @param {number} userID Account that must own it
 * @returns {Promise<Bean>} The tag
 * @throws It does not exist, or belongs to somebody else
 */
async function requireOwnedTag(tagID, userID) {
    return requireOwned("tag", tagID, userID);
}

/**
 * The status page with this slug, if this account owns it.
 * @param {string} slug Status page slug
 * @param {number} userID Account that must own it
 * @returns {Promise<Bean>} The status page
 * @throws It does not exist, or belongs to somebody else
 */
async function requireOwnedStatusPage(slug, userID) {
    const bean = await R.findOne("status_page", " slug = ? AND user_id = ? ", [ slug, userID ]);
    if (!bean) {
        throw new Error(NOT_FOUND);
    }
    return bean;
}

/**
 * The maintenance window with this id, if this account owns it.
 * @param {number} maintenanceID Maintenance id
 * @param {number} userID Account that must own it
 * @returns {Promise<Bean>} The maintenance window
 * @throws It does not exist, or belongs to somebody else
 */
async function requireOwnedMaintenance(maintenanceID, userID) {
    return requireOwned("maintenance", maintenanceID, userID);
}

/**
 * Check that every one of these rows belongs to this account.
 * @param {string} table Table name
 * @param {number[]} ids Row ids, which may contain nulls
 * @param {number} userID Account that must own them
 * @returns {Promise<void>} Promise
 * @throws Any of them does not exist, or belongs to somebody else
 */
async function requireAllOwned(table, ids, userID) {
    const wanted = [ ...new Set((ids || []).filter((id) => id !== null && id !== undefined)) ];
    if (wanted.length === 0) {
        return;
    }

    const rows = await R.getAll(
        `SELECT id FROM \`${table}\` WHERE user_id = ? AND id IN (${wanted.map(() => "?").join(",")})`,
        [ userID, ...wanted ]
    );

    if (rows.length !== wanted.length) {
        throw new Error(NOT_FOUND);
    }
}

module.exports = {
    NOT_FOUND,
    findOwned,
    requireOwned,
    requireOwnedMonitor,
    requireOwnedTag,
    requireOwnedStatusPage,
    requireOwnedMaintenance,
    requireAllOwned,
};
