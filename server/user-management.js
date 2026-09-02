const { R } = require("redbean-node");
const { log } = require("../src/util");
const passwordHash = require("./password-hash");
const { UserSettings } = require("./user-settings");

/**
 * Creating, changing and removing accounts.
 */

/** Nobody may end up with an instance that has no administrator. */
const LAST_ADMIN = "This is the only administrator. Make somebody else an administrator first.";

/**
 * Every account, without the password hashes.
 * @returns {Promise<object[]>} Accounts, oldest first
 */
async function listUsers() {
    const rows = await R.getAll(
        "SELECT id, username, active, is_admin, twofa_status FROM `user` ORDER BY id ASC"
    );

    return rows.map((row) => ({
        id: row.id,
        username: row.username,
        active: !!row.active,
        isAdmin: !!row.is_admin,
        twoFAStatus: !!row.twofa_status,
    }));
}

/**
 * How many administrators can still log in, ignoring one account.
 * @param {number|null} excludeID Account to leave out of the count
 * @returns {Promise<number>} Number of other active administrators
 */
async function countOtherActiveAdmins(excludeID = null) {
    const row = await R.getRow(
        "SELECT COUNT(*) AS count FROM `user` WHERE is_admin = 1 AND active = 1 AND id != ?",
        [ excludeID ?? -1 ]
    );
    return Number(row.count);
}

/**
 * Refuse a change that would leave the instance with no administrator.
 * @param {number} userID Account being changed
 * @returns {Promise<void>} Promise
 * @throws It is the last administrator
 */
async function assertNotLastAdmin(userID) {
    const user = await R.findOne("user", " id = ? ", [ userID ]);
    if (!user || !user.is_admin || !user.active) {
        // Not an active admin, so removing its powers takes nothing away.
        return;
    }

    if ((await countOtherActiveAdmins(userID)) === 0) {
        throw new Error(LAST_ADMIN);
    }
}

/**
 * Check a username is usable and not already taken.
 * @param {string} username Proposed name
 * @param {number|null} excludeID Account allowed to already hold it
 * @returns {Promise<string>} The trimmed username
 * @throws It is empty or taken
 */
async function checkUsername(username, excludeID = null) {
    const name = String(username ?? "").trim();

    if (!name) {
        throw new Error("Please input a username.");
    }

    const existing = await R.findOne("user", " username = ? ", [ name ]);
    if (existing && existing.id !== excludeID) {
        throw new Error("That username is already taken.");
    }

    return name;
}

/**
 * Create an account.
 * @param {object} input The account to create
 * @param {string} input.username Username
 * @param {string} input.password Password, hashed before it is stored
 * @param {boolean} input.isAdmin Whether it may administer the instance
 * @returns {Promise<number>} The new account's id
 */
async function createUser({ username, password, isAdmin = false }) {
    const name = await checkUsername(username);

    if (typeof password !== "string" || password === "") {
        throw new Error("Please input a password.");
    }

    const user = R.dispense("user");
    user.username = name;
    user.password = await passwordHash.generate(password);
    user.active = true;
    user.is_admin = !!isAdmin;
    await R.store(user);

    log.info("user", `Created account ${name} (admin: ${!!isAdmin})`);
    return user.id;
}

/**
 * Change an account's name, role or whether it may log in.
 * @param {number} userID Account to change
 * @param {object} changes Any of username, isAdmin, active
 * @returns {Promise<void>} Promise
 */
async function updateUser(userID, changes) {
    const user = await R.findOne("user", " id = ? ", [ userID ]);
    if (!user) {
        throw new Error("Not found.");
    }

    if (changes.username !== undefined) {
        user.username = await checkUsername(changes.username, user.id);
    }

    // Both of these can remove the last way into the instance.
    if (changes.isAdmin === false || changes.active === false) {
        await assertNotLastAdmin(userID);
    }

    if (changes.isAdmin !== undefined) {
        user.is_admin = !!changes.isAdmin;
    }

    if (changes.active !== undefined) {
        user.active = !!changes.active;
    }

    await R.store(user);
    log.info("user", `Updated account ${user.username}`);
}

/**
 * Set an account's password without knowing the old one.
 * @param {number} userID Account to change
 * @param {string} password The new password
 * @returns {Promise<void>} Promise
 */
async function setUserPassword(userID, password) {
    if (typeof password !== "string" || password === "") {
        throw new Error("Please input a password.");
    }

    const user = await R.findOne("user", " id = ? ", [ userID ]);
    if (!user) {
        throw new Error("Not found.");
    }

    user.password = await passwordHash.generate(password);
    await R.store(user);
    log.info("user", `Reset the password for account ${user.username}`);
}

/**
 * Everything an account owns, for telling somebody what they are about to
 * destroy.
 * @param {number} userID Account to describe
 * @returns {Promise<object>} Counts by kind
 */
async function describeUserData(userID) {
    const count = async (table) => {
        const row = await R.getRow(`SELECT COUNT(*) AS count FROM \`${table}\` WHERE user_id = ?`, [ userID ]);
        return Number(row.count);
    };

    return {
        monitors: await count("monitor"),
        statusPages: await count("status_page"),
        tags: await count("tag"),
        notifications: await count("notification"),
        maintenance: await count("maintenance"),
    };
}

/**
 * Delete an account and everything it owns.
 * @param {number} userID Account to delete
 * @returns {Promise<object>} What was deleted
 */
async function deleteUser(userID) {
    const user = await R.findOne("user", " id = ? ", [ userID ]);
    if (!user) {
        throw new Error("Not found.");
    }

    const deleted = await describeUserData(userID);

    const Monitor = require("./model/monitor");

    const monitors = await R.getAll("SELECT id FROM monitor WHERE user_id = ?", [ userID ]);
    for (const monitor of monitors) {
        await Monitor.deleteMonitor(monitor.id, userID);
    }

    const pages = await R.getAll("SELECT id FROM status_page WHERE user_id = ?", [ userID ]);
    for (const page of pages) {
        await R.exec("DELETE FROM incident WHERE status_page_id = ? ", [ page.id ]);
        await R.exec("DELETE FROM `group` WHERE status_page_id = ? ", [ page.id ]);
    }
    await R.exec("DELETE FROM status_page WHERE user_id = ? ", [ userID ]);

    for (const table of [ "tag", "notification", "maintenance", "proxy", "docker_host", "remote_browser" ]) {
        await R.exec(`DELETE FROM \`${table}\` WHERE user_id = ? `, [ userID ]);
    }

    // api_key, status_page_cname and user_setting cascade with the account.
    await R.exec("DELETE FROM `user` WHERE id = ? ", [ userID ]);

    // The cache is keyed by account id, and ids are reused.
    UserSettings.deleteUserCache(userID);

    log.info("user", `Deleted account ${user.username} and everything it owned`);
    return deleted;
}

module.exports = {
    LAST_ADMIN,
    listUsers,
    countOtherActiveAdmins,
    assertNotLastAdmin,
    checkUsername,
    createUser,
    updateUser,
    setUserPassword,
    describeUserData,
    deleteUser,
};
