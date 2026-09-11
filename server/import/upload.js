const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Database = require("../database");
const { log } = require("../../src/util");

/**
 * Receiving an uploaded SQLite database, a piece at a time.
 */

/** Refuse anything larger than this. A Kuma database is big; it is not this big. */
const MAX_BYTES = 4 * 1024 * 1024 * 1024;

/** An upload nobody has touched for this long is abandoned and removed. */
const STALE_MS = 60 * 60 * 1000;

/** Uploads in progress, by token. */
const uploads = new Map();

/**
 * Where uploaded databases are staged.
 * @returns {string} Absolute path to the staging directory
 */
function stagingDir() {
    const dir = path.join(Database.uploadDir, "import");
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
}

/**
 * Remove uploads that were started and never finished.
 * @returns {void}
 */
function sweepStale() {
    const now = Date.now();
    for (const [ token, upload ] of uploads.entries()) {
        if (now - upload.touched > STALE_MS) {
            log.info("import", `Discarding a stale upload from user ${upload.userID}`);
            discard(token);
        }
    }
}

/**
 * Start receiving a file.
 * @param {number} userID Administrator doing the upload
 * @param {number} size Size the client says the file is
 * @returns {object} token and the chunk size to send
 * @throws The declared size is over the limit
 */
function begin(userID, size) {
    sweepStale();

    const declared = Number(size);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
        throw new Error("That file is larger than 4 GB.");
    }

    // One at a time per account: a second upload means the first was abandoned.
    for (const [ token, upload ] of uploads.entries()) {
        if (upload.userID === userID) {
            discard(token);
        }
    }

    const token = crypto.randomBytes(16).toString("hex");
    const filePath = path.join(stagingDir(), `${token}.db`);

    uploads.set(token, {
        userID,
        path: filePath,
        bytes: 0,
        touched: Date.now(),
        handle: fs.openSync(filePath, "w"),
    });

    return { token };
}

/**
 * Append a piece of the file.
 * @param {string} token Upload token
 * @param {number} userID Account the chunk must belong to
 * @param {Buffer|ArrayBuffer|Uint8Array} chunk The bytes
 * @returns {number} Bytes received so far
 * @throws The upload is unknown, not theirs, or too large
 */
function appendChunk(token, userID, chunk) {
    const upload = uploads.get(token);
    if (!upload || upload.userID !== userID) {
        throw new Error("That upload has expired. Please start again.");
    }

    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (upload.bytes + buffer.length > MAX_BYTES) {
        discard(token);
        throw new Error("That file is larger than 4 GB.");
    }

    fs.writeSync(upload.handle, buffer);
    upload.bytes += buffer.length;
    upload.touched = Date.now();

    return upload.bytes;
}

/**
 * Finish an upload and hand back where the file landed.
 * @param {string} token Upload token
 * @param {number} userID Account the upload must belong to
 * @returns {object} path and bytes
 * @throws The upload is unknown, not theirs, or empty
 */
function finish(token, userID) {
    const upload = uploads.get(token);
    if (!upload || upload.userID !== userID) {
        throw new Error("That upload has expired. Please start again.");
    }

    fs.closeSync(upload.handle);
    upload.handle = null;

    if (upload.bytes === 0) {
        discard(token);
        throw new Error("That file is empty.");
    }

    return { path: upload.path,
        bytes: upload.bytes };
}

/**
 * Delete an upload and forget it.
 * @param {string} token Upload token
 * @returns {void}
 */
function discard(token) {
    const upload = uploads.get(token);
    if (!upload) {
        return;
    }

    try {
        if (upload.handle !== null) {
            fs.closeSync(upload.handle);
        }
    } catch (e) {
        // Already closed.
    }

    try {
        fs.rmSync(upload.path, { force: true });
    } catch (e) {
        log.debug("import", `Could not remove ${upload.path}: ${e.message}`);
    }

    uploads.delete(token);
}

/**
 * Delete every upload belonging to an account.
 * @param {number} userID Account to clear
 * @returns {void}
 */
function discardFor(userID) {
    for (const [ token, upload ] of uploads.entries()) {
        if (upload.userID === userID) {
            discard(token);
        }
    }
}

/**
 * Look up a finished upload's path.
 * @param {string} token Upload token
 * @param {number} userID Account it must belong to
 * @returns {string} The path on disk
 * @throws It is unknown or not theirs
 */
function pathFor(token, userID) {
    const upload = uploads.get(token);
    if (!upload || upload.userID !== userID) {
        throw new Error("That upload has expired. Please start again.");
    }
    return upload.path;
}

module.exports = {
    MAX_BYTES,
    STALE_MS,
    begin,
    appendChunk,
    finish,
    discard,
    discardFor,
    pathFor,
    stagingDir,
    uploads,
};
