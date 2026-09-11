const { UptimeKumaServer } = require("./uptime-kuma-server");
const { clearOldData } = require("./jobs/clear-old-data");
const { incrementalVacuum } = require("./jobs/incremental-vacuum");
const { sweep: sweepCeremonies } = require("./passkey/store");
const Cron = require("croner");

const jobs = [
    {
        name: "clear-old-data",
        interval: "14 03 * * *",
        jobFunc: clearOldData,
        croner: null,
    },
    {
        name: "incremental-vacuum",
        interval: "*/5 * * * *",
        jobFunc: incrementalVacuum,
        croner: null,
    },
    {
        // Abandoned passkey ceremonies: somebody presses the button and then
        // puts the phone down. Nothing else deletes those rows.
        name: "sweep-webauthn-sessions",
        interval: "*/15 * * * *",
        jobFunc: sweepCeremonies,
        croner: null,
    },
];

/**
 * Initialize background jobs
 * @returns {Promise<void>}
 */
const initBackgroundJobs = async function () {
    const timezone = await UptimeKumaServer.getInstance().getTimezone();

    for (const job of jobs) {
        const cornerJob = new Cron(
            job.interval,
            {
                name: job.name,
                timezone,
            },
            job.jobFunc
        );
        job.croner = cornerJob;
    }
};

/**
 * Stop all background jobs if running
 * @returns {void}
 */
const stopBackgroundJobs = function () {
    for (const job of jobs) {
        if (job.croner) {
            job.croner.stop();
            job.croner = null;
        }
    }
};

module.exports = {
    initBackgroundJobs,
    stopBackgroundJobs,
};
