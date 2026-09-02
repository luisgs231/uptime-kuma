/**
 * Which settings belong to the instance and which belong to an account.
 */

/**
 * Settings that describe the instance.
 */
const SYSTEM_SETTINGS = [
    // How the server itself is reached and run.
    "trustProxy",
    "primaryBaseURL",
    "serverTimezone",
    "nscd",
    "cloudflaredTunnelToken",

    // Authentication is a property of the instance, not of an account.
    "disableAuth",

    // Update checks, and the keys the server generates for web push.
    "checkUpdate",
    "checkBeta",
    "webpushPublicVapidKey",
    "webpushPrivateVapidKey",

    // Written by the database layer, never by a person.
    "database_version",
    "databasePatchedFiles",

    "title",
    "description",
    "icon",
    "statusPageTheme",
    "statusPagePublished",
    "statusPageTags",

    "domainExpiryNotifyDays",

    "chromeExecutable",

    "entryPage",

    "keepDataPeriodDaysMax",
];

/**
 * Settings that belong to one account.
 */
const USER_SETTINGS = [
    "tlsExpiryNotifyDays",

    "steamAPIKey",
    "globalpingApiToken",

    "searchEngineIndex",

    // How long this account's history is kept, bounded by keepDataPeriodDaysMax.
    "keepDataPeriodDays",

    "landingPage",
];

/**
 * Defaults for the per-account settings, used when an account has never set
 * one.
 */
const USER_SETTING_DEFAULTS = {
    tlsExpiryNotifyDays: [ 7, 14, 21 ],
    steamAPIKey: "",
    globalpingApiToken: "",
    searchEngineIndex: false,
    keepDataPeriodDays: 365,
    landingPage: "dashboard",
};

/**
 * Whether a setting belongs to one account.
 * @param {string} key Setting name
 * @returns {boolean} True when it is per-account
 */
function isUserSetting(key) {
    return USER_SETTINGS.includes(key);
}

/**
 * Whether a setting describes the instance.
 * @param {string} key Setting name
 * @returns {boolean} True when it is instance-wide
 */
function isSystemSetting(key) {
    return !isUserSetting(key);
}

/**
 * Clamp a retention period to the ceiling an admin has set.
 * @param {*} days What the account asked for
 * @param {*} maxDays The instance ceiling
 * @returns {number} The period to actually use
 */
function clampKeepPeriod(days, maxDays) {
    const wanted = Number.parseInt(days, 10);
    const period = Number.isFinite(wanted) ? wanted : USER_SETTING_DEFAULTS.keepDataPeriodDays;

    const ceiling = Number.parseInt(maxDays, 10);
    if (!Number.isFinite(ceiling) || ceiling < 1) {
        return period;
    }

    if (period < 1) {
        return ceiling;
    }
    return Math.min(period, ceiling);
}

module.exports = {
    clampKeepPeriod,
    SYSTEM_SETTINGS,
    USER_SETTINGS,
    USER_SETTING_DEFAULTS,
    isUserSetting,
    isSystemSetting,
};
