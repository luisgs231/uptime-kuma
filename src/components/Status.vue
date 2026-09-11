<template>
    <span class="badge rounded-pill" :class="['bg-' + color, { 'own-status': !!meta }]" :title="title">{{ text }}</span>
</template>

<script>
import { heartbeatStatusMeta } from "../monitor-status.ts";

export default {
    props: {
        /** Current status of monitor */
        status: {
            type: Number,
            default: 0,
        },

        /**
         * Type of the monitor this status belongs to.
         */
        type: {
            type: String,
            default: null,
        },

        /** The heartbeat this status came from, when there is one */
        beat: {
            type: Object,
            default: null,
        },
    },

    computed: {
        /**
         * The monitor's own status, when it reports one.
         * @returns {object|null} Label, colour and description, or null
         */
        meta() {
            return heartbeatStatusMeta(this.type, this.beat);
        },

        color() {
            if (this.meta) {
                return this.meta.color;
            }

            if (this.status === 0) {
                return "danger";
            }

            if (this.status === 1) {
                return "primary";
            }

            if (this.status === 2) {
                return "warning";
            }

            if (this.status === 3) {
                return "maintenance";
            }

            return "secondary";
        },

        text() {
            if (this.meta) {
                return this.meta.label;
            }

            if (this.status === 0) {
                return this.$t("Down");
            }

            if (this.status === 1) {
                return this.$t("Up");
            }

            if (this.status === 2) {
                return this.$t("Pending");
            }

            if (this.status === 3) {
                return this.$t("statusMaintenance");
            }

            return this.$t("Unknown");
        },

        /**
         * Hover text explaining a status that is not self-explanatory.
         * @returns {string|null} The explanation, or null for the stock statuses
         */
        title() {
            return this.meta ? this.meta.description : null;
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

span {
    min-width: 64px;
}

.badge.own-status.bg-warning {
    color: $dark-font-color2;
}
</style>
