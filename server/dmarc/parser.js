/**
 * DMARC aggregate report parsing.
 */
const zlib = require("zlib");
const { XMLParser } = require("fast-xml-parser");

const xmlParser = new XMLParser({
    ignoreAttributes: true,
    parseTagValue: false,
    trimValues: true,
    isArray: (name, jpath) => [
        "feedback.record",
        "feedback.record.auth_results.dkim",
        "feedback.record.auth_results.spf",
    ].includes(jpath),
});

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_EOCD = 0x06054b50;

/**
 * Read the entries of a zip archive held in memory.
 * @param {Buffer} buf Complete zip archive
 * @returns {Buffer[]} Decompressed contents of each entry
 * @throws {Error} If the buffer is not a readable zip archive
 */
function readZipEntries(buf) {
    let eocd = -1;
    const lowest = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= lowest; i--) {
        if (buf.readUInt32LE(i) === ZIP_EOCD) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) {
        throw new Error("not a zip archive: no end-of-central-directory record");
    }

    const entryCount = buf.readUInt16LE(eocd + 10);
    let pos = buf.readUInt32LE(eocd + 16);
    const out = [];

    for (let i = 0; i < entryCount; i++) {
        if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== ZIP_CENTRAL_HEADER) {
            throw new Error("corrupt zip: bad central directory entry");
        }
        const method = buf.readUInt16LE(pos + 10);
        const compressedSize = buf.readUInt32LE(pos + 20);
        const nameLen = buf.readUInt16LE(pos + 28);
        const extraLen = buf.readUInt16LE(pos + 30);
        const commentLen = buf.readUInt16LE(pos + 32);
        const localOffset = buf.readUInt32LE(pos + 42);
        const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);

        if (buf.readUInt32LE(localOffset) !== ZIP_LOCAL_HEADER) {
            throw new Error("corrupt zip: bad local header");
        }
        const localNameLen = buf.readUInt16LE(localOffset + 26);
        const localExtraLen = buf.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLen + localExtraLen;
        const data = buf.subarray(dataStart, dataStart + compressedSize);

        if (name.endsWith("/")) {
            // directory entry
        } else if (method === 0) {
            out.push(Buffer.from(data));
        } else if (method === 8) {
            out.push(zlib.inflateRawSync(data));
        } else {
            throw new Error(`unsupported zip compression method ${method}`);
        }

        pos += 46 + nameLen + extraLen + commentLen;
    }
    return out;
}

/**
 * Recover report XML from an attachment payload.
 * @param {Buffer} buf Raw attachment content
 * @returns {Buffer[]} Any XML documents found; empty if this isn't a report
 */
function extractDocuments(buf) {
    if (!buf || buf.length < 4) {
        return [];
    }
    if (buf.readUInt32LE(0) === ZIP_LOCAL_HEADER) {
        try {
            return readZipEntries(buf);
        } catch (e) {
            return [];
        }
    }
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
        try {
            return [ zlib.gunzipSync(buf) ];
        } catch (e) {
            return [];
        }
    }
    return [ buf ];
}

/**
 * Whether a document looks like a DMARC aggregate report.
 * @param {Buffer} buf Decompressed document
 * @returns {boolean} True if it is DMARC XML
 */
function looksLikeDmarc(buf) {
    return !!buf && buf.subarray(0, 4096).includes("<feedback");
}

/**
 * Recover DMARC report XML from an attachment payload.
 * @param {Buffer} buf Raw attachment content
 * @returns {Buffer[]} Any DMARC XML documents found
 */
function extractXmlBuffers(buf) {
    return extractDocuments(buf).filter(looksLikeDmarc);
}

/**
 * Pull a nested value out of the parsed XML, tolerating missing nodes.
 * @param {object} obj Parsed XML object
 * @param {string} path Dot-separated path
 * @param {string} fallback Value to use when absent or empty
 * @returns {string} Trimmed string value
 */
function text(obj, path, fallback = "") {
    let cur = obj;
    for (const key of path.split(".")) {
        if (cur === null || cur === undefined || typeof cur !== "object") {
            return fallback;
        }
        cur = cur[key];
    }
    if (cur === null || cur === undefined) {
        return fallback;
    }
    const s = String(cur).trim();
    return s === "" ? fallback : s;
}

/**
 * Parse an integer out of the XML, falling back when it isn't a number.
 * @param {object} obj Parsed XML object
 * @param {string} path Dot-separated path
 * @param {number} fallback Value to use when absent or unparseable
 * @returns {number} Parsed integer
 */
function int(obj, path, fallback = 0) {
    const n = parseInt(text(obj, path, ""), 10);
    return Number.isFinite(n) ? n : fallback;
}

/**
 * Parse one DMARC aggregate report.
 * @param {Buffer|string} xml Report XML
 * @returns {object|null} Normalised report, or null if this isn't a DMARC aggregate report
 */
function parseAggregateReport(xml) {
    let doc;
    try {
        doc = xmlParser.parse(xml);
    } catch (e) {
        return null;
    }
    const fb = doc && doc.feedback;
    if (!fb) {
        return null;
    }

    const domain = text(fb, "policy_published.domain").toLowerCase();
    const reportId = text(fb, "report_metadata.report_id");
    if (!domain || !reportId) {
        return null;
    }

    const report = {
        orgName: text(fb, "report_metadata.org_name", "unknown"),
        orgEmail: text(fb, "report_metadata.email"),
        reportId,
        dateBegin: int(fb, "report_metadata.date_range.begin"),
        dateEnd: int(fb, "report_metadata.date_range.end"),
        domain,
        policy: {
            p: text(fb, "policy_published.p", "none"),
            sp: text(fb, "policy_published.sp"),
            pct: int(fb, "policy_published.pct", 100),
            adkim: text(fb, "policy_published.adkim", "r"),
            aspf: text(fb, "policy_published.aspf", "r"),
        },
        records: [],
    };

    for (const rec of fb.record || []) {
        const auth = rec.auth_results || {};
        report.records.push({
            sourceIp: text(rec, "row.source_ip"),
            count: int(rec, "row.count"),
            disposition: text(rec, "row.policy_evaluated.disposition", "none").toLowerCase(),
            dkimAligned: text(rec, "row.policy_evaluated.dkim", "fail").toLowerCase() === "pass",
            spfAligned: text(rec, "row.policy_evaluated.spf", "fail").toLowerCase() === "pass",
            headerFrom: text(rec, "identifiers.header_from", domain).toLowerCase(),
            envelopeFrom: text(rec, "identifiers.envelope_from").toLowerCase(),
            dkimResults: (auth.dkim || []).map((d) => ({
                domain: text(d, "domain").toLowerCase(),
                selector: text(d, "selector"),
                result: text(d, "result", "none").toLowerCase(),
            })),
            spfResults: (auth.spf || []).map((s) => ({
                domain: text(s, "domain").toLowerCase(),
                result: text(s, "result", "none").toLowerCase(),
            })),
        });
    }
    return report;
}

/**
 * Whether a report row passed DMARC.
 * @param {object} record Parsed record row
 * @returns {boolean} True when the row passed DMARC
 */
function recordPassed(record) {
    return record.dkimAligned || record.spfAligned;
}

module.exports = {
    extractDocuments,
    looksLikeDmarc,
    extractXmlBuffers,
    readZipEntries,
    parseAggregateReport,
    recordPassed,
};
