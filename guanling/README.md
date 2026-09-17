# guanling (關令)

**A task-management MCP server that refuses.**

Most task tools do what you tell them. This one has opinions and enforces them.

---

## Why this exists

A real task list grew to 280 items. Sixteen were marked "in progress". Not one
of them was actually being worked on.

The missing thing was not a tool — there already *was* a list. The missing thing
was anything that **forced a decision**. Every operation said yes, so the list
accumulated intentions and never spent them.

What makes Linear work is not its feature set. It is its refusals: a small fixed
set of states you cannot extend, and limits you cannot argue with. This server
copies the refusals, not the features.

## The gates

Each one is a **refusal**, not a warning.

| Gate | Behaviour |
|---|---|
| `owner` and `next_step` required | `task_add` is **rejected** without both. No owner and no next action means it is a wish, not a task. |
| Five states, hardcoded | `triage · todo · doing · done · dropped`. There is no API to add a sixth. Custom statuses are how a list starts rotting. |
| WIP limit on `doing` | Moving past the limit is **rejected**, and the error **names what currently occupies it** so you have to close something first. |
| External items land in triage | Anything with a `source` starts in `triage`, never straight in `todo`. |
| Closing requires a reason | `done` / `dropped` without `reason` is **rejected**. Why it closed outlives that it closed. |
| Rollover is visible | `cycle_roll` increments a `rolled` counter and returns anything rolled 3+ times as needing a decision. Nothing is dropped silently. |

Refused calls **write nothing to disk** — there is a test for this.

## Install

```bash
npm install -g guanling
```

Then add it to your MCP client config:

```json
{
  "mcpServers": {
    "guanling": {
      "command": "npx",
      "args": ["-y", "guanling"],
      "env": {
        "GUANLING_AGENT": "me",
        "GUANLING_FILE": "/path/to/my-tasks.json"
      }
    }
  }
}
```

| Variable | Default | Meaning |
|---|---|---|
| `GUANLING_AGENT` | `unknown` | Identity for this instance. |
| `GUANLING_FILE` | `$HOME/<agent>/.guanling.json` if that folder exists, else `$HOME/.guanling/<agent>.json` | Path to the JSON store. |
| `GUANLING_WIP` | `6` | Maximum concurrent `doing` items. Leave it unset unless you
  actually want a different cap — pasting the default into your config freezes it there,
  and a later change to the default will never reach you. |

⚠️ **Give every instance its own `GUANLING_FILE`.** Two processes sharing one
file will overwrite each other — see Limitations.

## Tools

| Tool | Purpose |
|---|---|
| `task_add` | Open a task. Rejects without owner + next_step. |
| `task_update` | Change status/owner/next_step. Enforces the WIP limit and the close-reason rule. |
| `task_list` | List open work. `stale_days` surfaces tasks opened and never touched. |
| `task_triage` | Resolve inbox items: accept / decline / duplicate / snooze. |
| `cycle_status` | Days left, WIP usage, stale count, and what has rolled twice or more. |
| `cycle_roll` | Close the cycle, carry unfinished work forward with a visible counter. |

## Storage

One JSON file, written atomically (write to a temp file, then `rename`).

Deliberately **not** a database. The scale is hundreds of rows, and a plain file
stays readable by a human, diffable in git, and backed up by `cp`. The complete
string is built before the file is opened, so an exception mid-serialisation
leaves the previous file intact.

## The background scheduler

The plugin is one install. On first use it starts a small companion process
(`http.mjs`) that runs the daily stall sweep, and leaves it running after the
session exits — a plugin dies with its session, so it cannot host a schedule
itself.

- Binds **`127.0.0.1:4620`** only. Never reachable from the network.
- The port bind *is* the lock: exactly one runs per machine no matter how many
  sessions start at once. Losers exit 0 silently. No pidfile, nothing to clean
  up if it dies.
- Log: `~/.guanling/scheduler.log`. Sweep time: `GUANLING_SWEEP_AT` (default
  `09:30` local). Port: `GUANLING_PORT`.
- **Don't want it?** `GUANLING_NO_SCHEDULER=1`. Everything else still works;
  you just don't get the daily sweep.

## Tests

```bash
node selftest.mjs
```

16 arms, weighted toward the refusals — those are the product. Includes a
negative control asserting that a rejected `task_add` leaves nothing on disk.

The WIP gate is mutation-tested: removing it turns exactly the two arms that
cover it red. A gate that cannot be observed failing has not been verified.

## Limitations

Stated up front rather than discovered later.

- **No concurrency lock.** One process per store file. Two writers will clobber
  each other.
- **No cross-instance visibility.** Each instance sees only its own file. This
  is intentional for per-agent isolation, but it means separate agents cannot
  see each other's work and may duplicate effort.
- **`snooze` sets `snooze_until` but nothing wakes it.** Items do not return on
  their own; `task_list` is how you find them.
- **No history or audit trail.** The file holds current state only.

## The name

關令尹喜 was the gatekeeper at Hangu Pass. When Laozi tried to leave through it,
the gatekeeper would not let him pass until he wrote his teaching down — which
is why the *Tao Te Ching* exists.

Same idea: you do not get through until you write it down.

## Privacy Policy

**What is collected:** nothing. Guanling has no telemetry, no analytics, no
crash reporting, and no update check.

**What is stored, and where:** only the tasks you create — their title, owner,
next step, status, optional source and blocker, timestamps, and close reason.
They are written to a single JSON file on your own machine, at the path you
configure. By default that is `$HOME/<agent>/.guanling.json` when a folder named
after the agent exists (several agents sharing one machine and one HOME each keep
their list in their own directory), otherwise `$HOME/.guanling/<agent>.json`. Nothing
is written anywhere else.

**Third-party sharing:** none by guanling itself. The server makes no network
requests: no HTTP client, no sockets, no telemetry. It uses four Node builtins —
`node:fs`, `node:path`, `node:crypto` (to mint delegation nonces), and
`node:child_process`.

⚠️ That last one matters and is stated plainly: if you configure
`GUANLING_SEND_CMD`, guanling executes **your** command and pipes a delegation
payload to it on stdin. Whatever that command does with the payload — including
sending it over a network — is outside guanling and is your choice. With the
variable unset, delegation is refused and nothing is ever executed.

(Earlier releases of this file claimed two builtins. That stopped being true in
1.1.0 when delegation was added, and the sentence was not updated until 1.4.0.)

**Data retention:** entirely yours. The file persists until you delete it.
Guanling never expires, prunes, or deletes data on its own — closing a task
marks it `done` or `dropped` and keeps the record. To erase everything, delete
the JSON file.

**Your control:** the store is plain JSON. You can read it, edit it, copy it,
back it up, or delete it with ordinary file tools. No export feature is needed
because the file *is* the export.

**Contact:** open an issue at
<https://github.com/fateLiang/guanling/issues>.

## License

MIT
