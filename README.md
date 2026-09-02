<div align="center" width="100%">
    <img src="./public/icon.svg" width="128" alt="Uptime Kuma Logo" />
</div>

# Uptime Kuma — multi-account mail and failover build

A build of [Uptime Kuma](https://github.com/louislam/uptime-kuma) for running one
instance that several people share, with monitor types for the things a
self-hosted mail server and an HA firewall pair actually fail at.

Two features are the point of it:

**Accounts.** Stock Uptime Kuma is a single-account application. This one lets
several people share an instance and see nothing of each other's — monitors,
history, status pages, tags, notifications and the rest all belong to whoever
made them. Administrators run the instance; they do not get everybody's data.
See [Accounts](#accounts).

**Importing an existing instance.** Point it at another Uptime Kuma's database —
a MySQL server, or a SQLite file uploaded through the browser — pick an account,
and everything it owns is copied into a new account here, history included. The
password comes with it, so the person signs in exactly as they did before. See
[Importing an account](#importing-an-account-from-another-uptime-kuma).

Then four monitor types upstream does not have:

| Monitor | Answers |
|---|---|
| **DMARC** | Is my mail authenticating, and is anyone spoofing my domains? |
| **SMTP TLS reporting** | Can senders negotiate TLS to my MX? |
| **Blocklist (RBL)** | Are my sending addresses on a DNSBL? |
| **CARP failover** | Is my HA pair still on the node it should be? |

And two of those monitors **say what happened rather than up or down** — see
[Status names](#status-names).

Everything else works exactly as upstream Uptime Kuma, which is where to look
for anything not described here.

## Accounts

Stock Uptime Kuma is a single-account application. This build lets several
people share one instance without seeing each other's monitoring.

**Everything is isolated.** Monitors, heartbeat history, status pages, tags,
notifications, maintenance windows, proxies, Docker hosts, remote browsers and
API keys all belong to the account that made them. Nobody sees, edits or deletes
anybody else's — administrators included. Being an administrator means running
the instance, not reading everyone's data.

**Two roles.** Whoever sets the instance up is the administrator. An
administrator can change the instance's settings and manage accounts, and can
make other accounts administrators too. Everyone else changes only their own
settings.

**Managing accounts** is under Settings → Users, which only administrators see.
From there you can add an account, rename it, promote it, stop it logging in
without touching its data, reset its password, or delete it.

**The instance can never be left without an administrator.** The last active one
cannot be demoted, deactivated or deleted, and a deactivated administrator does
not count — they cannot log in, so they cannot administer anything. You also
cannot remove your own access; ask another administrator.

**Deleting an account deletes everything it owns**, including every monitor and
all of its history. There is no undo and no backup is taken, so the dialog lists
what is about to go and asks for the account's username to be typed back.

**Disabling authentication is refused once a second account exists.** Uptime
Kuma's `disableAuth` logs everybody in as the first account, which on a shared
instance would hand every visitor the administrator's session.

### Which settings are whose

| Setting | Whose |
|---|---|
| Certificate expiry warning days | each account's own |
| Steam API key, Globalping token | each account's own, falling back to one the administrator provides |
| Search engine visibility | each account's own, applied per status page |
| History retention | each account's own, capped by an administrator's maximum |
| Landing page after logging in | each account's own |
| Server timezone, base URL, entry page, reverse proxy, DNS cache, Chrome path | the administrator's |

The **entry page** and the **landing page** are different things: the entry page
is where the public root URL sends an anonymous visitor, and is instance-wide;
the landing page is where you personally arrive after logging in.

**Chrome's path stays with the administrator** on purpose. Whoever can set it
can make the server execute an arbitrary file, which is not a per-account
preference.

**History retention has a cap** because it is a claim on a shared database: one
account asking to keep ten years grows the file for everybody. Accounts choose
freely below the administrator's maximum.

**Status page slugs are one namespace**, because `/status/<slug>` is one URL.
Two accounts cannot both have `status`; the second is told so without being told
who holds it.

### Upgrading a single-account instance

Nothing to do. The existing account becomes the administrator and keeps
everything it owns, including settings that are now per-account — those carry
their configured values over. Add accounts when you want them.

## Importing an account from another Uptime Kuma

Moving somebody onto this instance does not mean rebuilding their monitors by
hand. Settings → Users → **Import from another Uptime Kuma** reads another
instance's database and copies one account's data into a new account here.

**The source can be either database Uptime Kuma supports.**

- **A SQLite file** you upload — usually `data/kuma.db`. Take the copy while the
  other instance is stopped, or use a backup: a database copied from underneath
  a running server can be mid-write. It is only ever read, never written to.
- **A MySQL or MariaDB server**, given host, database and credentials. Also only
  ever read, so a read-only database user is enough and is the safer thing to
  give it.

**Check the source first.** The dialog opens the database, confirms it really is
an Uptime Kuma one, and lists the accounts it found with how many monitors each
has. A stock instance has exactly one and it is chosen for you; another instance
of this build may have several, and picking the wrong one would import somebody
else's monitoring. An account with no monitors at all is still importable — the
check reports what it found rather than refusing.

**Then it shows what will come across** before anything is written: monitors,
heartbeats, tags, notifications, status pages, maintenance windows, proxies,
Docker hosts, remote browsers and API keys.

**Everything the account owns comes across**, including the full heartbeat
history, the monitor groups and which monitors are on which status page.

**So do the password and the two-factor secret**, which is the point — the
person signs in with the password they already had and their existing
authenticator keeps working. You never have to set one and tell them.

**Two things deliberately do not come across.** The other instance's own
settings, because they describe that server rather than the account — its
reverse proxy configuration, base URL and DNS cache are none of this instance's
business, and this is true even when the imported account is made an
administrator. And the role: an administrator there arrives as a regular account
here unless you tick the box.

The username is taken from the source and can be changed, which is what to do
when that name is already in use here.

**If an import fails it leaves nothing behind.** There is no transaction around
it — a heartbeat table with millions of rows is not something to hold one open
for — so a failure deletes the part-created account instead, which takes
everything the import had written with it.

## DMARC

Receivers such as Google and Microsoft send a daily XML report describing which
sources sent mail as your domain and whether it authenticated. This turns that
stream into monitoring.

- **Reads the mailbox over IMAP, read-only.** Nothing is flagged, moved or
  deleted; position is tracked with a UID cursor, so the mailbox stays usable by
  other clients and ingestion can be restarted at any time.
- **Handles the real-world formats** — zip, gzip and bare XML attachments,
  identified by content rather than by the frequently-wrong `Content-Type`.
- **One monitor per domain, and nothing else.** Each monitor watches a single
  domain and reads the mailbox itself, keeping only the reports for its own
  domain. There is deliberately no separate "mailbox monitor" doing the work on
  everyone's behalf, so every entry in your monitor list is a domain you care
  about rather than plumbing. The cost is one IMAP fetch per domain per check,
  which is why the interval should be an hour or more.
- **Automatic deployment.** Leave the domain blank and the monitor adopts the
  first one it finds, so creating a monitor never leaves a spare behind. With
  autodeploy enabled it also creates a monitor for every other domain in the
  mailbox, copying the same IMAP settings and inheriting the notification
  channels, and keeps doing so as new domains appear.
- **A report page** with a pass/fail timeline, a per-source breakdown showing
  aligned SPF and DKIM, and the reports themselves.

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

That status is what the monitor shows and what it says when it notifies: a
message reads `[example.com] [🔴 Mail loss] 12 messages rejected`, not
`[example.com] [🔴 Down]`. Uptime Kuma's own up/down is still set
underneath, so uptime percentages, statistics and status pages keep working.

Every status change is notified, including one problem status becoming another —
a transition Uptime Kuma treats as down-to-down and would otherwise ignore. The
amber statuses notify as well, which Uptime Kuma never does on its own: the
monitor sends those itself rather than leaving the domain quietly degraded.

`ingest-error` is the one exception. A mailbox that cannot be read is a fact
about the mail server rather than about the domain's authentication, and the
mail server will have a monitor of its own, so this one goes amber and stays
quiet — in both directions, so the recovery is not announced either.

### Setting up DMARC

**1. A mailbox.** Create one mailbox to receive reports, then add a `dmarc@`
alias on each domain pointing at it.

**2. DNS, per domain:**

```
_dmarc.example.com.  IN TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com; fo=1"
```

Use a `rua` address **on the same domain** as the record. A cross-domain
destination requires the receiving domain to publish an authorisation record
(RFC 7489 §7.1), and Google and Microsoft both enforce it — reports are silently
dropped without it. Per-domain aliases avoid the problem entirely.

Start at `p=none`, and move to `quarantine` then `reject` once the reports look
clean.

**Saving a monitor rescans the mailbox.** Editing clears the position it was
resuming from, so the next check re-reads from the configured backfill date.
That is how widening the backfill window takes effect, and how a domain added
since the last run gets picked up. Re-reading is safe: reports de-duplicate.

**3. The monitor.** Add a monitor of type **DMARC** and enter the IMAP details.
Leave the domain blank: the monitor adopts the first domain it finds, so you do
not end up with a spare. Enable autodeploy to have it create monitors for the
other domains in the mailbox too. Set the check interval to an hour or more — reports arrive roughly daily, so polling faster only burdens the
mail server — and set retries to 0, since retrying an IMAP fetch recovers
nothing.

## SMTP TLS reporting

TLS reports (RFC 8460) arrive **in the same mailbox as your DMARC reports**, as
gzipped JSON rather than XML, so no extra mailbox or monitor is needed — the same
per-domain monitor evaluates both. Where DMARC says whether mail authenticated,
these say whether senders could negotiate TLS to your MX at all, which is how you
find out about an expired MX certificate, a broken MTA-STS policy, or senders
being downgraded to plaintext.

Publish a `_smtp._tls.<domain>` TXT record pointing `rua` at the same mailbox:

```
_smtp._tls.example.com.  IN TXT  "v=TLSRPTv1; rua=mailto:dmarc@example.com"
```

Failures that mean somebody has to change a configuration — `certificate-expired`,
`certificate-host-mismatch`, `sts-policy-invalid` and friends — raise
`cert-problem` rather than being averaged into a failure rate.

## Blocklist (RBL)

Checks your sending addresses against DNSBLs. Getting listed is the quiet
catastrophe of self-hosted mail: delivery degrades and you find out when someone
mentions an email never arrived.

Targets may be addresses or hostnames; a hostname is resolved and every address
behind it is checked. The message names exactly what is wrong —
`203.0.113.10 listed on Spamhaus ZEN (127.0.0.2)`.

**Two things worth knowing.** Only three lists are enabled by default —
Spamhaus ZEN, SpamCop and PSBL. SORBS was retired, CBL folded into the Spamhaus
XBL that ZEN already covers, and Barracuda only answers resolvers registered with
it; all three reply NXDOMAIN for every address, which is indistinguishable from
"not listed", so enabling them would make the monitor quietly report clean. They
are still offered, with a note explaining why.

And **leave the resolver blank** unless you run your own. Spamhaus and others
refuse queries from public resolvers like 1.1.1.1 and answer with a rejection
code instead of a verdict, which is the least obvious possible way to break this.

## CARP failover

Watches an HA pair — OPNsense and anything else exposing the same API — and
catches the failure that hides in plain sight: the pair flips to the backup and
stays there, so the redundancy is silently gone.

Configure the **floating IP**, the **master's own address**, and the **backup
addresses**. Then:

| Situation | Reports |
|---|---|
| The master holds the floating IP, and a backup is standing by | 🟢 **MASTER** |
| The master holds it, but no other node is left | 🟡 **MASTER ONLY** |
| A backup holds it | 🟡 **BACKUP** |
| Which node holds it cannot be confirmed | 🟡 **BACKUP** |
| Nobody holds it | 🔴 **DOWN** |
| Two nodes both claim it | 🔴 **DOWN** |
| The floating IP is not responding | 🔴 **DOWN** |

The monitor reports one of four verdicts — **MASTER**, **MASTER ONLY**,
**BACKUP** or **DOWN**. That verdict is what appears on the dashboard and in
notifications, in place of Up/Pending/Down. Why it reached the verdict stays in
the message, so a split brain and an unreachable pair both read DOWN but say
different things.

**MASTER ONLY is the one nothing else would tell you about.** The address is
exactly where it should be and every other check passes — and the node that
would have taken over is not answering, so the redundancy is already gone and
the next fault takes the service down. Green would be a lie; it is amber.

Both amber verdicts still notify. Uptime Kuma never notifies on an amber monitor,
and a silent failover and a silently dead backup are the exact things this
monitor exists to catch — so it sends those notifications itself. The monitor
stays amber while it does: the pair is still carrying traffic, uptime is not
dented, and the alert reads `🟡 BACKUP` rather than a red one.

**How it knows.** Not from reachability — in a healthy pair every node is up and
the floating address answers whichever one holds it. Each node's API is asked
directly for its own CARP role. Split brain is only visible because every node is
queried in the same check: a node reports only its own VIPs, so from any single
node a split pair looks perfectly healthy.

**The API is optional.** Leave the credentials blank and the monitor falls back
to probing reachability. It still catches the floating address going down, still
reports a failover when the master stops answering (a node that does not respond
cannot be holding the address), and still reports MASTER ONLY when the backups
stop answering. What it cannot see is a failover where the master is still
running but demoted, nor split brain at all. Messages from the fallback say they
are inferred.

With the API, MASTER ONLY is sharper: a node that answers but reports INIT
rather than BACKUP cannot take the address either, and is reported the same way.

**Reachability is tested by ping.** If the hosts drop ICMP - a firewall often
does, OPNsense among them - set the probe port to a TCP port instead, such as 443
for the web GUI. A TCP connect passes through where ping does not, and a refused
connection still counts as alive since it proves something answered.

**If you reach the nodes by IP, enable "Ignore TLS errors".** A firewall's
certificate has no IP in its subject alternative names, so verification can never
succeed and every check fails on the certificate instead of reporting CARP.

**The master and backup addresses must be the nodes' own addresses, not the
floating IP.** Pointing them at the VIP queries whichever node currently holds
it, which always answers MASTER — the monitor would look permanently healthy and
never report a failover.

A node that cannot be reached is reported as BACKUP, never as a failover with a
named holder: claiming one because an API call failed would send you to the wrong
node.

## Status names

The DMARC and CARP monitors answer a different question than "is it up", so they
report their own states rather than Up, Down and Pending.

| Monitor | Says |
|---|---|
| **DMARC** | `OK`, `Mail loss`, `Spoofing`, `Degraded`, `Stale`, `No data`, `TLS failure`, `Certificate problem`, `Ingest error` |
| **CARP** | `MASTER`, `MASTER ONLY`, `BACKUP`, `DOWN` |

That name is used everywhere the status appears: the big pill on the monitor
page, the event tables, the hover on the heartbeat bar, and the notifications.
An alert reads

```
[example.com] [🔴 Mail loss] 12 messages rejected
```

rather than `[🔴 Down]`, which for these monitors says almost nothing.

Uptime Kuma's own numeric status is still set underneath, so statistics, status
pages and the heartbeat bar all keep working, and every other monitor type reads
exactly as it always did. The amber states are the one exception: they count as
neither up nor down, so a degraded pair that is still carrying traffic does not
report an outage it never had.

Every status change notifies, including one problem becoming a different problem
— spoofing turning into mail loss — which Uptime Kuma would otherwise treat as
down-to-down and ignore.

## Tests

```bash
npm run test-added-both       # the whole suite on SQLite, then on MariaDB
npm run test-added            # SQLite only
npm run test-added-mariadb    # MariaDB only
```

`test-added-both` is the one to run. Kuma supports both databases and they
differ in ways that only show up when you actually run against them, so the
suite covers parsers, storage, rules, statuses, blocklist lookups, CARP
evaluation, account isolation and the upgrade path on each.

It starts a throwaway MariaDB in RAM from `~/mariadb-portable`, reuses one
already listening if there is one, and warns rather than fails where no portable
server is installed. The MariaDB-only files are skipped unless `TEST_MYSQL`
is set, so a plain `npm run test-added` needs no database. Test databases are
created in tmpfs.

## Deploying

A built image is published on every push to `master`:

```bash
docker pull ghcr.io/luisgs231/uptime-kuma:latest
docker run -d --restart=unless-stopped -p 3001:3001 \
  -v uptime-kuma-data:/app/data --name uptime-kuma ghcr.io/luisgs231/uptime-kuma:latest
```

Built for `linux/amd64` and `linux/arm64`. **`:latest` is the only tag**, and it
is the only image kept — each release replaces the one before it, so there is
never a version to pick and the registry never accumulates. Pin a deployment by
digest if you need one to stay put.

To build it yourself instead, all the options stock Uptime Kuma offers are
available.

### Replacing a stock Uptime Kuma

Same database, same volume, same port — only the image changes. The schema
changes are additive and the migrations run at startup, so monitors,
heartbeats, users, notifications and settings all carry over untouched.

**Back up first, and keep the backup.** Once this build has run against a
database, stock Uptime Kuma will not start against it again: knex refuses to
start when a migration it recorded is missing from the directory. Going back
means restoring that backup, so take one you are willing to rely on.

Under Docker Compose, change the `image:` line to
`ghcr.io/luisgs231/uptime-kuma:latest` and run `docker compose up -d`. Leave the
volume mapping alone.

Running from source instead: replace the checkout, then

```bash
npm ci --omit=dev && npm run build
```

and restart the service. `DATA_DIR` keeps pointing at the same directory.

### Building the image yourself

```bash
npm ci --omit=dev
npm run build
docker build -f docker/dockerfile --target release -t uptime-kuma:local .
docker run -d --restart=unless-stopped -p 3001:3001 \
  -v uptime-kuma-data:/app/data --name uptime-kuma uptime-kuma:local
```

`npm run build` must come first — the Dockerfile copies an already-built
`dist/` rather than building it in the image. A compose file is at
[docker/docker-compose-local.yml](./docker/docker-compose-local.yml).

### Node.js from source

```bash
npm ci --omit=dev
npm run build
node server/server.js
```

Honours the same environment as upstream: `DATA_DIR`, `UPTIME_KUMA_PORT`,
`UPTIME_KUMA_HOST`. Under PM2:

```bash
pm2 start server/server.js --name uptime-kuma
```

### Upgrading an existing instance

The schema changes are additive, so an existing database upgrades in place:
deploy the code and restart, and the migrations run at startup. Monitors,
heartbeats, users and settings are untouched. A test covers this — it fills a
stock database with data, upgrades it, and asserts every row survived.

**Take a backup first, and keep it.** Once this build has run against a database,
stock Uptime Kuma will not start against it again: knex refuses to run when a
recorded migration is missing from the directory. The backup is the way back.

## Other differences from upstream

- The password strength requirement is removed from account setup and password
  changes. It is a deliberate weakening and it applies to anything built from
  this branch.
- Upstream's contribution policy file is not carried here. It governs pull
  requests to upstream, which this repository does not make.

## Keeping up with upstream

This is a standalone repository. The GitHub fork relationship to upstream was
removed deliberately, so a pull request cannot be opened against them by
accident. Upstream updates still work, since `upstream` is just a git remote:

```bash
git fetch upstream && git merge upstream/master
```

[MAINTENANCE.md](./MAINTENANCE.md) lists every upstream file this repository
modifies and by how many lines, and the decisions that look odd but are
load-bearing.
