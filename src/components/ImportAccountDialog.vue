<template>
    <div ref="dialog" class="modal fade" tabindex="-1">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Import an account from another Uptime Kuma</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" />
                </div>

                <div class="modal-body">
                    <!-- Step 1: where the data is -->
                    <div class="mb-3">
                        <label class="form-label">Where is the other instance's database?</label>
                        <div class="form-check">
                            <input
                                id="source-sqlite"
                                v-model="sourceType"
                                class="form-check-input"
                                type="radio"
                                value="sqlite"
                            />
                            <label class="form-check-label" for="source-sqlite">
                                A SQLite file I upload
                                <span class="text-secondary sub">— usually <code>data/kuma.db</code></span>
                            </label>
                        </div>
                        <div class="form-check">
                            <input
                                id="source-mysql"
                                v-model="sourceType"
                                class="form-check-input"
                                type="radio"
                                value="mysql"
                            />
                            <label class="form-check-label" for="source-mysql">
                                A MySQL or MariaDB server
                            </label>
                        </div>
                    </div>

                    <!-- SQLite -->
                    <div v-if="sourceType === 'sqlite'" class="mb-3">
                        <input class="form-control" type="file" accept=".db,.sqlite,.sqlite3" @change="pickFile" />
                        <div v-if="uploading" class="progress mt-2">
                            <div class="progress-bar" :style="{ width: uploadPercent + '%' }">
                                {{ uploadPercent }}%
                            </div>
                        </div>
                        <div class="form-text">
                            Nothing is written to the file. Take a copy while the other instance is stopped, or use a
                            backup — a database copied from underneath a running server can be mid-write.
                        </div>
                    </div>

                    <!-- MySQL -->
                    <div v-if="sourceType === 'mysql'" class="row g-2 mb-3">
                        <div class="col-md-6">
                            <label class="form-label" for="my-host">Host</label>
                            <input id="my-host" v-model="mysql.host" class="form-control" placeholder="10.0.0.5" />
                        </div>
                        <div class="col-md-2">
                            <label class="form-label" for="my-port">Port</label>
                            <input id="my-port" v-model="mysql.port" class="form-control" placeholder="3306" />
                        </div>
                        <div class="col-md-4">
                            <label class="form-label" for="my-db">Database</label>
                            <input id="my-db" v-model="mysql.database" class="form-control" placeholder="kuma" />
                        </div>
                        <div class="col-md-6">
                            <label class="form-label" for="my-user">Username</label>
                            <input id="my-user" v-model="mysql.username" class="form-control" autocomplete="off" />
                        </div>
                        <div class="col-md-6">
                            <label class="form-label" for="my-pass">Password</label>
                            <input
                                id="my-pass"
                                v-model="mysql.password"
                                type="password"
                                class="form-control"
                                autocomplete="new-password"
                            />
                        </div>
                        <div class="col-12 form-text">
                            Only read from, never written to. A read-only database user is enough, and is the safer
                            thing to give it.
                        </div>
                    </div>

                    <button
                        class="btn btn-normal mb-3"
                        :disabled="testing || uploading || !canTest"
                        @click="testSource"
                    >
                        {{ testing ? "Checking…" : "Check the source" }}
                    </button>

                    <div v-if="error" class="alert alert-danger" role="alert">{{ error }}</div>

                    <!-- Step 2: which account -->
                    <div v-if="sourceUsers.length" class="mb-3">
                        <label class="form-label">Which account should be imported?</label>
                        <div v-for="user in sourceUsers" :key="user.id" class="form-check">
                            <input
                                :id="`src-user-${user.id}`"
                                v-model="selectedUserID"
                                class="form-check-input"
                                type="radio"
                                :value="user.id"
                                @change="previewUser"
                            />
                            <label class="form-check-label" :for="`src-user-${user.id}`">
                                {{ user.username }}
                                <span class="text-secondary sub">
                                    — {{ user.monitors }} monitor(s){{ user.isAdmin ? ", administrator there" : "" }}
                                </span>
                            </label>
                        </div>
                    </div>

                    <!-- Step 3: what would come across -->
                    <div v-if="counts" class="mb-3">
                        <label class="form-label">What will come across</label>
                        <ul class="counts">
                            <li v-for="(value, key) in shownCounts" :key="key">
                                <strong>{{ value }}</strong>
                                {{ key }}
                            </li>
                        </ul>
                        <div class="form-text">
                            Everything the account owns, including its password and two-factor secret, so they sign in
                            exactly as they did before. The other instance's own settings are not imported.
                        </div>
                    </div>

                    <!-- Step 4: the new account -->
                    <div v-if="counts" class="mb-3">
                        <label class="form-label" for="import-username">Username on this instance</label>
                        <input id="import-username" v-model="username" class="form-control" autocomplete="off" />
                        <div class="form-text">Taken from the source. Change it if that name is already in use here.</div>
                    </div>

                    <div v-if="counts" class="form-check">
                        <input id="import-is-admin" v-model="isAdmin" class="form-check-input" type="checkbox" />
                        <label class="form-check-label" for="import-is-admin">Administrator</label>
                        <div class="form-text">
                            This instance's decision, not the source's — an administrator there arrives as a regular
                            account here unless you tick this.
                        </div>
                    </div>

                    <div v-if="importing" class="mt-3">
                        <div class="progress">
                            <div class="progress-bar progress-bar-striped progress-bar-animated" style="width: 100%">
                                {{ progressLabel }}
                            </div>
                        </div>
                        <div class="form-text">
                            Large histories take a while. Leaving this page will not stop it.
                        </div>
                    </div>
                </div>

                <div class="modal-footer">
                    <button type="button" class="btn btn-normal" data-bs-dismiss="modal">{{ $t("Cancel") }}</button>
                    <button
                        type="button"
                        class="btn btn-primary"
                        :disabled="!counts || importing || !username"
                        @click="runImport"
                    >
                        Import
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import { useToast } from "vue-toastification";
const toast = useToast();

