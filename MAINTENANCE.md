# Maintaining this build

What the README does not cover: the things that would cost time to rediscover
when changing this code. Everything else is in the README.

This build adds shared accounts, passkey sign-in, importing an account from
another Uptime Kuma, and four monitor types. It started as a fork and is not one
any more: the source is edited wherever a change belongs, and upstream is not a
consideration.

## Verifying a change

```bash
npm run test-both
```

**Both databases, every time.** They differ in ways that only appear when you
run against them: `key` and `group` are reserved words in MySQL and this uses
both, `boolean` becomes TINYINT so a flag comes back as 0/1, and compound unique
indexes have a length limit SQLite does not have.

`extra/test-both-engines.mjs` runs the suite twice — SQLite, then a throwaway
MariaDB in `/dev/shm` from `~/mariadb-portable`. It reuses a server already on
port 3399, cleans up the one it starts, and warns rather than fails where no
portable MariaDB is installed. Each MariaDB test file uses **its own database**:
they all rebuild the schema from nothing and `node --test` runs files in
parallel, so sharing one makes them drop each other's tables.

`extra/run-tests.mjs` picks the files. Everything under `test/backend-test` runs
except the files that start a Docker service container, which it spots by their
`testcontainers` import rather than by a list — so a new one is skipped the day
it is written. One suite covers this code and the code it was built on, which is
how a missing translation key went unnoticed for as long as it did.

`test-domain.js` is the one file excluded by name. It asserts that a real
domain's real expiry date, fetched over RDAP, equals a date written into the
test. It passes on its own and fails under the load of the full run, and no
change here can make somebody else's registry deterministic. Do not try to fix
it by widening the timeout: the failure surfaces as a webhook timing out two
tests later, but the cause is the cached expiry being `Invalid Date`.
`check-translations.test.js` also reaches the network and is **not** excluded —
its one external test is wrapped in `retryExternalService`, which logs and
returns instead of failing, so it can never redden the run. `npm run
test-backend` runs everything, and needs Docker and a connection.

If you touched `src/util.ts` or `src/monitor-status.ts`, run `npm run tsc` and
commit the compiled `.js` too — the backend reads that, so an uncompiled change
works on the dashboard and silently does not in notifications. The frontend
imports the `.ts` by extension and the backend `require`s the emitted `.js`;
that split is what the pair is for. It reports pre-existing `@types/node` errors
the pinned TypeScript cannot parse; it still emits, so check `git status` rather
than the exit code.

Not covered by tests: the Vue pages rendering, and the create-account and
delete-account dialogs (their rules are tested, the dialogs have only been
rendered). A real IMAP fetch is not automated either, but it has been verified
by hand against a live mailbox.

Passkeys are covered end to end: `test-passkey-roundtrip.js` carries a software
authenticator that generates a P-256 key pair and signs the ceremony exactly as
a phone does, so the library's own verification runs for real - a forged
signature and a replayed assertion are both asserted to fail. What is not
covered is the browser half, which only the build exercises.

## Load-bearing oddities

Things that look wrong and are not. Reverting one will break something quietly.

**The `[Label] ` prefix on `heartbeat.msg`.** It is how a monitor type carries
its own status. redbean runs frozen (`R.freeze(true)`), so a property with no
column fails the INSERT — the DMARC monitor has `heartbeat.dmarc_status`, CARP
has nothing and uses the prefix. The dashboard, the toast and the notification
all read it back. A new heartbeat column needs a migration.

**`disableAuth` is removed and must stay removed.** Upstream's switch auto-logged
every connection in as `R.findOne("user")` - the first row, no ordering, no
`active` filter - and skipped the basic-auth and API-key middleware with it. On a
single-account instance that is a feature; here it hands every visitor the
administrator's session and bypasses `ownership.js` entirely. Deleted rather than
guarded, along with the `autoLogin` token it was the only source of. Anything
reintroducing `disableAuth`, `autoLogin`, or `socket.emit("autoLogin")` is a
regression, not a feature.

