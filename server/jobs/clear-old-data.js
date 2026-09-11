const { R } = require("redbean-node");
const { log } = require("../../src/util");
const Database = require("../database");
const { Settings } = require("../settings");
const { UserSettings } = require("../user-settings");
const { clampKeepPeriod } = require("../setting-scope");
const dayjs = require("dayjs");

const DEFAULT_KEEP_PERIOD = 365;

/**
 * Work out how long one account's history is kept.
 * @param {number|null} userID Account that owns the monitors, or null for orphans
 * @param {*} maxDays The instance ceiling
 * @returns {Promise<number>} Days of history to keep
 */
async function keepPeriodFor(userID, maxDays) {
    let wanted;

    if (userID === null || userID === undefined) {
        wanted = await Settings.get("keepDataPeriodDays");
    } else {
        wanted = await UserSettings.resolve(userID, "keepDataPeriodDays");
    }

    if (wanted === null || wanted === undefined) {
        wanted = DEFAULT_KEEP_PERIOD;
    }

    return clampKeepPeriod(wanted, maxDays);
}

/**
 * Delete one account's history older than its retention period.
 * @param {number|null} userID Account that owns the monitors, or null for orphans
 * @param {number} period Days of history to keep
 * @returns {Promise<void>} Promise
 */
async function clearFor(userID, period) {
    const sqlHourOffset = Database.sqlHourOffset();

    const ownedMonitors =
        userID === null || userID === undefined
            ? "SELECT id FROM monitor WHERE user_id IS NULL"
            : "SELECT id FROM monitor WHERE user_id = ?";
    const ownerParams = userID === null || userID === undefined ? [] : [ userID ];

    await R.exec(
        `DELETE FROM heartbeat WHERE monitor_id IN (${ownedMonitors}) AND time < ${sqlHourOffset}`,
        [ ...ownerParams, period * -24 ]
    );

    const timestamp = dayjs().subtract(period, "day").utc().startOf("day").unix();
    await R.exec(`DELETE FROM stat_daily WHERE monitor_id IN (${ownedMonitors}) AND timestamp < ? `, [
        ...ownerParams,
        timestamp,
    ]);
}

/**
 * Clears old data from the heartbeat table and the stat_daily of the database.
 *
 * Retention is per account, so this runs once per account that owns monitors
 * rather than once over the whole table.
 * @returns {Promise<void>} A promise that resolves when the data has been cleared.
 */
const clearOldData = async () => {
    await Database.clearHeartbeatData();

    if ((await Settings.get("keepDataPeriodDays")) == null) {
        await Settings.set("keepDataPeriodDays", DEFAULT_KEEP_PERIOD, "general");
    }

    const maxDays = await Settings.get("keepDataPeriodDaysMax");

    const owners = await R.getAll("SELECT DISTINCT user_id FROM monitor");

    for (const row of owners) {
        const userID = row.user_id ?? null;
        const period = await keepPeriodFor(userID, maxDays);

        if (period < 1) {
            log.info(
                "clearOldData",
                `Data deletion is disabled for user ${userID ?? "(none)"} as period is less than 1. Period is ${period} days.`
            );
            continue;
        }

        log.debug("clearOldData", `Clearing data older than ${period} days for user ${userID ?? "(none)"}...`);

        try {
            await clearFor(userID, period);
        } catch (e) {
            log.error("clearOldData", `Failed to clear old data for user ${userID ?? "(none)"}: ${e.message}`);
        }
    }

    if (Database.dbConfig.type === "sqlite") {
        try {
            await R.exec("PRAGMA optimize;");
        } catch (e) {
            log.error("clearOldData", `Failed to optimize: ${e.message}`);
        }
    }

    log.debug("clearOldData", "Data cleared.");
};

module.exports = {
    clearOldData,
    keepPeriodFor,
};
