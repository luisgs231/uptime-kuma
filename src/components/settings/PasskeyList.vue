<template>
    <div class="mt-5 mb-3">
        <h5 class="my-4 settings-subheading">Passkeys</h5>

        <p class="form-text">
            Sign in with the device instead of a password &mdash; a fingerprint, a face, a PIN, or a hardware key. The
            private half never leaves the device; this instance only ever stores the public half, so there is nothing
            here worth stealing.
        </p>

        <div v-if="!available" class="alert alert-warning" role="alert">
            <strong>Not available at this address.</strong> Passkeys need HTTPS, or localhost. Reach this instance over
            https and the option appears.
        </div>

        <template v-else>
            <div v-if="passkeys.length" class="passkeys mb-3">
                <div v-for="passkey in passkeys" :key="passkey.id" class="passkey">
                    <div class="detail">
                        <div class="name">{{ passkey.name }}</div>
                        <div class="used text-secondary">
                            Added {{ $root.datetime(passkey.createdAt) }} &middot;
                            <template v-if="passkey.lastUsedAt">
                                last used {{ $root.datetime(passkey.lastUsedAt) }}
                            </template>
                            <template v-else>never used</template>
                        </div>
                    </div>
                    <div class="actions">
                        <button class="btn btn-sm btn-outline-secondary" type="button" @click="startRename(passkey)">
                            {{ $t("Rename") }}
                        </button>
                        <button class="btn btn-sm btn-outline-danger" type="button" @click="confirmRemove(passkey)">
                            {{ $t("Delete") }}
                        </button>
                    </div>
                </div>
            </div>

            <p v-else class="form-text">No passkeys yet.</p>

            <div class="mb-4">
                <button class="btn btn-primary me-2" type="button" :disabled="busy" @click="add">
                    <span v-if="busy" class="spinner-border spinner-border-sm me-1"></span>
                    Add a passkey
                </button>
            </div>
        </template>

        <Confirm ref="confirmRemove" btn-style="btn-danger" :yes-text="$t('Yes')" :no-text="$t('No')" @yes="remove">
            Removing this passkey means the device it lives on can no longer sign in. Its own copy stays on the device
            until you delete it there too.
        </Confirm>
    </div>
</template>

<script>
import Confirm from "../Confirm.vue";
import { startRegistration } from "@simplewebauthn/browser";

export default {
    components: {
        Confirm,
    },
    data() {
        return {
            available: false,
            busy: false,
            passkeys: [],
            removing: null,
        };
    },
    mounted() {
        this.$root.getSocket().emit("passkeyAvailable", (res) => {
            this.available = res.ok && res.available;
            if (this.available) {
                this.load();
            }
        });
    },
    methods: {
        /**
         * Read this account's passkeys.
         * @returns {void}
         */
        load() {
            this.$root.getSocket().emit("passkeyList", (res) => {
                if (res.ok) {
                    this.passkeys = res.passkeys;
                }
            });
        },

        /**
         * Enrol a new passkey.
         * @returns {Promise<void>} Promise
         */
        async add() {
            this.busy = true;
            try {
                const begun = await this.emit("passkeyRegisterBegin");
                if (!begun.ok) {
                    throw new Error(begun.msg);
                }

                // The browser takes it from here: it prompts, the authenticator
                // makes the key pair, and only the public half comes back.
                const response = await startRegistration({ optionsJSON: begun.options });

                const done = await this.emit("passkeyRegisterFinish", {
                    ceremonyID: begun.ceremonyID,
                    response,
                });
                this.$root.toastRes(done);
                if (done.ok) {
                    this.load();
                }
            } catch (e) {
                // A cancelled prompt is somebody changing their mind, not a fault.
                if (e.name !== "NotAllowedError" && e.name !== "AbortError") {
                    this.$root.toastError(e.message);
                }
            } finally {
                this.busy = false;
            }
        },

        /**
         * Ask for a new name and send it.
         * @param {object} passkey The passkey to rename
         * @returns {void}
         */
        startRename(passkey) {
            // eslint-disable-next-line no-alert
            const name = window.prompt("What should this passkey be called?", passkey.name);
            if (name === null) {
                return;
            }
            this.$root.getSocket().emit("passkeyRename", passkey.id, name, (res) => {
                this.$root.toastRes(res);
                this.load();
            });
        },

        /**
         * Ask before removing one.
         * @param {object} passkey The passkey to remove
         * @returns {void}
         */
        confirmRemove(passkey) {
            this.removing = passkey;
            this.$refs.confirmRemove.show();
        },

        /**
         * Remove the passkey that was confirmed.
         * @returns {void}
         */
        remove() {
            if (!this.removing) {
                return;
            }
            this.$root.getSocket().emit("passkeyDelete", this.removing.id, (res) => {
                this.$root.toastRes(res);
                this.removing = null;
                this.load();
            });
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
@import "../../assets/vars.scss";

.passkeys {
    .passkey {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 14px;
        border-radius: 10px;
        background-color: $highlight-white;

        .dark & {
            background-color: $dark-bg2;
        }

        & + .passkey {
            margin-top: 8px;
        }

        .name {
            font-weight: bold;
        }

        .used {
            font-size: 0.85em;
        }

        .actions {
            display: flex;
            gap: 6px;
            flex-shrink: 0;
        }
    }
}
</style>