/**
 * How much of the file to send per socket message.
 */
const CHUNK_BYTES = 256 * 1024;

export default {
    name: "ImportAccountDialog",

    emits: [ "imported" ],

    data() {
        return {
            modal: null,
            sourceType: "sqlite",
            mysql: { host: "",
                port: "3306",
                database: "",
                username: "",
                password: "" },
            file: null,
            uploadToken: null,
            uploading: false,
            uploadPercent: 0,
            testing: false,
            importing: false,
            error: "",
            sourceUsers: [],
            selectedUserID: null,
            counts: null,
            username: "",
            isAdmin: false,
            progressLabel: "Starting…",
        };
    },

    computed: {
        /**
         * Whether the source is described well enough to try.
         * @returns {boolean} True when the check button should work
         */
        canTest() {
            if (this.sourceType === "sqlite") {
                return !!this.file;
            }
            return !!this.mysql.host && !!this.mysql.database;
        },

        /**
         * The counts worth showing, with readable names and zeroes kept.
         * @returns {object} Label to count
         */
        shownCounts() {
            const names = {
                monitor: "monitors",
                heartbeat: "heartbeats",
                tag: "tags",
                notification: "notifications",
                status_page: "status pages",
                maintenance: "maintenance windows",
                proxy: "proxies",
                docker_host: "Docker hosts",
                remote_browser: "remote browsers",
                api_key: "API keys",
            };

            const out = {};
            for (const [ key, label ] of Object.entries(names)) {
                if (this.counts?.[key] !== null && this.counts?.[key] !== undefined) {
                    out[label] = this.counts[key];
                }
            }
            return out;
        },
    },

    mounted() {
        this.modal = new Modal(this.$refs.dialog);
        this.$root.getSocket().on("importProgress", this.onProgress);
    },

    beforeUnmount() {
        this.$root.getSocket().off("importProgress", this.onProgress);
        this.modal?.dispose();
    },

    methods: {
        /**
         * Open the dialog, forgetting anything from last time.
         * @returns {void}
         */
        show() {
            this.reset();
            this.modal.show();
        },

        /**
         * Clear every field.
         * @returns {void}
         */
        reset() {
            this.sourceType = "sqlite";
            this.mysql = { host: "",
                port: "3306",
                database: "",
                username: "",
                password: "" };
            this.file = null;
            this.uploadToken = null;
            this.uploading = false;
            this.uploadPercent = 0;
            this.testing = false;
            this.importing = false;
            this.error = "";
            this.sourceUsers = [];
            this.selectedUserID = null;
            this.counts = null;
            this.username = "";
            this.isAdmin = false;
        },

        /**
         * Show which table is being copied.
         * @param {object} progress table and rows so far
         * @returns {void}
         */
        onProgress(progress) {
            this.progressLabel = `Copying ${progress.table}… ${progress.imported} row(s)`;
        },

        /**
         * Remember the chosen file, and drop anything already uploaded.
         * @param {Event} event The change event
         * @returns {void}
         */
        pickFile(event) {
            this.file = event.target.files?.[0] ?? null;
            this.uploadToken = null;
            this.counts = null;
            this.sourceUsers = [];
        },

        /**
         * Emit one socket call as a promise.
         * @param {string} event Event name
         * @param {...any} args Arguments
         * @returns {Promise<object>} The server's reply
         */
        call(event, ...args) {
            return new Promise((resolve) => {
                this.$root.getSocket().emit(event, ...args, resolve);
            });
        },

        /**
         * Send the file up in pieces.
         * @returns {Promise<string|null>} The upload token, or null on failure
         */
        async uploadFile() {
            this.uploading = true;
            this.uploadPercent = 0;

            try {
                const begun = await this.call("importUploadBegin", this.file.size);
                if (!begun.ok) {
                    this.error = begun.msg;
                    return null;
                }

                for (let offset = 0; offset < this.file.size; offset += CHUNK_BYTES) {
                    const slice = await this.file.slice(offset, offset + CHUNK_BYTES).arrayBuffer();
                    const sent = await this.call("importUploadChunk", begun.token, slice);
                    if (!sent.ok) {
                        this.error = sent.msg;
                        return null;
                    }
                    this.uploadPercent = Math.round(((offset + CHUNK_BYTES) / this.file.size) * 100);
                    if (this.uploadPercent > 100) {
                        this.uploadPercent = 100;
                    }
                }

                const done = await this.call("importUploadEnd", begun.token);
                if (!done.ok) {
                    this.error = done.msg;
                    return null;
                }

                return begun.token;
            } finally {
                this.uploading = false;
            }
        },

        /**
         * The source as the server needs it described.
         * @returns {object} Source configuration
         */
        sourceConfig() {
            if (this.sourceType === "sqlite") {
                return { type: "sqlite",
                    token: this.uploadToken };
            }
            return { type: "mysql",
                ...this.mysql };
        },

        /**
         * Open the source and list its accounts.
         * @returns {Promise<void>} Promise
         */
        async testSource() {
            this.error = "";
            this.counts = null;
            this.sourceUsers = [];
            this.testing = true;

            try {
                if (this.sourceType === "sqlite" && !this.uploadToken) {
                    this.uploadToken = await this.uploadFile();
                    if (!this.uploadToken) {
                        return;
                    }
                }

                const result = await this.call("importTestSource", this.sourceConfig());
                if (!result.ok) {
                    this.error = result.msg;
                    return;
                }

                this.sourceUsers = result.users;

                if (result.users.length === 0) {
                    this.error = "That database has no accounts in it.";
                    return;
                }

                if (result.users.length === 1) {
                    this.selectedUserID = result.users[0].id;
                    await this.previewUser();
                }
            } finally {
                this.testing = false;
            }
        },

        /**
         * Ask what the chosen account would bring with it.
         * @returns {Promise<void>} Promise
         */
        async previewUser() {
            this.error = "";
            const result = await this.call("importPreviewUser", this.sourceConfig(), this.selectedUserID);

            if (!result.ok) {
                this.error = result.msg;
                return;
            }

            this.counts = result.counts;
            this.username = this.sourceUsers.find((u) => u.id === this.selectedUserID)?.username ?? "";
        },

        /**
         * Create the account and copy everything into it.
         * @returns {Promise<void>} Promise
         */
        async runImport() {
            this.error = "";
            this.importing = true;
            this.progressLabel = "Starting…";

            try {
                const result = await this.call("importCreateUser", this.sourceConfig(), this.selectedUserID, {
                    username: this.username,
                    isAdmin: this.isAdmin,
                });

                if (!result.ok) {
                    this.error = result.msg;
                    return;
                }

                toast.success(`Imported ${result.counts?.monitor ?? 0} monitor(s) into ${this.username}`);
                this.modal.hide();
                this.$emit("imported");
            } finally {
                this.importing = false;
            }
        },
    },
};
</script>

<style lang="scss" scoped>
.sub {
    font-size: 0.85rem;
}

.counts {
    columns: 2;
    font-size: 0.9rem;
    margin-bottom: 0.5rem;

    strong {
        font-variant-numeric: tabular-nums;
    }
}

.progress {
    height: 1.4rem;
}
</style>
