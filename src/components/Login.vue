<template>
    <div class="form-container">
        <div class="form">
            <form aria-label="Login Form" class="pt-3" @submit.prevent="submit">
                <div v-if="!tokenRequired" class="form-floating">
                    <input
                        id="floatingInput"
                        v-model="username"
                        type="text"
                        class="form-control"
                        placeholder="Username"
                        autocomplete="username"
                        required
                    />
                    <label for="floatingInput">{{ $t("Username") }}</label>
                </div>

                <div v-if="!tokenRequired" class="mt-3">
                    <HiddenInput
                        id="floatingPassword"
                        v-model="password"
                        :placeholder="$t('Password')"
                        autocomplete="current-password"
                    />
                </div>

                <div v-if="tokenRequired">
                    <div class="form-floating mt-3">
                        <input
                            id="otp"
                            ref="otpInput"
                            v-model="token"
                            type="text"
                            maxlength="6"
                            class="form-control"
                            placeholder="123456"
                            autocomplete="one-time-code"
                            required
                        />
                        <label for="otp">{{ $t("Token") }}</label>
                    </div>
                </div>

                <div class="form-check mb-3 mt-3 d-flex justify-content-center pe-4">
                    <div class="form-check">
                        <input
                            id="remember"
                            v-model="$root.remember"
                            type="checkbox"
                            value="remember-me"
                            class="form-check-input"
                        />

                        <label class="form-check-label" for="remember">
                            {{ $t("Remember me") }}
                        </label>
                    </div>
                </div>
                <button class="w-100 btn btn-primary" type="submit" :disabled="processing">
                    {{ $t("Login") }}
                </button>

                <template v-if="passkeyAvailable && !tokenRequired">
                    <div class="separator">
                        <span>{{ $t("or") }}</span>
                    </div>

                    <button
                        class="w-100 btn btn-outline-primary"
                        type="button"
                        :disabled="processing"
                        @click="signInWithPasskey"
                    >
                        <font-awesome-icon icon="fingerprint" class="me-1" />
                        Sign in with a passkey
                    </button>
                </template>

                <div v-if="res && !res.ok" class="alert alert-danger mt-3" role="alert">
                    {{ $t(res.msg) }}
                </div>
            </form>
        </div>
    </div>
</template>

<script>
import HiddenInput from "./HiddenInput.vue";
import { startAuthentication } from "@simplewebauthn/browser";

export default {
    components: {
        HiddenInput,
    },
    data() {
        return {
            processing: false,
            username: "",
            password: "",
            token: "",
            res: null,
            tokenRequired: false,
            passkeyAvailable: false,
        };
    },

    watch: {
        tokenRequired(newVal) {
            if (newVal) {
                this.$nextTick(() => {
                    this.$refs.otpInput?.focus();
                });
            }
        },
    },

    mounted() {
        document.title += " - Login";

        // Never offer a button that cannot work: without HTTPS the browser
        // refuses the ceremony outright.
        this.$root.getSocket().emit("passkeyAvailable", (res) => {
            this.passkeyAvailable = res.ok && res.available;
        });
    },

    unmounted() {
        document.title = document.title.replace(" - Login", "");
    },

    methods: {
        /**
         * Submit the user details and attempt to log in
         * @returns {void}
         */
        submit() {
            this.processing = true;

            this.$root.login(this.username, this.password, this.token, (res) => {
                this.processing = false;

                if (res.tokenRequired) {
                    this.tokenRequired = true;
                } else {
                    this.res = res;
                }
            });
        },

        /**
         * Sign in with a passkey, without a username being typed.
         *
         * The authenticator names the account by handing back a credential, so
         * there is nothing to fill in first.
         * @returns {Promise<void>} Promise
         */
        async signInWithPasskey() {
            this.processing = true;
            this.res = null;

            try {
                const begun = await this.emit("passkeyLoginBegin");
                if (!begun.ok) {
                    throw new Error(begun.msg);
                }

                const response = await startAuthentication({ optionsJSON: begun.options });

                const done = await this.emit("passkeyLoginFinish", {
                    ceremonyID: begun.ceremonyID,
                    response,
                });

                if (done.ok) {
                    this.$root.acceptLogin(done.token);
                } else {
                    this.res = done;
                }
            } catch (e) {
                // A cancelled prompt is somebody changing their mind.
                if (e.name !== "NotAllowedError" && e.name !== "AbortError") {
                    this.res = { ok: false,
                        msg: e.message };
                }
            } finally {
                this.processing = false;
            }
        },

        /**
         * A socket call with a callback, as a promise.
         * @param {string} event Event name
         * @param {any} payload Optional payload
         * @returns {Promise<object>} The response
         */
        emit(event, payload) {
            return new Promise((resolve) => {
                if (payload === undefined) {
                    this.$root.getSocket().emit(event, resolve);
                } else {
                    this.$root.getSocket().emit(event, payload, resolve);
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
.form-container {
    display: flex;
    align-items: center;
    padding-top: 40px;
    padding-bottom: 40px;
}

.form-floating {
    > label {
        padding-left: 1.3rem;
    }

    > .form-control {
        padding-left: 1.3rem;
    }
}

.form {
    width: 100%;
    max-width: 330px;
    padding: 15px;
    margin: auto;
    text-align: center;
}
</style>
