const { checkAdmin } = require("../util-server");
const { log } = require("../../src/util");
const { R } = require("redbean-node");
const source = require("../import/source");
const upload = require("../import/upload");
const { importAccountOrUndo } = require("../import/importer");
const { createUser, deleteUser } = require("../user-management");

/**
 * Importing an account from another Uptime Kuma.
 * @param {Socket} socket Socket.io instance to add listeners on
 * @returns {void}
 */
module.exports.importSocketHandler = (socket) => {
    /**
     * Turn the client's source description into one the reader understands.
     * @param {object} config What the client sent
     * @param {number} userID The administrator asking
     * @returns {object} A source config
     */
    const resolveSource = (config, userID) => {
        if (config?.type === "sqlite") {
            return { type: "sqlite",
                path: upload.pathFor(config.token, userID) };
        }

        return {
            type: "mysql",
            host: config?.host,
            port: config?.port,
            database: config?.database,
            username: config?.username,
            password: config?.password,
        };
    };

    socket.on("importUploadBegin", async (size, callback) => {
        try {
            const admin = await checkAdmin(socket);
            callback({ ok: true,
                ...upload.begin(admin.id, size) });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("importUploadChunk", async (token, chunk, callback) => {
        try {
            const admin = await checkAdmin(socket);
            callback({ ok: true,
                bytes: upload.appendChunk(token, admin.id, chunk) });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("importUploadEnd", async (token, callback) => {
        try {
            const admin = await checkAdmin(socket);
            const { bytes } = upload.finish(token, admin.id);
            callback({ ok: true,
                bytes });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    socket.on("importUploadCancel", async (token, callback) => {
        try {
            await checkAdmin(socket);
            upload.discard(token);
            callback({ ok: true });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    /**
     * Open the source, confirm it is an Uptime Kuma database, and say what is
     * in it.
     */
    socket.on("importTestSource", async (config, callback) => {
        try {
            const admin = await checkAdmin(socket);
            const result = await source.inspect(resolveSource(config, admin.id));
            callback(result);
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        }
    });

    /**
     * What one account in the source would bring with it.
     */
    socket.on("importPreviewUser", async (config, sourceUserID, callback) => {
        let db;
        try {
            const admin = await checkAdmin(socket);
            db = source.connect(resolveSource(config, admin.id));
            await source.assertLooksLikeKuma(db);

            callback({
                ok: true,
                counts: await source.summarise(db, Number(sourceUserID)),
            });
        } catch (e) {
            callback({ ok: false,
                msg: e.message });
        } finally {
            if (db) {
                await db.destroy().catch(() => {});
            }
        }
    });

    /**
     * Create the account and copy everything the source account owns into it.
     */
    socket.on("importCreateUser", async (config, sourceUserID, options, callback) => {
        let db;
        let newUserID = null;

        try {
            const admin = await checkAdmin(socket);
            const resolved = resolveSource(config, admin.id);

            db = source.connect(resolved);
            await source.assertLooksLikeKuma(db);

            const sourceUser = await db("user").where({ id: Number(sourceUserID) }).first();
            if (!sourceUser) {
                throw new Error("That account is not in the source database.");
            }

            const username = String(options?.username ?? "").trim() || sourceUser.username;

            newUserID = await createUser({
                username,
                password: require("crypto").randomBytes(32).toString("hex"),
                isAdmin: !!options?.isAdmin,
            });

            log.info("import", `Importing source account ${sourceUser.username} into ${username}`);

            const counts = await importAccountOrUndo({
                source: db,
                dest: R.knex,
                sourceUserID: Number(sourceUserID),
                newUserID,
                onProgress: (progress) => socket.emit("importProgress", progress),
            });

            // The staged upload has served its purpose.
            if (config?.type === "sqlite" && config.token) {
                upload.discard(config.token);
            }

            log.info("import", `Imported ${counts.monitor ?? 0} monitor(s) into ${username}`);

            callback({
                ok: true,
                msg: "successAdded",
                msgi18n: true,
                userID: newUserID,
                counts,
            });
        } catch (e) {
            log.error("import", `Import failed: ${e.message}`);

            if (newUserID !== null) {
                const stillThere = await R.knex("user").where({ id: newUserID }).first("id").catch(() => null);
                if (stillThere) {
                    await deleteUser(newUserID).catch(() => {});
                }
            }

            callback({ ok: false,
                msg: e.message });
        } finally {
            if (db) {
                await db.destroy().catch(() => {});
            }
        }
    });

    socket.on("disconnect", () => {
        if (socket.userID) {
            upload.discardFor(socket.userID);
        }
    });
};
