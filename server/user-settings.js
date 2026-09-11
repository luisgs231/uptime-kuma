const { R } = require("redbean-node");
const { log } = require("../src/util");
const { Settings } = require("./settings");
const { USER_SETTING_DEFAULTS } = require("./setting-scope");

/**
 * Settings that belong to one account rather than to the instance.
 */
class UserSettings {
    /**
     * Cached values, keyed "<userID>:<key>" so two accounts never see each
     * other's value for the same setting.
     * @type {{}}
     */
    static cacheList = {};

    static cacheCleaner = null;

    /**
     * Build the cache key for one account's setting.
     * @param {number} userID Account the setting belongs to
     * @param {string} key Setting name
     * @returns {string} Cache key
     */
    static cacheKey(userID, key) {
        return `${userID}:${key}`;
    }

    /**
     * Start the cache cleaner if it is not already running.
     * @returns {void}
     */
    static startCacheCleaner() {
        if (UserSettings.cacheCleaner) {
            return;
        }
        UserSettings.cacheCleaner = setInterval(() => {
            log.debug("user-settings", "Cache Cleaner is just started.");
            for (const cacheKey in UserSettings.cacheList) {
                if (Date.now() - UserSettings.cacheList[cacheKey].timestamp > 60 * 1000) {
                    log.debug("user-settings", "Cache Cleaner deleted: " + cacheKey);
                    delete UserSettings.cacheList[cacheKey];
                }
            }
        }, 60 * 1000);
    }

    /**
     * Read one account's value for a setting.
     * @param {number} userID Account the setting belongs to
     * @param {string} key Setting name
     * @returns {Promise<any>} The value, or undefined when the account has not set one
     */
    static async get(userID, key) {
        UserSettings.startCacheCleaner();

        const cacheKey = UserSettings.cacheKey(userID, key);
        if (cacheKey in UserSettings.cacheList) {
            return UserSettings.cacheList[cacheKey].value;
        }

        const value = await R.getCell("SELECT `value` FROM user_setting WHERE user_id = ? AND `key` = ? ", [
            userID,
            key,
        ]);

        if (value === null || value === undefined) {
            return undefined;
        }

        let parsed;
        try {
            parsed = JSON.parse(value);
        } catch (e) {
            // A value written by hand rather than through set().
            return value;
        }

        UserSettings.cacheList[cacheKey] = {
            value: parsed,
            timestamp: Date.now(),
        };
        return parsed;
    }

    /**
     * Read a setting, falling back to a default when the account has not set
     * one.
     * @param {number} userID Account the setting belongs to
     * @param {string} key Setting name
     * @param {any} defaultValue Value to use when there is no row
     * @returns {Promise<any>} The value
     */
    static async getWithDefault(userID, key, defaultValue) {
        const value = await UserSettings.get(userID, key);
        return value === undefined ? defaultValue : value;
    }

    /**
     * Read a setting the way every caller outside the settings page wants it.
     * @param {number} userID Account the setting belongs to
     * @param {string} key Setting name
     * @returns {Promise<any>} The value in force for this account
     */
    static async resolve(userID, key) {
        const own = await UserSettings.get(userID, key);
        if (own !== undefined && own !== null && own !== "") {
            return own;
        }

        const system = await Settings.get(key);
        if (system !== undefined && system !== null && system !== "") {
            return system;
        }

        return USER_SETTING_DEFAULTS[key];
    }

    /**
     * Write one account's value for a setting.
     * @param {number} userID Account the setting belongs to
     * @param {string} key Setting name
     * @param {any} value Value to store
     * @returns {Promise<void>} Promise
     */
    static async set(userID, key, value) {
        let bean = await R.findOne("user_setting", " user_id = ? AND `key` = ? ", [ userID, key ]);
        if (!bean) {
            bean = R.dispense("user_setting");
            bean.user_id = userID;
            bean.key = key;
        }
        bean.value = JSON.stringify(value);
        await R.store(bean);

        UserSettings.deleteCache(userID, [ key ]);
    }

    /**
     * Read every setting one account has.
     * @param {number} userID Account the settings belong to
     * @returns {Promise<object>} Settings by key
     */
    static async getSettings(userID) {
        const list = await R.getAll("SELECT `key`, `value` FROM user_setting WHERE user_id = ? ", [ userID ]);

        const result = {};
        for (const row of list) {
            try {
                result[row.key] = JSON.parse(row.value);
            } catch (e) {
                result[row.key] = row.value;
            }
        }
        return result;
    }

    /**
     * Write several of one account's settings.
     * @param {number} userID Account the settings belong to
     * @param {object} data Values by key
     * @param {string[]} allowedKeys Keys this caller is allowed to write
     * @returns {Promise<void>} Promise
     */
    static async setSettings(userID, data, allowedKeys) {
        const keyList = Object.keys(data).filter((key) => allowedKeys.includes(key));

        for (const key of keyList) {
            await UserSettings.set(userID, key, data[key]);
        }
    }

    /**
     * Drop cached values for one account.
     * @param {number} userID Account the settings belong to
     * @param {string[]} keyList Keys to drop
     * @returns {void}
     */
    static deleteCache(userID, keyList) {
        for (const key of keyList) {
            delete UserSettings.cacheList[UserSettings.cacheKey(userID, key)];
        }
    }

    /**
     * Drop every cached value for one account.
     * @param {number} userID Account to forget
     * @returns {void}
     */
    static deleteUserCache(userID) {
        const prefix = `${userID}:`;
        for (const cacheKey in UserSettings.cacheList) {
            if (cacheKey.startsWith(prefix)) {
                delete UserSettings.cacheList[cacheKey];
            }
        }
    }

    /**
     * Stop the cache cleaner if running.
     * @returns {void}
     */
    static stopCacheCleaner() {
        if (UserSettings.cacheCleaner) {
            clearInterval(UserSettings.cacheCleaner);
            UserSettings.cacheCleaner = null;
        }
    }
}

module.exports = {
    UserSettings,
};
