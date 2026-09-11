const { describe, test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const TestDB = require("../mock-testdb");
const { R } = require("redbean-node");
const { Settings } = require("../../server/settings");
const { UserSettings } = require("../../server/user-settings");
const { USER_SETTINGS, USER_SETTING_DEFAULTS } = require("../../server/setting-scope");
const { ACCENT_COLORS, DEFAULT_ACCENT, accentHex, isAccent, lighten, iconDataUrl, ICON_COLORS } = require("../../src/util");
const users = require("../../server/user-management");
const { scratchDir } = require("./helpers");

describe("The accent palette", () => {
    test("green is first, and is what an account gets by default", () => {
        assert.strictEqual(ACCENT_COLORS[0].name, "green");
        assert.strictEqual(ACCENT_COLORS[0].hex, "#5cdd8b", "Uptime Kuma's own green, unchanged");
        assert.strictEqual(DEFAULT_ACCENT, "green");
        assert.strictEqual(accentHex(DEFAULT_ACCENT), "#5cdd8b");
    });

    test("every accent is a distinct, well formed colour with a label", () => {
        const seen = new Set();
        for (const accent of ACCENT_COLORS) {
            assert.match(accent.hex, /^#[0-9a-f]{6}$/, `${accent.name} should be a hex colour`);
            assert.ok(accent.label, `${accent.name} needs a label`);
            assert.ok(!seen.has(accent.hex), `${accent.hex} is used twice`);
            seen.add(accent.hex);
        }
        assert.ok(ACCENT_COLORS.length > 1, "a palette of one is not a palette");
    });

    test("anything unrecognised falls back to green rather than to nothing", () => {
        for (const bogus of [ "purple-ish", "", null, undefined, 42, {} ]) {
            assert.strictEqual(accentHex(bogus), "#5cdd8b");
            assert.strictEqual(isAccent(bogus), false);
        }
        assert.strictEqual(isAccent("violet"), true);
    });

    test("every accent is bright enough to read on the dark theme", () => {
        // The dark background is #0d1117. A washed-out accent would be unusable
        // as a foreground, which is what most of these are.
        for (const accent of ACCENT_COLORS) {
            const [ r, g, b ] = [ 1, 3, 5 ].map((i) => parseInt(accent.hex.slice(i, i + 2), 16));
            const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            assert.ok(luminance > 0.45, `${accent.name} is too dark to read (${luminance.toFixed(2)})`);
        }
    });
});

describe("The accent belongs to the account", () => {
    const testDB = new TestDB(scratchDir("uptime-kuma-test-accent"));
    let alice;
    let bob;

    before(async () => {
        await testDB.create();
    });

    after(async () => {
        Settings.stopCacheCleaner();
        UserSettings.stopCacheCleaner();
        await testDB.destroy();
    });

    beforeEach(async () => {
        await R.knex("user_setting").delete();
        await R.knex("user").delete();
        alice = await users.createUser({ username: "alice",
            password: "x" });
        bob = await users.createUser({ username: "bob",
            password: "x" });
    });

    test("it is a per-account setting, not an instance one", () => {
        assert.ok(USER_SETTINGS.includes("accentColor"));
        assert.strictEqual(USER_SETTING_DEFAULTS.accentColor, DEFAULT_ACCENT);
    });

    test("an account that never chose gets green", async () => {
        assert.strictEqual(await UserSettings.resolve(alice, "accentColor"), "green");
    });

    test("two accounts keep different colours", async () => {
        await UserSettings.set(alice, "accentColor", "violet");
        await UserSettings.set(bob, "accentColor", "coral");

        assert.strictEqual(await UserSettings.resolve(alice, "accentColor"), "violet");
        assert.strictEqual(await UserSettings.resolve(bob, "accentColor"), "coral");
    });

    test("one account changing its colour leaves the other alone", async () => {
        await UserSettings.set(alice, "accentColor", "cyan");
        assert.strictEqual(await UserSettings.resolve(bob, "accentColor"), "green",
            "bob never chose, so bob is still green");
    });
});

describe("Only colours on the list can be stored", () => {
    test("the handler checks the name against the palette", () => {
        const handler = fs.readFileSync(
            path.resolve(__dirname, "../../server/socket-handlers/user-socket-handler.js"), "utf8");

        assert.match(handler, /setAccentColor/, "the handler has to exist");
        assert.match(handler, /isAccent\(name\)/,
            "an arbitrary string must not reach the database - it would end up in a style attribute");
        assert.match(handler, /checkLogin\(socket\)/, "and it is the signed-in account's own colour");
    });

    test("it is sent with the account's identity, so it applies at sign-in", () => {
        const client = fs.readFileSync(path.resolve(__dirname, "../../server/client.js"), "utf8");
        assert.match(client, /accentColor: await UserSettings\.resolve/);
    });
});

describe("The palette is spread, not bunched", () => {
    /**
     * The hue of a colour, in degrees.
     * @param {string} hex A #rrggbb colour
     * @returns {number} Hue, 0 to 360
     */
    function hue(hex) {
        const [ r, g, b ] = [ 1, 3, 5 ].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max === min) {
            return 0;
        }
        const d = max - min;
        let h;
        if (max === r) {
            h = ((g - b) / d) % 6;
        } else if (max === g) {
            h = (b - r) / d + 2;
        } else {
            h = (r - g) / d + 4;
        }
        return ((h * 60) + 360) % 360;
    }

    test("no two accents are nearly the same colour", () => {
        // The first three used to be green, mint and cyan, which read as one
        // colour in a row of swatches.
        const hues = ACCENT_COLORS.map((a) => hue(a.hex)).sort((a, b) => a - b);
        for (let i = 0; i < hues.length; i++) {
            const next = i === hues.length - 1 ? hues[0] + 360 : hues[i + 1];
            assert.ok(next - hues[i] >= 10,
                `two accents sit ${Math.round(next - hues[i])} degrees apart, too close to tell apart`);
        }
    });

    test("the palette covers the whole wheel", () => {
        const hues = ACCENT_COLORS.map((a) => hue(a.hex));
        assert.ok(hues.some((h) => h < 60 || h > 330), "something warm");
        assert.ok(hues.some((h) => h >= 60 && h < 180), "something green");
        assert.ok(hues.some((h) => h >= 180 && h < 270), "something blue");
        assert.ok(hues.some((h) => h >= 270 && h <= 330), "something violet or pink");
    });

    test("the warm end is included on purpose", () => {
        // It overlaps the warning and danger hues. That is the owner's choice
        // to make, not something to protect them from - but it should be a
        // choice somebody made, not an accident.
        const names = ACCENT_COLORS.map((a) => a.name);
        for (const warm of [ "red", "orange", "amber" ]) {
            assert.ok(names.includes(warm), `${warm} belongs in the palette`);
        }
    });
});

describe("The accent reaches the up state as well", () => {
    const root = path.resolve(__dirname, "../..");
    const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

    test("the Bootstrap colour utilities follow it", () => {
        // .bg-primary is the up badge and --bs-primary is what the heartbeat
        // bar reads, so both have to move with the accent.
        const app = read("src/assets/app.scss");
        assert.match(app, /\.bg-primary\s*\{[^}]*var\(--accent/);
        assert.match(app, /--bs-primary:\s*var\(--accent/);
    });

    test("the places that mean up use the accent, not a fixed green", () => {
        for (const file of [ "src/components/Tooltip.vue", "src/pages/DashboardHome.vue",
            "src/components/CertificateInfo.vue", "src/pages/StatusPage.vue" ]) {
            assert.ok(!/(?<![\w$-])\$primary\b/.test(read(file)), `${file} should paint with $accent`);
        }
    });

    test("the fallback is still green, for a page nobody has signed in to", () => {
        assert.match(read("src/assets/vars.scss"), /\$accent: var\(--accent, #\{\$primary\}\)/);
    });
});

describe("The icon is redrawn in the accent", () => {
    const svg = fs.readFileSync(path.resolve(__dirname, "../../public/icon.svg"), "utf8");

    test("the icon really is the two colours we swap", () => {
        assert.ok(svg.includes(ICON_COLORS.base), "the gradient's base stop");
        assert.ok(svg.includes(ICON_COLORS.light), "and its light stop");
    });

    test("lightening the green lands where the shipped light stop is", () => {
        // Which is why the default icon looks untouched.
        assert.strictEqual(lighten(ICON_COLORS.base.toLowerCase(), 0.28), "#8ae7ab");
    });

    test("recolouring leaves no green behind", () => {
        const url = iconDataUrl(svg, "#a98cff");
        const drawn = decodeURIComponent(url.replace("data:image/svg+xml;charset=utf-8,", ""));

        assert.ok(!drawn.includes(ICON_COLORS.base), "the base stop is gone");
        assert.ok(!drawn.includes(ICON_COLORS.light), "so is the light one");
        assert.ok(drawn.includes("#a98cff"), "and the accent is there");
        assert.match(url, /^data:image\/svg\+xml/, "usable straight as a favicon href");
    });

    test("every accent produces a usable icon", () => {
        for (const accent of ACCENT_COLORS) {
            const url = iconDataUrl(svg, accent.hex);
            assert.ok(url.length > 100, `${accent.name} produced nothing`);
            assert.ok(!url.includes("#"), "a raw # would truncate the data URI");
        }
    });
});
