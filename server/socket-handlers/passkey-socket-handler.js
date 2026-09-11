const { R } = require("redbean-node");
const { log } = require("../../src/util");
const { checkLogin } = require("../util-server");
const { requireOwned } = require("../ownership");
const { loginRateLimiter } = require("../rate-limiter");
const config = require("../passkey/config");
const ceremony = require("../passkey/ceremony");
const store = require("../passkey/store");

/**
 * Registering and using passkeys.
 * @param {Socket} socket Socket.io instance to add listeners on
 * @param {Function} afterLogin Sets a socket up once somebody has signed in
 * @param {Function} createJWT Issues the token a signed-in client keeps
 * @returns {void}
 */
module.exports.passkeySocketHandler = (socket, afterLogin, createJWT) => {
    // Whether to offer the button at all. Public, because the sign-in page asks
    // before anybody has signed in, and the answer says nothing about the
    // instance that its own address does not.
    socket.on("passkeyAvailable", async (callback) => {
        try {
            callback({
                ok: true,
                available: await config.available(config.originOf(socket)),
            });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("passkeyLoginBegin", async (callback) => {
        try {
            const { ceremonyID, options } = await ceremony.loginBegin(config.originOf(socket));
            callback({ ok: true,
                ceremonyID,
                options });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("passkeyLoginFinish", async (data, callback) => {
        try {
            // The same limiter the password path uses: a passkey assertion is
            // cheap to attempt and there is no account named to rate limit by.
            if (!(await loginRateLimiter.pass(callback))) {
                return;
            }

            const user = await ceremony.loginFinish({
                ceremonyID: data?.ceremonyID,
                response: data?.response,
            });

            await afterLogin(socket, user);

            // No second factor is asked for. A passkey is already two: the key
            // is in the device, and the device asked who was holding it.
            callback({
                ok: true,
                token: createJWT(user),
            });
        } catch (e) {
            log.warn("passkey", `Sign-in failed: ${e.message}`);
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("passkeyRegisterBegin", async (callback) => {
        try {
            checkLogin(socket);
            const user = await R.knex("user").where("id", socket.userID).first();
            const { ceremonyID, options } = await ceremony.registerBegin(user, config.originOf(socket));
            callback({ ok: true,
                ceremonyID,
                options });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("passkeyRegisterFinish", async (data, callback) => {
        try {
            checkLogin(socket);
            const user = await R.knex("user").where("id", socket.userID).first();
            const passkey = await ceremony.registerFinish(user, {
                ceremonyID: data?.ceremonyID,
                response: data?.response,
                name: data?.name,
                userAgent: socket.handshake?.headers?.["user-agent"] || "",
            });
            callback({ ok: true,
                msg: "Passkey added.",
                passkey });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("passkeyList", async (callback) => {
        try {
            checkLogin(socket);
            callback({ ok: true,
                passkeys: await store.listForUser(socket.userID) });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("passkeyRename", async (passkeyID, name, callback) => {
        try {
            checkLogin(socket);
            await requireOwned("passkey", passkeyID, socket.userID);

            const trimmed = typeof name === "string" ? name.trim() : "";
            if (!trimmed) {
                throw new Error("Please input a name.");
            }
            await store.rename(passkeyID, socket.userID, store.nameFor(trimmed, ""));

            callback({ ok: true,
                msg: "Renamed." });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("passkeyDelete", async (passkeyID, callback) => {
        try {
            checkLogin(socket);
            await requireOwned("passkey", passkeyID, socket.userID);
            await store.remove(passkeyID, socket.userID);

            log.info("passkey", `Account ${socket.userID} removed a passkey`);
            callback({ ok: true,
                msg: "Passkey removed." });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });
};
