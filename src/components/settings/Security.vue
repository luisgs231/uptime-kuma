<template>
    <div>
        <div v-if="settingsLoaded" class="my-4">
            <!-- Change Password -->
            <p>
                <button
                    id="logout-btn"
                    class="btn btn-danger ms-4 me-2 mb-2"
                    @click="$root.logout"
                >
                    {{ $t("logoutCurrentUser", { username: $root.username }) }}
                </button>
            </p>

            <h5 class="my-4 settings-subheading">{{ $t("Change Password") }}</h5>
            <form class="mb-3" @submit.prevent="savePassword">
                <div class="mb-3">
                    <label for="current-password" class="form-label">
                        {{ $t("Current Password") }}
                    </label>
                    <input
                        id="current-password"
                        v-model="password.currentPassword"
                        type="password"
                        class="form-control"
                        autocomplete="current-password"
                    />
                </div>

                <div class="mb-3">
                    <label for="new-password" class="form-label">
                        {{ $t("New Password") }}
                    </label>
                    <input
                        id="new-password"
                        v-model="password.newPassword"
                        type="password"
                        class="form-control"
                        autocomplete="new-password"
                    />
                </div>

                <div class="mb-3">
                    <label for="repeat-new-password" class="form-label">
                        {{ $t("Repeat New Password") }}
                    </label>
                    <input
                        id="repeat-new-password"
                        v-model="password.repeatNewPassword"
                        type="password"
                        class="form-control"
                        :class="{ 'is-invalid': invalidPassword }"
                        autocomplete="new-password"
                    />
                    <div class="invalid-feedback">
                        {{ $t("passwordNotMatchMsg") }}
                    </div>
                </div>

                <div>
                    <button class="btn btn-primary" type="submit">
                        {{ $t("Update Password") }}
                    </button>
                </div>
            </form>

            <div class="mt-5 mb-3">
                <h5 class="my-4 settings-subheading">
                    {{ $t("Two Factor Authentication") }}
                </h5>
                <div class="mb-4">
                    <button class="btn btn-primary me-2" type="button" @click="$refs.TwoFADialog.show()">
                        {{ $t("2FA Settings") }}
                    </button>
                </div>
            </div>

            <PasskeyList />

        </div>

        <TwoFADialog ref="TwoFADialog" />

    </div>
</template>

<script>
import TwoFADialog from "../../components/TwoFADialog.vue";
import PasskeyList from "./PasskeyList.vue";

export default {
    components: {
        TwoFADialog,
        PasskeyList,
    },

    data() {
        return {
            invalidPassword: false,
            password: {
                currentPassword: "",
                newPassword: "",
                repeatNewPassword: "",
            },
        };
    },

    computed: {
        settings() {
            return this.$parent.$parent.$parent.settings;
        },
        saveSettings() {
            return this.$parent.$parent.$parent.saveSettings;
        },
        settingsLoaded() {
            return this.$parent.$parent.$parent.settingsLoaded;
        },
    },

    watch: {
        "password.repeatNewPassword"() {
            this.invalidPassword = false;
        },
    },

    methods: {

    },
};
</script>
