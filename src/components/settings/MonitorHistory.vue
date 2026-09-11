<template>
    <div>
        <div class="my-4">
            <label for="keepDataPeriodDays" class="form-label">
                {{ $t("clearDataOlderThan", [settings.keepDataPeriodDays]) }}
                {{ $t("infiniteRetention") }}
            </label>
            <input
                id="keepDataPeriodDays"
                v-model="settings.keepDataPeriodDays"
                type="number"
                class="form-control"
                required
                min="0"
                step="1"
            />
            <div v-if="settings.keepDataPeriodDays < 0" class="form-text">
                {{ $t("dataRetentionTimeError") }}
            </div>
            <div v-if="ceiling" class="form-text">
                The administrator has capped retention at
                <strong>{{ ceiling }}</strong>
                days. A longer period, or switching deletion off, is stored but the cap is what applies.
            </div>
            <div class="form-text">This is yours alone. It does not affect anybody else's history.</div>
        </div>

        <!-- Admins set the cap everybody is measured against. -->
        <div v-if="$root.isAdmin" class="my-4">
            <label for="keepDataPeriodDaysMax" class="form-label">Maximum anybody may keep (days)</label>
            <input
                id="keepDataPeriodDaysMax"
                v-model="settings.keepDataPeriodDaysMax"
                type="number"
                class="form-control"
                min="0"
                step="1"
            />
            <div class="form-text">
                Zero or blank means no cap. This is what stops one account growing the shared database for
                everybody &mdash; without it, any account can ask to keep its history forever.
            </div>
        </div>
        <div class="my-4">
            <button class="btn btn-primary" type="button" @click="saveSettings()">
                {{ $t("Save") }}
            </button>
        </div>
        <div class="my-4">
            <div v-if="$root.info.dbType === 'sqlite'" class="my-3">
                <button class="btn btn-outline-info me-2" @click="shrinkDatabase">
                    {{ $t("Shrink Database") }} ({{ databaseSizeDisplay }})
                </button>
                <i18n-t tag="div" keypath="shrinkDatabaseDescriptionSqlite" class="form-text mt-2 mb-4 ms-2">
                    <template #vacuum>
                        <code>VACUUM</code>
                    </template>
                    <template #auto_vacuum>
                        <code>AUTO_VACUUM</code>
                    </template>
                </i18n-t>
            </div>
            <button id="clearAllStats-btn" class="btn btn-outline-danger me-2 mb-2" @click="confirmClearStatistics">
                {{ $t("Clear all statistics") }}
            </button>
        </div>
        <Confirm
            ref="confirmClearStatistics"
            btn-style="btn-danger"
            :yes-text="$t('Yes')"
            :no-text="$t('No')"
            @yes="clearStatistics"
        >
            {{ $t("confirmClearStatisticsMsg") }}
        </Confirm>
    </div>
</template>

<script>
import Confirm from "../../components/Confirm.vue";
import { log } from "../../util.ts";

export default {
    components: {
        Confirm,
    },

    data() {
        return {
            databaseSize: 0,
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        /**
         * The cap an administrator has set, if any.
         * @returns {number|null} Days, or null when there is no cap
         */
        ceiling() {
            const value = Number.parseInt(this.settings.keepDataPeriodDaysMax, 10);
            return Number.isFinite(value) && value > 0 ? value : null;
        },

        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
        databaseSizeDisplay() {
            return Math.round((this.databaseSize / 1024 / 1024) * 10) / 10 + " MB";
        },
    },

    mounted() {
        this.loadDatabaseSize();
    },

    methods: {
        /**
         * Get the current size of the database
         * @returns {void}
         */
        loadDatabaseSize() {
            log.debug("monitorhistory", "load database size");
            this.$root.getSocket().emit("getDatabaseSize", (res) => {
                if (res.ok) {
                    this.databaseSize = res.size;
                    log.debug("monitorhistory", "database size: " + res.size);
                } else {
                    log.debug("monitorhistory", res);
                }
            });
        },

        /**
         * Request that the database is shrunk
         * @returns {void}
         */
        shrinkDatabase() {
            this.$root.getSocket().emit("shrinkDatabase", (res) => {
                if (res.ok) {
                    this.loadDatabaseSize();
                    this.$root.toastSuccess("Done");
                } else {
                    log.debug("monitorhistory", res);
                }
            });
        },

        /**
         * Show the dialog to confirm clearing stats
         * @returns {void}
         */
        confirmClearStatistics() {
            this.$refs.confirmClearStatistics.show();
        },

        /**
         * Send the request to clear stats
         * @returns {void}
         */
        clearStatistics() {
            this.$root.clearStatistics((res) => {
                if (res.ok) {
                    this.$router.go();
                } else {
                    this.$root.toastError(res.msg);
                }
            });
        },
    },
};
</script>
