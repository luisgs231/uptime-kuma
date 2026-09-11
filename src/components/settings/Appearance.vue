<template>
    <div>
        <div class="my-4">
            <label for="language" class="form-label">
                {{ $t("Language") }}
            </label>
            <select id="language" v-model="$root.language" class="form-select">
                <option v-for="(lang, i) in $i18n.availableLocales" :key="`Lang${i}`" :value="lang">
                    {{ $i18n.messages[lang].languageName }}
                </option>
            </select>
        </div>
        <div class="my-4">
            <label class="form-label">Accent colour</label>
            <p class="form-text mt-0">
                Saved with your account, not this browser &mdash; everyone sharing this instance picks their own.
            </p>
            <div class="accents">
                <button
                    v-for="accent in accents"
                    :key="accent.name"
                    type="button"
                    class="accent"
                    :class="{ chosen: accent.name === $root.accentColor }"
                    :style="{ '--swatch': accent.hex }"
                    :title="accent.label"
                    :aria-label="accent.label"
                    :aria-pressed="accent.name === $root.accentColor"
                    @click="choose(accent.name)"
                ></button>
            </div>
        </div>

        <div class="my-4">
            <label for="timezone" class="form-label">{{ $t("Theme") }}</label>
            <div>
                <div class="btn-group" role="group" :aria-label="$t('Basic checkbox toggle button group')">
                    <input
                        id="btncheck1"
                        v-model="$root.userTheme"
                        type="radio"
                        class="btn-check"
                        name="theme"
                        autocomplete="off"
                        value="light"
                    />
                    <label class="btn btn-outline-primary" for="btncheck1">
                        {{ $t("Light") }}
                    </label>

                    <input
                        id="btncheck2"
                        v-model="$root.userTheme"
                        type="radio"
                        class="btn-check"
                        name="theme"
                        autocomplete="off"
                        value="dark"
                    />
                    <label class="btn btn-outline-primary" for="btncheck2">
                        {{ $t("Dark") }}
                    </label>

                    <input
                        id="btncheck3"
                        v-model="$root.userTheme"
                        type="radio"
                        class="btn-check"
                        name="theme"
                        autocomplete="off"
                        value="auto"
                    />
                    <label class="btn btn-outline-primary" for="btncheck3">
                        {{ $t("Auto") }}
                    </label>
                </div>
            </div>
        </div>
        <div class="my-4">
            <label class="form-label">{{ $t("Theme - Heartbeat Bar") }}</label>
            <div>
                <div class="btn-group" role="group" :aria-label="$t('Basic checkbox toggle button group')">
                    <input
                        id="btncheck4"
                        v-model="$root.userHeartbeatBar"
                        type="radio"
                        class="btn-check"
                        name="heartbeatBarTheme"
                        autocomplete="off"
                        value="normal"
                    />
                    <label class="btn btn-outline-primary" for="btncheck4">
                        {{ $t("Normal") }}
                    </label>

                    <input
                        id="btncheck5"
                        v-model="$root.userHeartbeatBar"
                        type="radio"
                        class="btn-check"
                        name="heartbeatBarTheme"
                        autocomplete="off"
                        value="bottom"
                    />
                    <label class="btn btn-outline-primary" for="btncheck5">
                        {{ $t("Bottom") }}
                    </label>

                    <input
                        id="btncheck6"
                        v-model="$root.userHeartbeatBar"
                        type="radio"
                        class="btn-check"
                        name="heartbeatBarTheme"
                        autocomplete="off"
                        value="none"
                    />
                    <label class="btn btn-outline-primary" for="btncheck6">
                        {{ $t("None") }}
                    </label>
                </div>
            </div>
        </div>

        <!-- Timeline -->
        <div class="my-4">
            <label class="form-label">{{ $t("styleElapsedTime") }}</label>
            <div>
                <div class="btn-group" role="group">
                    <input
                        id="styleElapsedTimeShowNoLine"
                        v-model="$root.styleElapsedTime"
                        type="radio"
                        class="btn-check"
                        name="styleElapsedTime"
                        autocomplete="off"
                        value="no-line"
                    />
                    <label class="btn btn-outline-primary" for="styleElapsedTimeShowNoLine">
                        {{ $t("styleElapsedTimeShowNoLine") }}
                    </label>

                    <input
                        id="styleElapsedTimeShowWithLine"
                        v-model="$root.styleElapsedTime"
                        type="radio"
                        class="btn-check"
                        name="styleElapsedTime"
                        autocomplete="off"
                        value="with-line"
                    />
                    <label class="btn btn-outline-primary" for="styleElapsedTimeShowWithLine">
                        {{ $t("styleElapsedTimeShowWithLine") }}
                    </label>

                    <input
                        id="styleElapsedTimeNone"
                        v-model="$root.styleElapsedTime"
                        type="radio"
                        class="btn-check"
                        name="styleElapsedTime"
                        autocomplete="off"
                        value="none"
                    />
                    <label class="btn btn-outline-primary" for="styleElapsedTimeNone">
                        {{ $t("None") }}
                    </label>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { ACCENT_COLORS } from "../../util.ts";

export default {
    computed: {
        accents() {
            return ACCENT_COLORS;
        },
    },
    methods: {
        /**
         * Pick an accent, and keep it with the account.
         *
         * Applied first so the page changes under the cursor, then saved - an
         * instance that is slow to answer should not make the click feel dead.
         * @param {string} name Accent name
         * @returns {void}
         */
        choose(name) {
            this.$root.accentColor = name;
            this.$root.getSocket().emit("setAccentColor", name, (res) => {
                if (!res.ok) {
                    this.$root.toastError(res.msg);
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.accents {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;

    .accent {
        width: 34px;
        height: 34px;
        padding: 0;
        border-radius: 50%;
        border: 2px solid transparent;
        background-color: var(--swatch);
        cursor: pointer;
        transition: transform 0.15s $easing-in-out;

        &:hover {
            transform: scale(1.12);
        }

        // The ring is the page background with the swatch outside it, so the
        // chosen one reads as chosen on either theme without a tick on top of
        // a colour it might not contrast with.
        &.chosen {
            box-shadow: 0 0 0 3px white, 0 0 0 5px var(--swatch);

            .dark & {
                box-shadow: 0 0 0 3px $dark-bg, 0 0 0 5px var(--swatch);
            }
        }
    }
}

.btn-check:active + .btn-outline-primary,
.btn-check:checked + .btn-outline-primary,
.btn-check:hover + .btn-outline-primary {
    color: #fff;

    .dark & {
        color: #000;
    }
}

.dark {
    .list-group-item {
        background-color: $dark-bg2;
        color: $dark-font-color;
    }
}
</style>
