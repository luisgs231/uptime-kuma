const { checkAdmin } = require("../util-server");
const { log } = require("../../src/util");
const { UptimeKumaServer } = require("../uptime-kuma-server");
const {
    listUsers,
    createUser,
    updateUser,
    setUserPassword,
    describeUserData,
    deleteUser,
} = require("../user-management");

/**
 * Managing accounts, which only an administrator may do.
 * @param {Socket} socket Socket.io instance to add listeners on
 * @returns {void}
 */
module.exports.userSocketHandler = (socket) => {
    socket.on("getUsers", async (callback) => {
        try {
            await checkAdmin(socket);

            callback({
                ok: true,
                users: await listUsers(),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("addUser", async (user, callback) => {
        try {
            await checkAdmin(socket);

            const id = await createUser({
                username: user?.username,
                password: user?.password,
                isAdmin: !!user?.isAdmin,
            });

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                userID: id,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("editUser", async (user, callback) => {
        try {
            const admin = await checkAdmin(socket);
            const userID = Number(user?.id);

            if (userID === admin.id && (user.isAdmin === false || user.active === false)) {
                throw new Error("You cannot remove your own access. Ask another administrator.");
            }

            await updateUser(userID, {
                username: user?.username,
                isAdmin: user?.isAdmin,
                active: user?.active,
            });

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("resetUserPassword", async (userID, password, callback) => {
        try {
            await checkAdmin(socket);
            await setUserPassword(Number(userID), password);

            UptimeKumaServer.getInstance().disconnectAllSocketClients(Number(userID));

            callback({
                ok: true,
                msg: "Saved.",
                msgi18n: true,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("getUserDataSummary", async (userID, callback) => {
        try {
            await checkAdmin(socket);

            callback({
                ok: true,
                data: await describeUserData(Number(userID)),
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });

    socket.on("deleteUser", async (userID, confirmUsername, callback) => {
        try {
            const admin = await checkAdmin(socket);
            const id = Number(userID);

            if (id === admin.id) {
                throw new Error("You cannot delete your own account. Ask another administrator.");
            }

            const { R } = require("redbean-node");
            const target = await R.findOne("user", " id = ? ", [ id ]);
            if (!target) {
                throw new Error("Not found.");
            }
            if (String(confirmUsername ?? "").trim() !== target.username) {
                throw new Error("Type the account's username to confirm.");
            }

            const deleted = await deleteUser(id);

            UptimeKumaServer.getInstance().disconnectAllSocketClients(id);

            log.info("user", `Account ${target.username} deleted by ${admin.username}`);

            callback({
                ok: true,
                msg: "successDeleted",
                msgi18n: true,
                deleted,
            });
        } catch (e) {
            callback({
                ok: false,
                msg: e.message,
            });
        }
    });
};
