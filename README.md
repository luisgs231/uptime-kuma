<div align="center" width="100%">
    <img src="./public/icon.svg" width="128" alt="Uptime Kuma Logo" />
</div>

# Uptime Kuma — multi-account mail and failover build

A build of Uptime Kuma for one instance several people share, with monitor types
for what a self-hosted mail server and an HA firewall pair actually fail at.

| | |
|---|---|
| **[Accounts](#accounts)** | Several people share an instance and see nothing of each other's. Administrators run the instance; they do not get everybody's data. |
| **[Passkeys](#passkeys)** | Sign in with the device — fingerprint, face, PIN or hardware key — without typing a username. |
| **[Import](#importing-an-account)** | Copy an account out of another Uptime Kuma's database, history and password included. |
| **[Accent colour](#accent-colour)** | One per account, following the person to any browser. |

Four monitor types upstream does not have:

| Monitor | Answers |
|---|---|
| **[DMARC](#dmarc)** | Is my mail authenticating, and is anyone spoofing my domains? |
| **[CARP failover](#carp-failover)** | Is my HA pair still on the node it should be? |
| **[Blocklist (RBL)](#blocklist-rbl)** | Are my sending addresses on a DNSBL? |
| **[SMTP TLS reporting](#smtp-tls-reporting)** | Can senders negotiate TLS to my MX? Rides on the DMARC monitor. |

DMARC and CARP [say what happened rather than up or down](#status-names).

It started as a fork of Uptime Kuma and is not one any more: the source is edited
wherever a change belongs. Anything not described here works as Uptime Kuma does.

## Accounts

Monitors, heartbeat history, status pages, tags, notifications, maintenance
windows, proxies, Docker hosts, remote browsers and API keys belong to the account
that made them. Nobody sees or edits anybody else's — administrators included,
since running the instance is not the same as reading everyone's data.

Whoever sets the instance up is the administrator: they change instance settings,
manage accounts under **Settings → Users**, and can promote others.

- **The instance can never be left without an administrator.** The last active one
  cannot be demoted, deactivated or deleted, and you cannot remove your own access.
- **Deleting an account deletes everything it owns**, history included, with no
  undo and no backup taken.
- **Authentication cannot be turned off** — see
  [Other differences](#other-differences-from-upstream).
- **Upgrading a single-account instance:** nothing to do. The existing account
  becomes the administrator and keeps everything.

### Which settings are whose

| Setting | Whose |
|---|---|
| Certificate expiry warning days | the account's own |
| Steam API key, Globalping token | the account's own, falling back to one the administrator provides |
| Search engine visibility | the account's own, applied per status page |
| History retention | the account's own, capped by an administrator's maximum |
| Landing page after logging in | the account's own |
| Server timezone, base URL, entry page, reverse proxy, DNS cache, Chrome path | the administrator's |

The **entry page** is where the public root URL sends an anonymous visitor and is
instance-wide; the **landing page** is where you arrive after logging in. Chrome's
path stays with the administrator because whoever sets it can make the server
execute an arbitrary file. Status page slugs are one namespace — two accounts
cannot both have `status`, and the second is told it is taken without being told
who holds it.

## Passkeys

**Settings → Security → Passkeys → Add a passkey.** The sign-in page then offers
**Sign in with a passkey** with nothing to type: the authenticator names the
account, so there is no username field first. An account can register as many as
it likes, each listed with when it was added and last used.

**No second factor is asked for**, because a passkey is already two: the key is in
the device, and the device asked who was holding it. Password sign-in and its 2FA
keep working alongside.

**HTTPS, or localhost.** Browsers refuse WebAuthn anywhere else, so the button is
hidden rather than offered and then failing. Passkeys bind to the **Primary Base
URL** if Settings → General has one, otherwise to whatever address the browser
used — which is what makes them unphishable, and also why changing the address
means enrolling again. Opening the dashboard at a different address is refused
with a message saying so.

## Importing an account

**Settings → Users → Import from another Uptime Kuma** copies one account's data
into a new account here. The source is either database Uptime Kuma supports, and
is only ever read:

- **A SQLite file** you upload, usually `data/kuma.db`. Take the copy while the
  other instance is stopped, or use a backup — a database copied from underneath a
  running server can be mid-write.
- **A MySQL or MariaDB server**, given host, database and credentials. A read-only
  user is enough, and is the safer thing to give it.

The dialog lists the accounts with how many monitors each has. A stock instance
has one; another instance of this build may have several, and picking the wrong
one imports somebody else's monitoring.

**Everything the account owns comes across** — monitors, full heartbeat history,
tags, notifications, status pages, maintenance windows, proxies, Docker hosts, API
keys, the monitor groups and which monitors are on which status page — **including
the password and the two-factor secret**, so the person signs in exactly as
before. Monitors that were active are started as the import finishes, without a
restart.

**Two things deliberately do not come across.** The other instance's own settings,
which describe that server rather than the account; and the role — an
administrator there arrives as a regular account unless you tick the box. The
username can be changed, which is what to do when it is already in use here.

**A failed import leaves nothing behind.** There is no transaction around it — a
heartbeat table with millions of rows is not something to hold one open for — so a
failure deletes the part-created account instead.

## Accent colour

**Settings → Appearance → Accent colour.** Ten colours spread around the wheel,
green first and the default. The choice belongs to the account rather than the
browser, so it follows the person wherever they sign in, and applies without a
reload — badges, heartbeat bars, the up state, the logo and the tab icon.

The warm end overlaps the colours Uptime Kuma uses for maintenance and failure, so
picking amber draws a healthy monitor in roughly the colour of a maintenance
window. Left as your choice rather than removed.

## DMARC

Turns the daily aggregate reports receivers send about your domain into
monitoring.

- **Reads the mailbox over IMAP, read-only.** Nothing is flagged, moved or
  deleted; position is a UID cursor, so the mailbox stays usable by other clients.
- **Handles the real-world formats** — zip, gzip and bare XML, identified by
  content rather than by the frequently-wrong `Content-Type`.
- **One monitor per domain, and nothing else.** Each reads the mailbox itself and
  keeps only its own domain's reports; there is deliberately no "mailbox monitor"
  doing the work on everyone's behalf. The cost is one IMAP fetch per domain per
  check, which is why the interval should be an hour or more.
- **Automatic deployment.** Leave the domain blank and the monitor adopts the
  first one it finds. With autodeploy it also creates a monitor for every other
  domain in the mailbox, copying the IMAP settings and inheriting the notification
  channels, and keeps doing so as new domains appear.
- **A report page** with a pass/fail timeline and a per-source breakdown showing
  aligned SPF and DKIM.

### DMARC statuses

"Down" alone does not distinguish mail being rejected from someone spoofing your
domain from reports having stopped arriving, so the monitor reports one of:

| Status | Meaning |
|---|---|
| `ok` | Reports arriving, mail authenticating |
| `no-data` | Nothing received yet; reports usually arrive once a day |
| `degraded` | More failures than expected, but no receiver has acted on it |
| `stale` | Reports stopped arriving — usually a broken `_dmarc` record |
| `spoofing` | A source not seen before is sending mail that fails DMARC |
| `mail-loss` | Receivers are quarantining or rejecting, so mail is being lost |
| `tls-failure` | Senders are failing to establish TLS more often than expected |
| `cert-problem` | An expired certificate, hostname mismatch, or a policy that no longer validates |
| `ingest-error` | The mailbox could not be read — amber, and never notifies |

Every status change notifies, including one problem becoming another, which Uptime
Kuma treats as down-to-down and would otherwise ignore; the amber statuses notify
too, which it never does on its own. `ingest-error` is the exception — an
unreadable mailbox is a fact about the mail server, which has its own monitor.

### Setting up DMARC

**1. A mailbox** to receive reports, with a `dmarc@` alias on each domain pointing
at it.

**2. DNS, per domain:**

```
_dmarc.example.com.  IN TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1"
```

Use a `rua` address **on the same domain** as the record: a cross-domain
destination requires the receiving domain to publish an authorisation record
(RFC 7489 §7.1), and Google and Microsoft both enforce it — reports are silently
dropped without it. Start at `p=none` and move to `quarantine` then `reject` once
the reports look clean.

**3. The monitor.** Type **DMARC**, the IMAP details, domain blank. Interval an
hour or more, and retries 0, since retrying an IMAP fetch recovers nothing.

Saving a monitor rescans the mailbox: editing clears the resume position, so the
next check re-reads from the configured backfill date. That is how a widened
backfill window takes effect, and how a domain added since the last run is picked
up. Re-reading is safe — reports de-duplicate.

### SMTP TLS reporting

TLS reports (RFC 8460) arrive **in the same mailbox as your DMARC reports**, as
gzipped JSON, so the same per-domain monitor evaluates both and no extra mailbox
or monitor is needed. Where DMARC says whether mail authenticated, these say
whether senders could negotiate TLS to your MX at all — an expired MX certificate,
a broken MTA-STS policy, or senders downgraded to plaintext.

```
_smtp._tls.example.com.  IN TXT  "v=TLSRPTv1; rua=mailto:dmarc@example.com"
```

Failures that mean somebody has to change a configuration —
`certificate-expired`, `certificate-host-mismatch`, `sts-policy-invalid` and
friends — raise `cert-problem` rather than being averaged into a failure rate.

## CARP failover

Watches an HA pair — OPNsense and anything else exposing the same API — for the
failure that hides in plain sight: the pair flips to the backup and stays there,
so the redundancy is silently gone.

Configure the **floating IP**, the **master's own address**, and the **backup
addresses**:

| Situation | Reports |
|---|---|
| The master holds the floating IP, and a backup is standing by | 🟢 **MASTER** |
| The master holds it, but no other node is left | 🟡 **MASTER ONLY** |
| A backup holds it, or which node holds it cannot be confirmed | 🟡 **BACKUP** |
| Nobody holds it, two nodes both claim it, or the floating IP is not responding | 🔴 **DOWN** |

Why it reached that verdict stays in the message, so a split brain and an
unreachable pair both read DOWN but say different things.

**MASTER ONLY is the one nothing else would tell you about.** The address is
exactly where it should be and every other check passes — and the node that would
have taken over is not answering, so the redundancy is already gone and the next
fault takes the service down. Green would be a lie; it is amber.

**Both amber verdicts still notify**, which Uptime Kuma never does on its own: a
silent failover and a silently dead backup are the exact things this monitor
exists to catch. It stays amber while it does, so uptime is not dented.

**How it knows.** Not from reachability — in a healthy pair every node is up and
the floating address answers whichever one holds it. Each node's API is asked
directly for its own CARP role, and split brain is only visible because every node
is queried in the same check: a node reports only its own VIPs, so from any single
node a split pair looks perfectly healthy.

**The API is optional.** Without credentials the monitor probes reachability
instead. It still catches the floating address going down, a failover when the
master stops answering, and MASTER ONLY when the backups stop answering; it cannot
see a failover where the master is running but demoted, nor split brain at all,
and says when a message is inferred.

Three things to get right:

- **The master and backup addresses must be the nodes' own, not the floating IP.**
  Pointing them at the VIP queries whichever node currently holds it, which always
  answers MASTER — permanently healthy, never a failover.
- **If the hosts drop ICMP** — a firewall often does, OPNsense among them — set the
  probe port to a TCP port such as 443. A refused connection still counts as alive,
  since it proves something answered.
- **If you reach the nodes by IP, enable "Ignore TLS errors".** A firewall's
  certificate has no IP in its subject alternative names, so every check would fail
  on the certificate instead of reporting CARP.

A node that cannot be reached is reported as BACKUP, never as a failover with a
named holder: claiming one because an API call failed would send you to the wrong
node.

## Blocklist (RBL)

Checks your sending addresses against DNSBLs. Targets may be addresses or
hostnames; a hostname is resolved and every address behind it checked. The message
names exactly what is wrong — `203.0.113.10 listed on Spamhaus ZEN (127.0.0.2)`.

**Only three lists are enabled by default** — Spamhaus ZEN, SpamCop and PSBL.
SORBS was retired, CBL folded into the Spamhaus XBL that ZEN already covers, and
Barracuda only answers resolvers registered with it; all three reply NXDOMAIN for
every address, which is indistinguishable from "not listed", so enabling them
would make the monitor quietly report clean. They are still offered, with a note.

**Leave the resolver blank** unless you run your own. Spamhaus and others refuse
queries from public resolvers like 1.1.1.1 and answer with a rejection code
instead of a verdict, which is the least obvious possible way to break this.

## Status names

DMARC and CARP report their own states rather than Up, Down and Pending. The name
appears everywhere the status does — the pill, the event tables, the heartbeat bar
hover, the notifications — so an alert reads
`[example.com] [🔴 Mail loss] 12 messages rejected` rather than `[🔴 Down]`.

Uptime Kuma's numeric status is still set underneath, so statistics, status pages
and the heartbeat bar keep working and every other monitor type reads exactly as
it always did. The amber states count as neither up nor down, so a degraded pair
still carrying traffic does not report an outage it never had.

## Tests

```bash
npm run test-both       # every test on SQLite, then again on MariaDB
npm run test-sqlite     # SQLite only
npm run test-mariadb    # MariaDB only
```

`test-both` is the one to run — the two databases differ in ways that only show up
when you run against them. It starts a throwaway MariaDB in RAM from
`~/mariadb-portable`, reuses one already listening, and warns rather than fails
where none is installed. Test databases are created in tmpfs.

One suite covers this code and the code it was built on. `extra/run-tests.mjs`
leaves out the files that start a Docker service container, spotted by their
`testcontainers` import rather than by a list, and `test-domain.js`, which asserts
a real domain's real RDAP expiry date. `npm run test-backend` runs everything, and
needs Docker and a connection.

## Deploying

An image is published on every push to `master`, for `linux/amd64` and
`linux/arm64`:

```bash
docker pull ghcr.io/luisgs231/uptime-kuma:latest
docker run -d --restart=unless-stopped -p 3001:3001 \
  -v uptime-kuma-data:/app/data --name uptime-kuma ghcr.io/luisgs231/uptime-kuma:latest
```

**`:latest` is the only tag** and the only image kept — each release replaces the
one before it, so the registry never accumulates. Pin by digest if you need a
deployment to stay put.

### Replacing or upgrading an existing instance

Same database, same volume, same port — only the image changes. The schema changes
are additive and the migrations run at startup, so monitors, heartbeats, users,
notifications and settings all carry over untouched. A test covers this: it fills a
stock database with data, upgrades it, and asserts every row survived.

**Back up first, and keep the backup.** Once this build has run against a database,
stock Uptime Kuma will not start against it again: knex refuses to start when a
migration it recorded is missing from the directory. Restoring that backup is the
only way back.

### Building it yourself

```bash
npm run setup      # npm ci, then builds the frontend into dist/
docker build -f docker/dockerfile --target release -t uptime-kuma:local .
```

The build must come first — the Dockerfile copies an already-built `dist/` rather
than building it in the image, and the frontend needs the dev dependencies, so
this is a full `npm ci` rather than `--omit=dev`. A compose file is at
[docker/docker-compose-local.yml](./docker/docker-compose-local.yml).

To run it under Node instead of Docker, `node server/server.js` (or
`pm2 start server/server.js --name uptime-kuma`) after the same setup. Honours the
same environment as upstream: `DATA_DIR`, `UPTIME_KUMA_PORT`, `UPTIME_KUMA_HOST`.

## Other differences from upstream

- **`disableAuth` is gone.** Upstream offers it for running behind a reverse proxy
  that authenticates for you; it auto-logs everybody in as the first account, skips
  the basic-auth and API-key middleware, and cannot be reconciled with accounts —
  on a shared instance it hands each visitor the administrator's session and
  bypasses every ownership check at once. Put a proxy in front by all means; this
  build still expects its own sign-in behind it.
- **There are no password rules.** The strength requirement is removed from setup,
  account creation and password changes, and an empty password is accepted
  everywhere including at sign-in. Deliberate, and it applies to anything built
  from this branch.
