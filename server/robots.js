const { R } = require("redbean-node");
const { UserSettings } = require("./user-settings");

/**
 * Building robots.txt when indexing is a per-account choice.
 */

/**
 * Render the file from what each account asked for.
 * @param {object} input What the accounts asked for
 * @param {boolean} input.anyIndexed Whether any account wants indexing
 * @param {string[]} input.disallowedSlugs Slugs of pages that must not be indexed
 * @returns {string} The body of robots.txt
 */
function renderRobotsTxt({ anyIndexed, disallowedSlugs }) {
    if (!anyIndexed) {
        return "User-agent: *\nDisallow: /";
    }

    const lines = [ "User-agent: *", "Disallow:" ];
    for (const slug of disallowedSlugs) {
        lines.push(`Disallow: /status/${slug}`);
    }
    return lines.join("\n");
}

/**
 * Work out what each account wants and render the file.
 * @returns {Promise<string>} The body of robots.txt
 */
async function buildRobotsTxt() {
    const pages = await R.getAll(
        "SELECT slug, user_id FROM status_page WHERE published = 1 AND slug IS NOT NULL"
    );

    let anyIndexed = false;
    const disallowedSlugs = [];

    const wants = new Map();
    for (const page of pages) {
        if (!wants.has(page.user_id)) {
            wants.set(page.user_id, !!(await UserSettings.resolve(page.user_id, "searchEngineIndex")));
        }

        if (wants.get(page.user_id)) {
            anyIndexed = true;
        } else {
            disallowedSlugs.push(page.slug);
        }
    }

    return renderRobotsTxt({ anyIndexed,
        disallowedSlugs });
}

module.exports = {
    renderRobotsTxt,
    buildRobotsTxt,
};
