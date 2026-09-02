# Maintaining this build

What the README does not cover: the things that would cost time to rediscover
when merging upstream or changing this code. Everything else is in the README.

This build adds shared accounts, importing an account from another Uptime Kuma,
and four monitor types. It is meant to keep merging with upstream indefinitely,
so nearly everything lives in new files.

## Verifying after a merge

```bash
npm run test-added-both
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

If the merge touched `src/monitor-status.ts`, run `npm run tsc` and commit the
compiled `.js` too — the backend reads that, so an uncompiled change works on
the dashboard and silently does not in notifications. It reports pre-existing
`@types/node` errors the pinned TypeScript cannot parse; it still emits, so
check `git status` rather than the exit code.

Not covered by tests: a real IMAP fetch, the Vue pages rendering, and the
create-account and delete-account dialogs (their rules are tested, the dialogs
have only been rendered).

## Load-bearing oddities

Things that look wrong and are not. Reverting one will break something quietly.

**The `[Label] ` prefix on `heartbeat.msg`.** It is how a monitor type carries
its own status. redbean runs frozen (`R.freeze(true)`), so a property with no
column fails the INSERT — the DMARC monitor has `heartbeat.dmarc_status`, CARP
has nothing and uses the prefix. The dashboard, the toast and the notification
all read it back. A new heartbeat column needs a migration.

**Per-account settings are their own table.** Upstream reads `setting` with
`SELECT value FROM setting WHERE key = ?` and no qualifier, so several accounts'
rows in it would make upstream code read an arbitrary one — and every merge
brings more code that reads it that way.

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

**A monitor's config is one JSON column**, so a new setting needs no migration
to the shared `monitor` table, which upstream changes often.

**UI strings are hardcoded English, not i18n keys.** `src/lang/en.json` changes
in almost every upstream release; adding keys would conflict constantly.

**Form markup lives in components**, so `EditMonitor.vue` gains one tag rather
than hundreds of lines.

**`MonitorList.vue` measures its list header** instead of subtracting a constant.
The filter row wraps on a narrow screen, and the hardcoded value put the list
under the mobile navigation bar.

## The conflict surface

Everything else is new files, which cannot conflict. Only these upstream files
are modified, by the number of lines shown:

| File | Lines | What was added |
|---|---|---|
| `server/server.js` | 101 / -23 | socket handlers, config columns, password rule, ownership guards, the settings split |
| `server/jobs/clear-old-data.js` | 80 / -31 | retention per owner, bounded by the admin ceiling |
| `src/mixins/socket.js` | 53 / -3 | `statusList`, the toast, `currentUser`, the landing page |
| `src/components/Status.vue` | 48 / -2 | optional `type` and `beat` props |
| `server/model/monitor.js` | 64 / -7 | the config columns in `toJSON` with secrets gated, `notificationText()` |
| `src/components/settings/General.vue` | 46 / -5 | system fields gated by role, the landing page |
| `src/components/Tooltip.vue` | 44 / -1 | the heartbeat hover uses a monitor's own status |
| `server/socket-handlers/status-page-socket-handler.js` | 40 / -44 | ownership on every logged-in handler, slug collisions |
| `src/components/settings/MonitorHistory.vue` | 32 | the retention ceiling |
| `src/pages/EditMonitor.vue` | 31 | three `<option>`s in their own optgroup + form components |
| `src/components/MonitorList.vue` | 29 / -17 | the list header is measured |
| `src/pages/Details.vue` | 28 / -3 | summary components, the status pill, the event table |
| `src/components/PingChart.vue` | 23 / -9 | the shaded band matches the bar above it |
| `server/client.js` | 21 | `sendCurrentUser()` |
| `server/util-server.js` | 21 / -1 | `checkAdmin()`, cert expiry read per owner |
| `src/pages/DashboardHome.vue` | 19 / -2 | the event table shows a monitor's own status |
| `src/pages/Settings.vue` | 19 / -4 | the Users pane, the menu gated by role |
| `server/socket-handlers/maintenance-socket-handler.js` | 16 / -1 | ownership on six handlers that had none |
| `src/router.js` | 10 | the `/settings/users` and `/dashboard/:id/dmarc` routes |
| `server/uptime-calculator.js` | 11 | `neutralPending`, so amber is neither up nor down |
| `src/components/HeartbeatBar.vue` | 51 | the bar is coloured by the beat's own status |
| `server/uptime-kuma-server.js` | 6 | requires + monitorTypeList entries |
| `package.json` | 6 | dependencies + the test scripts |
| `server/monitor-types/steam.js` | 4 / -4 | the API key comes from the monitor's owner |
| `server/socket-handlers/chart-socket-handler.js` | 3 | ownership on `getMonitorChartData` |
| `server/monitor-types/globalping.js` | 3 / -2 | the same, for the Globalping token |
| `server/model/heartbeat.js` | 2 | `dmarcStatus` in both `toJSON` variants |
| `server/socket-handlers/api-key-socket-handler.js` | 2 / -2 | `user_id` on the enable/disable updates |
| `src/components/Uptime.vue` | 7 | the pill takes its colour from the verdict |
| `src/icon.js` | 2 | registers the chart icon |
| `server/model/status_page.js` | 1 / -1 | the page list is the account's own |
| `tsconfig-backend.json` | 1 / -1 | compiles `src/monitor-status.ts` |
| `.eslintrc.js` | 1 / -1 | ignores the compiled `src/monitor-status.js` |
| upstream's governance and `.github` process files | deleted | contribution policy, issue and PR templates, funding, dependabot, and the workflows for upstream's own releases |

The account work reaches into handlers all over the tree, which is the opposite
of how the rest of this build is arranged. Isolation is only worth anything if
it is everywhere.

A conflict in `EditMonitor.vue`, `Details.vue`, `Status.vue`, `socket.js` or
`DashboardHome.vue` almost always resolves as "keep both sides": the additions
are new branches taken only when a monitor reports its own status, so upstream's
own paths are untouched. Merges that touch a deleted path report a
delete/modify conflict; `git rm <path>` resolves it.

The password strength requirement was removed from setup and password change.
That is a deliberate weakening and it applies to any deployment built from this
branch — put it behind an environment variable if you ever want it back for
production only.

## Merging upstream

```bash
git fetch upstream && git merge upstream/master
```

Upstream's full history is kept as this branch's ancestry, which is what makes
that a normal merge rather than a conflict in every file. The single commit on
top is the whole of this build.

## Schema

Additive. New tables for the monitor data and per-account settings, a role on
`user`, owner columns on `tag` and `status_page`, config columns on `monitor`
and one status column on `heartbeat`. An existing instance upgrades in place:
the existing account becomes the administrator and keeps everything it owns.
There is no way back other than a backup.
