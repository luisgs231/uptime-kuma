<template>
    <span v-if="meta" class="dmarc-status-badge">
        <span class="badge rounded-pill" :class="[badgeColorClass, { loud: meta.loud }]" :title="meta.description">
            {{ meta.label }}
        </span>
        <span v-if="showDescription" class="description text-secondary">{{ meta.description }}</span>
    </span>
</template>

<script>
import { DMARC_STATUS_META, UNKNOWN_STATUS_META } from "../monitor-status.ts";

export default {
    name: "DmarcStatusBadge",

    props: {
        /** DMARC status string carried by the heartbeat */
        status: {
            type: String,
            default: null,
        },

        /** Also render the plain English explanation beside the badge */
        showDescription: {
            type: Boolean,
            default: false,
        },
    },

    computed: {
        /**
         * Label, colour and description for the current status.
         * @returns {object|null} Status metadata, or null to render nothing
         */
        meta() {
            if (!this.status) {
                return null;
            }
            return DMARC_STATUS_META[this.status] || UNKNOWN_STATUS_META;
        },

        /**
         * Bootstrap contextual background class for the badge.
         * @returns {string} Class name
         */
        badgeColorClass() {
            return `bg-${this.meta.color}`;
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../assets/vars.scss";

.dmarc-status-badge {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.5rem;

    .badge {
        min-width: 96px;
        font-size: 0.8rem;
    }

    .badge.bg-warning {
        color: $dark-font-color2;
    }

    .badge.loud {
        font-weight: bold;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        box-shadow: 0 0 0 3px rgba(220, 53, 69, 0.3);
    }

    .description {
        font-size: 0.85rem;
    }
}
</style>
