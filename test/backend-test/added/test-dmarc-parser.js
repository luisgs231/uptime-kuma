const { describe, test } = require("node:test");
const assert = require("node:assert");
const zlib = require("zlib");
const {
    extractXmlBuffers,
    parseAggregateReport,
    recordPassed,
} = require("../../../server/dmarc/parser");

/**
 * Build a zip archive in memory.
 * @param {string} name Entry filename
 * @param {Buffer} content Uncompressed entry content
 * @param {object} opts Options: `store` to skip deflate, `streaming` for a data descriptor
 * @returns {Buffer} Complete zip archive
 */
function makeZip(name, content, opts = {}) {
    const store = !!opts.store;
    const streaming = !!opts.streaming;
    const body = store ? content : zlib.deflateRawSync(content);
    const crc = zlib.crc32(content);
    const nameBuf = Buffer.from(name, "utf8");
    const flags = streaming ? 0x08 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt32LE(streaming ? 0 : crc, 14);
    local.writeUInt32LE(streaming ? 0 : body.length, 18);
    local.writeUInt32LE(streaming ? 0 : content.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);

    const parts = [ local, nameBuf, body ];
    if (streaming) {
        const dd = Buffer.alloc(16);
        dd.writeUInt32LE(0x08074b50, 0);
        dd.writeUInt32LE(crc, 4);
        dd.writeUInt32LE(body.length, 8);
        dd.writeUInt32LE(content.length, 12);
        parts.push(dd);
    }
    const localTotal = parts.reduce((n, b) => n + b.length, 0);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(0, 42);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(central.length + nameBuf.length, 12);
    eocd.writeUInt32LE(localTotal, 16);

    return Buffer.concat([ ...parts, central, nameBuf, eocd ]);
}

const SAMPLE = Buffer.from(`<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>18234567890123456789</report_id>
    <date_range><begin>1756684800</begin><end>1756771200</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain>
    <adkim>r</adkim><aspf>r</aspf><p>reject</p><sp>reject</sp><pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.10</source_ip><count>480</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>example.com</domain><selector>s1</selector><result>pass</result></dkim>
      <spf><domain>example.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.77</source_ip><count>12</count>
      <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <spf><domain>evil.example</domain><result>softfail</result></spf>
    </auth_results>
  </record>
</feedback>`, "utf8");

describe("DMARC parser", () => {
    test("parses an aggregate report", () => {
        const r = parseAggregateReport(SAMPLE);
        assert.strictEqual(r.orgName, "google.com");
        assert.strictEqual(r.reportId, "18234567890123456789");
        assert.strictEqual(r.domain, "example.com");
        assert.strictEqual(r.dateBegin, 1756684800);
        assert.strictEqual(r.policy.p, "reject");
        assert.strictEqual(r.policy.pct, 100);
        assert.strictEqual(r.records.length, 2);
    });

    test("keeps a large report id exact instead of coercing it to a float", () => {
        const r = parseAggregateReport(SAMPLE);
        assert.strictEqual(typeof r.reportId, "string");
        assert.strictEqual(r.reportId, "18234567890123456789");
    });

    test("reads aligned results, not raw auth results", () => {
        const [ good, bad ] = parseAggregateReport(SAMPLE).records;
        assert.strictEqual(good.sourceIp, "203.0.113.10");
        assert.strictEqual(good.count, 480);
        assert.ok(good.dkimAligned && good.spfAligned);
        assert.ok(recordPassed(good));

        assert.strictEqual(bad.disposition, "quarantine");
        assert.ok(!bad.dkimAligned && !bad.spfAligned);
        assert.ok(!recordPassed(bad));
        assert.strictEqual(bad.spfResults[0].domain, "evil.example");
    });

    test("a single aligned pass is enough to pass DMARC", () => {
        assert.ok(recordPassed({ dkimAligned: true,
            spfAligned: false }));
        assert.ok(recordPassed({ dkimAligned: false,
            spfAligned: true }));
        assert.ok(!recordPassed({ dkimAligned: false,
            spfAligned: false }));
    });

    test("normalises a report with a single record into an array", () => {
        const one = Buffer.from(SAMPLE.toString().replace(/<record>[\s\S]*?<\/record>\s*<record>[\s\S]*?<\/record>/, `
  <record><row><source_ip>192.0.2.1</source_ip><count>3</count>
  <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>fail</spf></policy_evaluated>
  </row><identifiers><header_from>example.com</header_from></identifiers>
  <auth_results><dkim><domain>example.com</domain><result>pass</result></dkim></auth_results></record>`));
        const r = parseAggregateReport(one);
        assert.strictEqual(r.records.length, 1);
        assert.strictEqual(r.records[0].sourceIp, "192.0.2.1");
        assert.strictEqual(r.records[0].dkimResults.length, 1);
    });

    test("rejects things that are not aggregate reports", () => {
        assert.strictEqual(parseAggregateReport(Buffer.from("not xml at all")), null);
        assert.strictEqual(parseAggregateReport(Buffer.from("<html><body>hi</body></html>")), null);
        // An SMTP TLS report shares the mailbox but is JSON, not DMARC XML.
        assert.strictEqual(parseAggregateReport(Buffer.from('{"organization-name":"x"}')), null);
        // Well-formed XML that is missing the fields we key on.
        assert.strictEqual(parseAggregateReport(Buffer.from("<feedback><report_metadata/></feedback>")), null);
    });
});

describe("DMARC attachment extraction", () => {
    test("reads a deflated zip", () => {
        const out = extractXmlBuffers(makeZip("report.xml", SAMPLE));
        assert.strictEqual(out.length, 1);
        assert.strictEqual(parseAggregateReport(out[0]).domain, "example.com");
    });

    test("reads a stored (uncompressed) zip", () => {
        const out = extractXmlBuffers(makeZip("report.xml", SAMPLE, { store: true }));
        assert.strictEqual(out.length, 1);
        assert.strictEqual(parseAggregateReport(out[0]).domain, "example.com");
    });

    test("reads a streamed zip whose sizes live in a data descriptor", () => {
        const out = extractXmlBuffers(makeZip("report.xml", SAMPLE, { streaming: true }));
        assert.strictEqual(out.length, 1);
        assert.strictEqual(parseAggregateReport(out[0]).domain, "example.com");
    });

    test("reads a gzip", () => {
        const out = extractXmlBuffers(zlib.gzipSync(SAMPLE));
        assert.strictEqual(out.length, 1);
        assert.strictEqual(parseAggregateReport(out[0]).domain, "example.com");
    });

    test("reads a bare xml attachment", () => {
        assert.strictEqual(extractXmlBuffers(SAMPLE).length, 1);
    });

    test("ignores attachments that are not reports", () => {
        // A gzipped SMTP TLS report: decompresses fine, but isn't DMARC.
        assert.deepStrictEqual(extractXmlBuffers(zlib.gzipSync(Buffer.from('{"organization-name":"x"}'))), []);
        // The plain-text body of the mail.
        assert.deepStrictEqual(extractXmlBuffers(Buffer.from("This is an aggregate report for example.com")), []);
        assert.deepStrictEqual(extractXmlBuffers(Buffer.alloc(0)), []);
        assert.deepStrictEqual(extractXmlBuffers(null), []);
    });

    test("survives a corrupt zip instead of throwing", () => {
        const broken = makeZip("report.xml", SAMPLE);
        broken.writeUInt32LE(0xdeadbeef, broken.length - 22);   // clobber the EOCD signature
        assert.deepStrictEqual(extractXmlBuffers(broken), []);
    });
});