**Per-account settings are their own table.** The stock `setting` table is read
with `SELECT value FROM setting WHERE key = ?` and no qualifier, so several
accounts' rows in it would mean reading an arbitrary one. Settings that belong
to a person go in the per-account table; only instance-wide ones go in `setting`.

**`ownership.js` is the only thing that answers "is this yours".** A gap there
is a gap everywhere, which is why it can be tested exhaustively.
`test-handler-guards.js` parses every socket handler taking an id and fails on
any that only calls `checkLogin`. It found four stock handlers returning or
destroying other accounts' data. **If it fails on a handler you added, add a
guard, not an exception.**

**`checkAdmin()` reads the account, not a socket flag**, so demoting somebody
takes effect while they are connected. The client learns its role from a
`currentUser` event rather than the JWT, because a token outlives a role change.

**Deleting an account is an explicit cascade.** `monitor.user_id` and
`maintenance.user_id` are ON DELETE SET NULL, so deleting the row alone leaves
monitors running, owned by nobody. Groups and incidents are deleted by hand —
neither has a foreign key to its status page.

**An import has to start what it copied.** A monitor beats because the running
server holds it in `monitorList`, not because a row says `active = 1` - that
column is only read by `startMonitors()` at boot. So an import that merely
inserts rows looks like it worked and checks nothing until the next restart.
`startImported()` closes that, and `test-import.js` asserts the handler calls it,
because the helper being correct is not the part that regressed.

**The importer rewrites every foreign key.** Two databases both start ids at 1.
`server/import/plan.js` names each table, the order, and what it references;
`importer.js` keeps a map per table of what the old ids became. Selecting rows
by source id and inserting them unchanged attaches them to whatever already
holds that id here — which looks like a successful import. **The import tests
seed the destination with an account whose ids collide with the source's**;
without that, two real bugs passed.

**The amber statuses notify, and Kuma is not what sends them.** Kuma never
notifies on PENDING, and mapping amber to DOWN to force it would make a pair that
is still carrying traffic read as an outage and dent its uptime. So `notify.js`
sends those itself, on any change of the monitor's own status, and skips
whenever Kuma is about to report the same transition - `kumaWillNotify` is what
stops one event arriving twice. The notification icon comes from the status
colour, not from the numeric status, or an amber verdict would arrive with a red
circle in front of it. The heartbeat bar, the ping chart's shaded band and the
uptime pill read it the same way, so a beat recorded before a status changed
colour is drawn the way that status reads now rather than the way it read then.

Amber also has to stay out of the uptime maths. Upstream's `flatStatus()` folds
PENDING into DOWN, which put a pair that never stopped carrying traffic at 0%.
`UptimeCalculator.neutralPending` makes a PENDING beat count as neither, the way
a maintenance beat already does, and `monitor.js` sets it from
`hasStatusVocabulary(type)` so no other monitor type changes behaviour.

`dmarcStatus.SILENT` is the other way round: `ingest-error` notifies for
nothing, in either direction. An unreachable mailbox is the mail server's
outage, not the domain's, and it already has a monitor. Kuma is quiet by itself
here - UP to PENDING and PENDING to UP are both "not important" upstream - so
only this build's own status-change notification had to be stopped.

**A passkey ceremony is spent, not merely expired.** The challenge lives in
`webauthn_session` and `takeCeremony()` deletes the row as it reads it. A signed
token would have been simpler and wrong: a challenge exists to be used exactly
once, and a token cannot be spent - it stays valid until it expires, which turns
"once" into "as often as you like for the next five minutes". Replaying a
captured assertion is the attack the challenge is there to stop.

**The credential is one opaque column.** Its shape is the library's rather than
ours, and it has grown in the library's own history; a column per field would
make each growth a migration here plus a mapping that could quietly drop one.
Nothing queries by any of it. On MySQL it is MEDIUMTEXT, because plain TEXT caps
at 64 KB and a truncated record is a passkey that enrolled successfully and can
never sign anybody in again.

