/**
 * What an account owns, and the order it has to be copied in.
 */

/** Tables whose rows are copied one batch at a time, being potentially huge. */
const BATCHED = new Set([ "heartbeat", "stat_daily", "stat_hourly", "stat_minutely", "dmarc_record" ]);

const IMPORT_PLAN = [
    // Things a monitor points at have to exist before the monitor does.
    { table: "proxy",
        owner: "user_id" },
    { table: "docker_host",
        owner: "user_id" },
    { table: "remote_browser",
        owner: "user_id" },
    { table: "notification",
        owner: "user_id" },

    { table: "tag",
        owner: "user_id",
        ownerOptional: true },
    { table: "status_page",
        owner: "user_id",
        ownerOptional: true },

    { table: "maintenance",
        owner: "user_id" },

    {
        table: "monitor",
        owner: "user_id",
        remap: { proxy_id: "proxy",
            docker_host: "docker_host",
            remote_browser: "remote_browser" },
        deferred: { parent: "monitor" },
    },

    // Owned through a status page.
    { table: "group",
        via: { column: "status_page_id",
            table: "status_page" } },
    { table: "incident",
        via: { column: "status_page_id",
            table: "status_page" } },
    { table: "status_page_cname",
        via: { column: "status_page_id",
            table: "status_page" } },

    // Owned through a maintenance window.
    { table: "maintenance_timeslot",
        via: { column: "maintenance_id",
            table: "maintenance" } },

    // Join tables: both ends must have come across.
    { table: "maintenance_status_page",
        link: { maintenance_id: "maintenance",
            status_page_id: "status_page" } },
    { table: "monitor_group",
        link: { monitor_id: "monitor",
            group_id: "group" } },
    { table: "monitor_maintenance",
        link: { monitor_id: "monitor",
            maintenance_id: "maintenance" } },
    { table: "monitor_notification",
        link: { monitor_id: "monitor",
            notification_id: "notification" } },
    { table: "monitor_tag",
        link: { monitor_id: "monitor",
            tag_id: "tag" } },

    // Everything hanging off a monitor.
    { table: "monitor_tls_info",
        via: { column: "monitor_id",
            table: "monitor" } },
    { table: "heartbeat",
        via: { column: "monitor_id",
            table: "monitor" } },
    { table: "stat_daily",
        via: { column: "monitor_id",
            table: "monitor" } },
    { table: "stat_hourly",
        via: { column: "monitor_id",
            table: "monitor" } },
    { table: "stat_minutely",
        via: { column: "monitor_id",
            table: "monitor" } },

    // An API key can be scoped to one monitor, or to none.
    { table: "api_key",
        owner: "user_id",
        remap: { monitor_id: "monitor" } },

    { table: "dmarc_report",
        via: { column: "monitor_id",
            table: "monitor" } },
    { table: "dmarc_record",
        via: { column: "dmarc_report_id",
            table: "dmarc_report" } },
    { table: "tlsrpt_report",
        via: { column: "monitor_id",
            table: "monitor" } },
    { table: "tlsrpt_failure",
        via: { column: "tlsrpt_report_id",
            table: "tlsrpt_report" } },

    { table: "user_setting",
        owner: "user_id" },
];

/**
 * Columns copied from the source account onto the new one.
 */
const USER_COLUMNS = [ "password", "timezone", "twofa_secret", "twofa_status", "twofa_last_token" ];

/** Tables the summary counts, in the order it reports them. */
const SUMMARY_TABLES = [
    "monitor",
    "heartbeat",
    "tag",
    "notification",
    "status_page",
    "maintenance",
    "proxy",
    "docker_host",
    "remote_browser",
    "api_key",
];

module.exports = {
    IMPORT_PLAN,
    USER_COLUMNS,
    SUMMARY_TABLES,
    BATCHED,
};
