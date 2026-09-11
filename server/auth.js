const basicAuth = require("express-basic-auth");
const passwordHash = require("./password-hash");
const { R } = require("redbean-node");
const { log } = require("../src/util");
const { loginRateLimiter, apiRateLimiter } = require("./rate-limiter");
const { Settings } = require("./settings");
const dayjs = require("dayjs");

/**
 * Login to web app
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @returns {Promise<(Bean|null)>} User or null if login failed
 */
exports.login = async function (username, password) {
    if (typeof username !== "string" || typeof password !== "string") {
        return null;
    }

    let user = await R.findOne("user", "TRIM(username) = ? AND active = 1 ", [username.trim()]);

    if (user && passwordHash.verify(password, user.password)) {
        // Upgrade the hash to bcrypt
        if (passwordHash.needRehash(user.password)) {
            await R.exec("UPDATE `user` SET password = ? WHERE id = ? ", [
                await passwordHash.generate(password),
                user.id,
            ]);
        }
        return user;
    }

    return null;
};

/**
 * Validate a provided API key
 * @param {string} key API key to verify
 * @returns {boolean} API is ok?
 */
async function verifyAPIKey(key) {
    return (await resolveAPIKey(key)) !== null;
}

/**
 * Resolve a presented API key to the row that issued it.
 *
 * Returns the bean rather than a boolean so callers can tell which account is
 * asking - an API key grants access to its own owner's monitors and nothing
 * else.
 * @param {string} key API key to check
 * @returns {Promise<Bean|null>} The api_key row, or null if it is no good
 */
async function resolveAPIKey(key) {
    if (typeof key !== "string" || !key.startsWith("uk") || !key.includes("_")) {
        return null;
    }

    // uk prefix + key ID is before _
    let index = key.substring(2, key.indexOf("_"));
    let clear = key.substring(key.indexOf("_") + 1, key.length);

    let hash = await R.findOne("api_key", " id=? ", [index]);

    if (hash === null) {
        return null;
    }

    let current = dayjs();
    let expiry = dayjs(hash.expires);
    if (expiry.diff(current) < 0 || !hash.active) {
        return null;
    }

    return (await passwordHash.verify(clear, hash.key)) ? hash : null;
}

/**
 * The account behind the API key on this request, if any.
 *
 * express-basic-auth leaves the presented credentials on req.auth, so the key
 * can be resolved again in the handler without changing its authorizer.
 * @param {express.Request} req Express request object
 * @returns {Promise<number|null>} The owning user id, or null
 */
exports.apiKeyOwner = async function (req) {
    const presented = req?.auth?.password;
    if (!presented) {
        return null;
    }
    const bean = await resolveAPIKey(presented);
    return bean ? bean.user_id : null;
};

/**
 * The account behind an already-authenticated request.
 *
 * apiAuth accepts either an API key or, when no keys exist, a username and
 * password. Either way the credentials have already been checked by the time a
 * handler runs, so the username only has to be resolved to an id here.
 * @param {express.Request} req Express request object
 * @returns {Promise<number|null>} The account id, or null
 */
exports.requestOwner = async function (req) {
    const owner = await exports.apiKeyOwner(req);
    if (owner) {
        return owner;
    }

    const username = req?.auth?.user;
    if (!username) {
        return null;
    }
    const user = await R.findOne("user", "TRIM(username) = ? AND active = 1 ", [String(username).trim()]);
    return user ? user.id : null;
};

/**
 * Callback for basic auth authorizers
 * @callback authCallback
 * @param {any} err Any error encountered
 * @param {boolean} authorized Is the client authorized?
 */

/**
 * Custom authorizer for express-basic-auth
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @param {authCallback} callback Callback to handle login result
 * @returns {void}
 */
function apiAuthorizer(username, password, callback) {
    // API Rate Limit
    apiRateLimiter.pass(null, 0).then((pass) => {
        if (pass) {
            verifyAPIKey(password).then((valid) => {
                if (!valid) {
                    log.warn("api-auth", "Failed API auth attempt: invalid API Key");
                }
                callback(null, valid);
                // Only allow a set number of api requests per minute
                // (currently set to 60)
                apiRateLimiter.removeTokens(1);
            });
        } else {
            log.warn("api-auth", "Failed API auth attempt: rate limit exceeded");
            callback(null, false);
        }
    });
}

/**
 * Custom authorizer for express-basic-auth
 * @param {string} username Username to login with
 * @param {string} password Password to login with
 * @param {authCallback} callback Callback to handle login result
 * @returns {void}
 */
function userAuthorizer(username, password, callback) {
    // Login Rate Limit
    loginRateLimiter.pass(null, 0).then((pass) => {
        if (pass) {
            exports.login(username, password).then((user) => {
                callback(null, user != null);

                if (user == null) {
                    log.warn("basic-auth", "Failed basic auth attempt: invalid username/password");
                    loginRateLimiter.removeTokens(1);
                }
            });
        } else {
            log.warn("basic-auth", "Failed basic auth attempt: rate limit exceeded");
            callback(null, false);
        }
    });
}

/**
 * Use basic auth
 * @param {express.Request} req Express request object
 * @param {express.Response} res Express response object
 * @param {express.NextFunction} next Next handler in chain
 * @returns {Promise<void>}
 */
exports.basicAuth = async function (req, res, next) {
    const middleware = basicAuth({
        authorizer: userAuthorizer,
        authorizeAsync: true,
        challenge: true,
    });

    middleware(req, res, next);
};

/**
 * Use use API Key if API keys enabled, else use basic auth
 * @param {express.Request} req Express request object
 * @param {express.Response} res Express response object
 * @param {express.NextFunction} next Next handler in chain
 * @returns {Promise<void>}
 */
exports.apiAuth = async function (req, res, next) {
    let usingAPIKeys = await Settings.get("apiKeysEnabled");
    let middleware;
    if (usingAPIKeys) {
        middleware = basicAuth({
            authorizer: apiAuthorizer,
            authorizeAsync: true,
            challenge: true,
        });
    } else {
        middleware = basicAuth({
            authorizer: userAuthorizer,
            authorizeAsync: true,
            challenge: true,
        });
    }
    middleware(req, res, next);
};
