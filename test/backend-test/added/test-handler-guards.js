const { describe, test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

/**
 * Every socket handler that addresses something by id must check who is
 * asking.
 */

const SOURCES = [ "server/server.js" ];
const HANDLER_DIR = "server/socket-handlers";

/**
 * Handlers that take an id and deliberately do not check ownership, with the
 * reason.
 */
const DELIBERATELY_UNGUARDED = {
    getIncidentHistory: "public status page endpoint",

    addStatusPage: "creates a new page rather than addressing one",

    addProxy: "Proxy.save resolves the id against the owner",
    addDockerHost: "DockerHost.save resolves the id against the owner",
    addRemoteBrowser: "RemoteBrowser.save resolves the id against the owner",
    addNotification: "Notification.save resolves the id against the owner",
    deleteNotification: "Notification.delete resolves the id against the owner",
    deleteProxy: "Proxy.delete resolves the id against the owner",
    deleteDockerHost: "DockerHost.delete resolves the id against the owner",
    deleteRemoteBrowser: "RemoteBrowser.delete resolves the id against the owner",

    // Both call checkOwner() before touching anything.
    resumeMonitor: "startMonitor() calls checkOwner()",
    pauseMonitor: "pauseMonitor() calls checkOwner()",
};

/** Anything that proves the handler established who may act. */
const GUARDS = [
    "checkAdmin(",
    "requireOwned",
    "ownedStatusPageID(",
    "ownedMonitorID(",
    "findOwned(",
    "requireAllOwned(",
    "user_id = ?",
    "checkOwner(",
];

/**
 * Every socket handler that takes an id, with the body that follows it.
 * @returns {object[]} Entries of { name, file, body }
 */
function collectHandlers() {
    const root = path.resolve(__dirname, "../../..");
    const files = [
        ...SOURCES,
        ...fs
            .readdirSync(path.join(root, HANDLER_DIR))
            .filter((f) => f.endsWith(".js"))
            .map((f) => `${HANDLER_DIR}/${f}`),
    ];

    const handlers = [];
    for (const file of files) {
        const src = fs.readFileSync(path.join(root, file), "utf-8");
        const re = /socket\.on\(\s*"([^"]+)"\s*,\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g;

        let match;
        while ((match = re.exec(src)) !== null) {
            const [ , name, args ] = match;

            // Only the ones that address something the caller named.
            if (!/\b\w*(ID|Id|id|slug|Slug)\b/.test(args)) {
                continue;
            }

            const start = re.lastIndex;
            const next = src.indexOf('socket.on("', start);
            handlers.push({
                name,
                file,
                body: src.slice(start, next > 0 ? next : src.length),
            });
        }
    }
    return handlers;
}

describe("Socket handlers that take an id", () => {
    const handlers = collectHandlers();

    test("there are handlers to audit at all", () => {
        assert.ok(handlers.length > 40, `only found ${handlers.length} handlers, the parser is probably broken`);
    });

    test("every one of them checks who is asking", () => {
        const unguarded = handlers
            .filter((h) => !GUARDS.some((guard) => h.body.includes(guard)))
            .filter((h) => !(h.name in DELIBERATELY_UNGUARDED))
            .map((h) => `${h.name} (${h.file})`);

        assert.deepStrictEqual(
            unguarded,
            [],
            `these address something by id but only check that somebody is logged in:\n  ${unguarded.join("\n  ")}`
        );
    });

    test("the exception list does not name handlers that no longer exist", () => {
        const names = new Set(handlers.map((h) => h.name));
        const stale = Object.keys(DELIBERATELY_UNGUARDED).filter((name) => !names.has(name));
        assert.deepStrictEqual(stale, [], `no longer present: ${stale.join(", ")}`);
    });

    test("the handlers that manage accounts all require an administrator", () => {
        const adminHandlers = [ "getUsers", "addUser", "editUser", "resetUserPassword", "deleteUser", "getUserDataSummary" ];

        for (const name of adminHandlers) {
            const handler = handlers.find((h) => h.name === name) ||
                collectAll().find((h) => h.name === name);
            assert.ok(handler, `${name} not found`);
            assert.ok(handler.body.includes("checkAdmin("), `${name} must call checkAdmin`);
        }
    });
});

/**
 * Every handler, including the ones that take no id.
 * @returns {object[]} Entries of { name, file, body }
 */
function collectAll() {
    const root = path.resolve(__dirname, "../../..");
    const file = `${HANDLER_DIR}/user-socket-handler.js`;
    const src = fs.readFileSync(path.join(root, file), "utf-8");
    const re = /socket\.on\(\s*"([^"]+)"\s*,\s*(?:async\s*)?\(([^)]*)\)\s*=>\s*\{/g;

    const handlers = [];
    let match;
    while ((match = re.exec(src)) !== null) {
        const start = re.lastIndex;
        const next = src.indexOf('socket.on("', start);
        handlers.push({
            name: match[1],
            file,
            body: src.slice(start, next > 0 ? next : src.length),
        });
    }
    return handlers;
}
