<template>
    <div>
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
            <p class="form-text mb-0">
                Everybody here has their own monitors, status pages, tags and notifications, and can see none of
                anybody else's. An administrator can change the instance's settings and manage these accounts; a
                regular account can only change its own.
            </p>
        </div>

        <div class="table-wrapper">
            <table class="table table-borderless table-hover">
                <thead>
                    <tr>
                        <th>Username</th>
                        <th>Role</th>
                        <th>Status</th>
                        <th class="text-end">Actions</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="user in users" :key="user.id">
                        <td>
                            {{ user.username }}
                            <span v-if="user.id === $root.currentUser?.id" class="text-secondary sub">(you)</span>
                        </td>
                        <td>
                            <span class="badge rounded-pill" :class="user.isAdmin ? 'bg-primary' : 'bg-secondary'">
                                {{ user.isAdmin ? "Administrator" : "Regular" }}
                            </span>
                        </td>
                        <td>
                            <span v-if="user.active" class="text-secondary">Active</span>
                            <span v-else class="badge rounded-pill bg-warning">Disabled</span>
                        </td>
                        <td class="text-end">
                            <button class="btn btn-normal btn-sm me-2" @click="edit(user)">
                                {{ $t("Edit") }}
                            </button>
                            <button
                                class="btn btn-outline-danger btn-sm"
                                :disabled="user.id === $root.currentUser?.id"
                                :title="
                                    user.id === $root.currentUser?.id
                                        ? 'You cannot delete your own account'
                                        : 'Delete this account and everything it owns'
                                "
                                @click="confirmDelete(user)"
                            >
                                {{ $t("Delete") }}
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <button class="btn btn-primary me-2" @click="startAdd">
            <font-awesome-icon icon="plus" />
            Add account
        </button>

        <button class="btn btn-normal" @click="$refs.importDialog.show()">
            Import from another Uptime Kuma
        </button>

        <ImportAccountDialog ref="importDialog" @imported="load" />

        <!-- Add or edit -->
        <div ref="userDialog" class="modal fade" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">{{ editing.id ? "Edit account" : "Add account" }}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" />
                    </div>
                    <form @submit.prevent="save">
                        <div class="modal-body">
                            <div class="mb-3">
                                <label for="user-username" class="form-label">Username</label>
                                <input
                                    id="user-username"
                                    v-model="editing.username"
                                    type="text"
                                    class="form-control"
                                    autocomplete="off"
                                    required
                                />
                            </div>

                            <div v-if="!editing.id" class="mb-3">
                                <label for="user-password" class="form-label">Password</label>
                                <input
                                    id="user-password"
                                    v-model="editing.password"
                                    type="password"
                                    class="form-control"
                                    autocomplete="new-password"
                                    required
                                />
                            </div>

                            <div class="mb-3 form-check">
                                <input
                                    id="user-is-admin"
                                    v-model="editing.isAdmin"
                                    class="form-check-input"
                                    type="checkbox"
                                />
                                <label class="form-check-label" for="user-is-admin">Administrator</label>
                                <div class="form-text">
                                    Can change the instance's settings and manage accounts. Still sees only its own
                                    monitors — an administrator is not given everybody's data.
                                </div>
                            </div>

                            <div v-if="editing.id" class="mb-3 form-check">
                                <input
                                    id="user-active"
                                    v-model="editing.active"
                                    class="form-check-input"
                                    type="checkbox"
                                />
                                <label class="form-check-label" for="user-active">Allowed to log in</label>
                                <div class="form-text">
                                    Unticking this keeps everything the account owns, including its monitors, which
                                    carry on being checked. It only stops the account signing in.
                                </div>
                            </div>

                            <div v-if="editing.id" class="mb-3">
                                <label for="user-new-password" class="form-label">Set a new password</label>
                                <input
                                    id="user-new-password"
                                    v-model="editing.newPassword"
                                    type="password"
                                    class="form-control"
                                    autocomplete="new-password"
                                />
                                <div class="form-text">
                                    Leave blank to keep the current one. Setting it signs the account out everywhere.
                                </div>
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-normal" data-bs-dismiss="modal">
                                {{ $t("Cancel") }}
                            </button>
                            <button type="submit" class="btn btn-primary" :disabled="processing">
                                {{ $t("Save") }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>

        <!-- Delete -->
        <div ref="deleteDialog" class="modal fade" tabindex="-1">
            <div class="modal-dialog">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title text-danger">Delete {{ deleting.username }}</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" />
                    </div>
                    <form @submit.prevent="remove">
                        <div class="modal-body">
                            <p>
                                This deletes the account and everything it owns. There is no undo, and no backup is
                                taken.
                            </p>

                            <ul v-if="deletingSummary" class="summary">
                                <li>
                                    <strong>{{ deletingSummary.monitors }}</strong>
                                    monitor(s), with all of their history
                                </li>
                                <li>
                                    <strong>{{ deletingSummary.statusPages }}</strong>
                                    status page(s)
                                </li>
                                <li>
                                    <strong>{{ deletingSummary.tags }}</strong>
                                    tag(s)
                                </li>
                                <li>
                                    <strong>{{ deletingSummary.notifications }}</strong>
                                    notification(s)
                                </li>
                                <li>
                                    <strong>{{ deletingSummary.maintenance }}</strong>
                                    maintenance window(s)
                                </li>
                            </ul>

                            <div class="mb-2">
                                <label for="user-confirm" class="form-label">
                                    Type
                                    <strong>{{ deleting.username }}</strong>
                                    to confirm
                                </label>
                                <input
                                    id="user-confirm"
                                    v-model="deleteConfirmation"
                                    type="text"
                                    class="form-control"
                                    autocomplete="off"
                                />
                            </div>
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-normal" data-bs-dismiss="modal">
                                {{ $t("Cancel") }}
                            </button>
                            <button
                                type="submit"
                                class="btn btn-danger"
                                :disabled="processing || deleteConfirmation !== deleting.username"
                            >
                                {{ $t("Delete") }}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    </div>
</template>

<script>
import { Modal } from "bootstrap";
import { useToast } from "vue-toastification";
import ImportAccountDialog from "../ImportAccountDialog.vue";
const toast = useToast();

export default {
    name: "SettingsUsers",

    components: {
        ImportAccountDialog,
    },

    data() {
        return {
            users: [],
            editing: {},
            deleting: {},
            deletingSummary: null,
            deleteConfirmation: "",
            processing: false,
            userModal: null,
            deleteModal: null,
        };
    },

    mounted() {
        this.userModal = new Modal(this.$refs.userDialog);
        this.deleteModal = new Modal(this.$refs.deleteDialog);
        this.load();
    },

    beforeUnmount() {
        this.userModal?.dispose();
        this.deleteModal?.dispose();
    },

    methods: {
        /**
         * Fetch the account list.
         * @returns {void}
         */
        load() {
            this.$root.getSocket().emit("getUsers", (res) => {
                if (res.ok) {
                    this.users = res.users;
                } else {
                    toast.error(res.msg);
                }
            });
        },

        /**
         * Open the dialog for a new account.
         * @returns {void}
         */
        startAdd() {
            this.editing = { username: "",
                password: "",
                isAdmin: false };
            this.userModal.show();
        },

        /**
         * Open the dialog for an existing account.
         * @param {object} user The account to edit
         * @returns {void}
         */
        edit(user) {
            this.editing = { ...user,
                newPassword: "" };
            this.userModal.show();
        },

        /**
         * Create or update, then reload the list.
         * @returns {void}
         */
        save() {
            this.processing = true;

            const done = (res) => {
                this.processing = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.userModal.hide();
                    this.load();
                }
            };

            if (!this.editing.id) {
                this.$root.getSocket().emit("addUser", this.editing, done);
                return;
            }

            this.$root.getSocket().emit(
                "editUser",
                {
                    id: this.editing.id,
                    username: this.editing.username,
                    isAdmin: this.editing.isAdmin,
                    active: this.editing.active,
                },
                (res) => {
                    if (res.ok && this.editing.newPassword) {
                        this.$root
                            .getSocket()
                            .emit("resetUserPassword", this.editing.id, this.editing.newPassword, done);
                        return;
                    }
                    done(res);
                }
            );
        },

        /**
         * Ask what is about to be destroyed, then open the confirmation.
         * @param {object} user The account to delete
         * @returns {void}
         */
        confirmDelete(user) {
            this.deleting = user;
            this.deleteConfirmation = "";
            this.deletingSummary = null;

            this.$root.getSocket().emit("getUserDataSummary", user.id, (res) => {
                if (res.ok) {
                    this.deletingSummary = res.data;
                }
            });

            this.deleteModal.show();
        },

        /**
         * Delete the account.
         * @returns {void}
         */
        remove() {
            this.processing = true;
            this.$root.getSocket().emit("deleteUser", this.deleting.id, this.deleteConfirmation, (res) => {
                this.processing = false;
                this.$root.toastRes(res);
                if (res.ok) {
                    this.deleteModal.hide();
                    this.load();
                }
            });
        },
    },
};
</script>

<style lang="scss" scoped>
@import "../../assets/vars.scss";

.table-wrapper {
    overflow-x: auto;
}

.sub {
    font-size: 0.8rem;
}

.badge.bg-warning {
    color: $dark-font-color2;
}

.summary {
    font-size: 0.9rem;

    strong {
        font-variant-numeric: tabular-nums;
    }
}
</style>
