import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import net from "node:net";

/**
 * Run the suite against both databases this build supports.
 */

const MARIADB_HOME = process.env.MARIADB_HOME || `${process.env.HOME}/mariadb-portable`;
const PORT = Number(process.env.MARIADB_TEST_PORT || 3399);
// tmpfs: the suite is run often and there is no reason to write it to a disk.
const DATA_DIR = process.env.MARIADB_TEST_DIR || "/dev/shm/kuma-test-mariadb";
const CONNECTION = `mysql://root@127.0.0.1:${PORT}/kuma_test`;

/**
 * Run a command, inheriting stdio, and resolve with its exit code.
 * @param {string} command Executable
 * @param {string[]} args Arguments
 * @param {object} env Extra environment
 * @returns {Promise<number>} Exit code
 */
function run(command, args, env = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            stdio: "inherit",
            env: { ...process.env,
                ...env },
        });
        child.on("close", (code) => resolve(code ?? 1));
    });
}

/**
 * Whether something is already listening on the test port.
 * @returns {Promise<boolean>} True if the port answers
 */
function portIsOpen() {
    return new Promise((resolve) => {
        const socket = net.connect({ host: "127.0.0.1",
            port: PORT });
        socket.on("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
        setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, 1000);
    });
}

/**
 * Start a throwaway MariaDB in RAM.
 * @returns {Promise<object|null>} The server process, or null if it could not start
 */
async function startMariaDB() {
    if (await portIsOpen()) {
        console.log(`\n--- MariaDB: reusing the server already on port ${PORT} ---`);
        return { reused: true };
    }

    if (!existsSync(`${MARIADB_HOME}/bin/mariadbd`)) {
        return null;
    }

    console.log(`\n--- MariaDB: starting a throwaway server in ${DATA_DIR} ---`);
    rmSync(DATA_DIR, { recursive: true,
        force: true });
    mkdirSync(`${DATA_DIR}/data`, { recursive: true });

    spawnSync(
        `${MARIADB_HOME}/scripts/mariadb-install-db`,
        [
            "--no-defaults",
            `--basedir=${MARIADB_HOME}`,
            `--datadir=${DATA_DIR}/data`,
            "--auth-root-authentication-method=normal",
        ],
        { stdio: "ignore" }
    );

    const server = spawn(
        `${MARIADB_HOME}/bin/mariadbd`,
        [
            "--no-defaults",
            `--basedir=${MARIADB_HOME}`,
            `--datadir=${DATA_DIR}/data`,
            `--socket=${DATA_DIR}/mysql.sock`,
            `--port=${PORT}`,
            "--bind-address=127.0.0.1",
        ],
        { stdio: "ignore",
            detached: true }
    );

    for (let i = 0; i < 60; i++) {
        if (await portIsOpen()) {
            spawnSync(
                `${MARIADB_HOME}/bin/mariadb`,
                [ "--no-defaults", "-h", "127.0.0.1", "-P", String(PORT), "-u", "root",
                    "-e", "CREATE DATABASE IF NOT EXISTS kuma_test CHARACTER SET utf8mb4" ],
                { stdio: "ignore" }
            );
            return server;
        }
        await new Promise((r) => setTimeout(r, 1000));
    }

    return null;
}

const suite = [ "--test", "test/backend-test/added/*.js" ];

console.log("--- SQLite ---");
const sqliteCode = await run("npx", [ "cross-env", "TEST_BACKEND=1", "node", ...suite ]);

const server = await startMariaDB();
let mariaCode = 0;

if (!server) {
    console.log(`\n!!! MariaDB not run: no server on port ${PORT} and none at ${MARIADB_HOME}`);
    console.log("!!! Only SQLite was covered. Set MARIADB_HOME, or start a server on that port.");
} else {
    console.log("\n--- MariaDB ---");
    mariaCode = await run("npx", [ "cross-env", "TEST_BACKEND=1", "node", ...suite ], {
        TEST_MYSQL: CONNECTION,
    });

    if (!server.reused) {
        try {
            process.kill(-server.pid);
        } catch (e) {
            // Already gone.
        }
        rmSync(DATA_DIR, { recursive: true,
            force: true });
    }
}

console.log(`\n=== SQLite: ${sqliteCode === 0 ? "pass" : "FAIL"} | MariaDB: ${server ? (mariaCode === 0 ? "pass" : "FAIL") : "not run"} ===`);
process.exit(sqliteCode || mariaCode);