**`passkey.credential_id` is unique across the instance, not per account.**
Signing in looks an assertion up by it with no account named at all - that is
what makes signing in without a username possible - so two accounts cannot both
hold one.

**The WebAuthn user handle is the row id, never the username.** A handle is
written into the authenticator and shown in the phone's own passkey list, so an
account being renamed would leave it stale there forever. It also has to be
stable: change it and every enrolled key stops matching its account.

**A monitor's config is one JSON column**, so a new setting needs no migration
to the shared `monitor` table.

**Each monitor type is one file.** `monitor-types/carp.js` and
`monitor-types/rbl.js` carry their own status vocabulary and parsing rather than
a module beside them: the vocabulary is only ever read by the monitor that
reports it. DMARC keeps `server/dmarc/` because the mailbox reader, the report
parser, the store and the rules genuinely are separate concerns with more than
one reader between them.

**`$primary` stays a real colour; `$accent` is the one to paint with.** Bootstrap
5.1 has no per-component custom properties and does colour maths on `$primary`
(`darken()`, `color-contrast()`), which a `var()` cannot survive - so it keeps a
concrete green and everything of ours reads `$accent`, which is
`var(--accent, #{$primary})`. The handful of Bootstrap classes that still show
the accent are restated in `app.scss` against the same variable. A new rule that
paints with the accent must use `$accent`; `test-accent-colour.js` fails on a
file that goes back to `$primary`.

**The accent reaches the up state, warm colours included.** `.bg-primary` and
`--bs-primary` follow it, so a healthy monitor is drawn in whatever its owner
chose - and the palette deliberately includes red, orange and amber, which are
close to the colours used for failure and maintenance. That is the owner's
choice to make. What the tests do guard is spread: no two accents within ten
degrees of hue, because the palette started out as green, mint and cyan, which
read as one colour in a row of swatches.

**The heartbeat bar is the one thing a CSS variable cannot repaint.** It draws to
a canvas and caches its colours per draw, so it needs an explicit watcher on
`$root.accentColor` - without it the bars keep their old colour until something
else forces a redraw, which is what made an accent change look like it needed a
page reload.

**A checked radio in a btn-group is styled through `.btn-check:checked +`,** not
`.active`, so it needs naming separately in the accent overrides. Every toggle on
the Appearance page is one of these, which is why the selected option was the
last thing still showing the old green.

**The logo and the favicon are rebuilt in the browser.** `public/icon.svg` is a
two-stop gradient in the brand green; `iconDataUrl()` swaps both stops and hands
back a data URI, which the favicon link and the `<object>` logos use. Nothing is
written to disk - it is per account, and two people signed in to the same
instance see different tab icons. `apple-touch-icon.png` and the other PNGs are
not recoloured; they are raster and stay green.

**The accent is set on `documentElement`, not `body`.** The theme classes live
on `body`, but a custom property has to be visible to everything including
portalled dialogs, and the fallback in `var(--accent, …)` is what keeps a
signed-out page - a public status page - green rather than unstyled.

**Most UI strings are hardcoded English.** `src/lang/en.json` is this build's to
change, and new work that needs a key adds one. The hardcoded text predates
that and is not a rule to follow - it is just not worth a sweep of its own.

**Form markup lives in components**, so `EditMonitor.vue` gains one tag rather
than hundreds of lines.

**`MonitorList.vue` measures its list header** instead of subtracting a constant.
The filter row wraps on a narrow screen, and the hardcoded value put the list
under the mobile navigation bar.

## Schema

Additive. New tables for the monitor data and per-account settings, a role on
`user`, owner columns on `tag` and `status_page`, config columns on `monitor`
and one status column on `heartbeat`. An existing instance upgrades in place:
the existing account becomes the administrator and keeps everything it owns.
There is no way back other than a backup.
