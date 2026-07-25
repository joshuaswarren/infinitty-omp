# infinitty-omp

Publishes [omp](https://oh-my-pi.dev)'s todo list to an
[infinitty](https://infinitty.ai) pane, so the pane header's checklist icon
tracks what the agent is actually doing — including when omp runs on a
different machine.

```
┌─ pane header ───────────────────────────────── ☑ 3/7 ─┐
│                                                        │
│  ✔ Read the config loader                              │
│  ✔ Add the retry path                                  │
│  ✔ Wire it into the client                             │
│  ◉ Backfill tests for the retry path                   │
│  ○ Update the changelog                                │
│  ○ …                                                   │
```

infinitty already renders per-pane agent todo lists. It just has no way to
learn about them from omp, and no way at all to learn about them from an
agent running over SSH. This closes both gaps in about 200 lines.

## Why this exists

infinitty's todo surface is **push-based** — nothing scrapes your terminal.
An agent publishes its list over infinitty's control socket and the pane
header renders it. That design is agent-neutral, but two things are missing
in practice:

1. **omp doesn't know infinitty exists.** Nothing in omp emits the list.
2. **The socket is local.** It is an `AF_UNIX` socket on the machine running
   infinitty, and `$INFINITTY_SOCKET` is exported only into the pane's own
   shell. Neither survives an SSH hop, so an agent on a remote host is
   invisible to the terminal displaying it.

This extension hooks omp's `todo` tool and writes to that socket — the local
one when omp runs in an infinitty pane, or an SSH-forwarded one when it
doesn't.

## Requirements

- **omp** with extension support (developed against 17.1.2)
- **infinitty 0.1.9 or newer.** The `todos` control command does not exist in
  0.1.8 and earlier — those builds answer `error: unknown command 'todos'`.
  Check with `printf 'version\n' | nc -U /tmp/infinitty-current.sock`.
- For the remote setup: OpenSSH 6.7+ on both ends, for Unix-socket forwarding

## Install

```sh
omp plugin install 'github:joshuaswarren/infinitty-omp#main'
```

Restart any running omp session — extensions load at session start.

> Install it as a **plugin**, not through a marketplace catalog. omp does not
> load `omp.extensions` entry points from marketplace installs, only from
> npm/git installs and `omp plugin link`.

## Setup

Pick the row that matches where omp runs.

### omp runs in the infinitty pane (same machine)

Nothing to configure. infinitty exports `$INFINITTY_SOCKET` into the pane's
shell, and the extension finds it.

### omp runs on a remote host, over SSH

Forward the pane's socket to a fixed path on the remote host, then point the
extension at it.

```sh
ssh -R /tmp/infinitty-pane.sock:"$INFINITTY_SOCKET" you@remote-host
```

`$INFINITTY_SOCKET` expands locally at launch, so the dynamic pane path is
resolved before ssh sees it. On the remote host:

```sh
export INFINITTY_OMP_SOCKET=/tmp/infinitty-pane.sock
```

The remote `sshd` needs `StreamLocalBindUnlink yes`, or a leftover socket
file from a previous session will block the forward from binding.

If your remote sessions run under a multiplexer (tmux, herdr, zellij), make
sure `INFINITTY_OMP_SOCKET` reaches the agent's environment and not just your
login shell — a multiplexer server started before the variable existed will
hand its panes the old environment.

### Addressing a specific pane

If `INFINITTY_PANE_ID` (or `INFINITTY_OMP_PANE_ID`) is set, the extension
switches to infinitty's **app socket** and addresses that pane explicitly:
`todos <pane-id> <json>` instead of `todos <json>`. This is the more robust
transport — one stable socket path (`/tmp/infinitty-current.sock`) instead of
a per-pane one.

infinitty does not export a pane id into panes today, so this path is
currently opt-in: you supply the id yourself. The extension reads the
un-prefixed names as well, so it will pick this up automatically if infinitty
starts exporting them.

## Configuration

All optional. The extension is inert — zero cost, no connections, no errors —
when it can't resolve a socket.

| Variable | Effect |
| --- | --- |
| `INFINITTY_OMP_SOCKET` | Socket path to publish to. Overrides everything below. Use this for the SSH-forwarded path. |
| `INFINITTY_OMP_PANE_ID` | Target pane id. Its presence selects app-socket addressing. |
| `INFINITTY_SOCKET` | Set by infinitty inside a pane. Used when no override and no pane id. |
| `INFINITTY_APP_SOCKET` | App socket path, used when a pane id is set. |
| `INFINITTY_PANE_ID` | Same as `INFINITTY_OMP_PANE_ID`; read for forward compatibility. |
| `INFINITTY_OMP_DEBUG=1` | Log resolution, rejections, and socket errors to stderr. |

Resolution: a pane id selects app-socket addressing
(`INFINITTY_OMP_SOCKET` → `INFINITTY_APP_SOCKET`); no pane id selects
pane-socket addressing (`INFINITTY_OMP_SOCKET` → `INFINITTY_SOCKET`).

## How the list is translated

omp's todo state is a list of phases, each with tasks. infinitty's is one
flat checklist. The mapping:

| omp | infinitty |
| --- | --- |
| `pending` | `○` empty circle |
| `in_progress` | `◉` filled circle, bold |
| `completed` | `✔` green check |
| `abandoned` | **dropped from the list** |
| single phase | task content, unprefixed |
| multiple phases | `Phase: task content` |

**Why `abandoned` is dropped rather than mapped.** infinitty renders exactly
three states — done, active, neither. An abandoned task has no honest home:
marking it done is a lie, and leaving it pending means the list can never
reach `7/7`. Dropping it matches omp's own behavior, which strips completed
and abandoned tasks when resuming a session.

**Why phase names are only a prefix sometimes.** The popover is 300pt wide.
Prefixing every task in a single-phase list burns that width on a constant.

## Behavior

- **Never blocks the agent.** Writes are fire-and-forget with a 700 ms
  ceiling. A missing, stalled, or dead terminal is a no-op, not an error.
- **Never throws.** Socket failures are swallowed (visible under
  `INFINITTY_OMP_DEBUG=1`), because a cosmetic checklist must not be able to
  fail a coding session.
- **Ordered.** Writes are serialized, so a slow connection can't deliver an
  older list after a newer one.
- **Quiet.** Byte-identical payloads are skipped — a `todo view` call that
  changes nothing sends nothing.
- **Tidy.** The list is cleared on session shutdown, so a pane that outlives
  its agent doesn't keep a stale checklist.
- **Only the main agent publishes.** omp does not give subagents the `todo`
  tool, so parallel subagents can't fight over the list.

## Known limitation: one pane, one list

infinitty's todo state is **per pane**. If several agents share a single pane
— which is exactly what happens when a terminal multiplexer runs N agents
behind one SSH session — they all write the same checklist, and the last
write wins.

Workable approaches today:

- **One infinitty pane per agent.** Correct, but gives up the multiplexer's
  own agent switcher.
- **Publish from the focused agent only.** Gate the extension's environment
  so only the agent you're looking at has a socket to write to. Degrades to
  "the current agent's todos", which is usually what you want to see anyway.

A real fix needs a session dimension in infinitty's todo model
(`todos <pane-id> <session-key> <json>`, grouped in the popover). That is an
upstream change, not something this extension can work around.

## Troubleshooting

```sh
INFINITTY_OMP_DEBUG=1 omp
```

| Symptom | Cause |
| --- | --- |
| `no infinitty socket in env; inert` | No variable resolved. Check the table above; remember a multiplexer server may hold a stale environment. |
| `socket error: ENOENT` | The path doesn't exist. Locally, the pane died. Remotely, the SSH forward isn't up. |
| `socket error: ECONNREFUSED` | A stale socket file with nothing listening. Set `StreamLocalBindUnlink yes` on the remote `sshd`. |
| `infinitty rejected: error: unknown command 'todos'` | infinitty is older than 0.1.9. Upgrade; note that the npm package can lag the GitHub release. |
| `infinitty rejected: error: …` | The command reached infinitty and was refused — usually a pane id that no longer exists. |
| Nothing logged at all | The extension didn't load. Check `omp plugin list`, and restart the session. |

Verify the socket by hand, from wherever omp runs:

```sh
printf 'ping\n' | nc -U "$INFINITTY_OMP_SOCKET"           # expect: pong
printf 'todos [{"content":"hi","status":"pending"}]\n' \
  | nc -U "$INFINITTY_OMP_SOCKET"                          # expect: ok
```

## Development

```sh
git clone https://github.com/joshuaswarren/infinitty-omp
cd infinitty-omp
bun install
bun test                       # protocol tests against a fake infinitty socket
omp plugin link "$PWD"         # symlink into omp; edits reload on session start
```

The test suite stands up a real Unix-socket server speaking infinitty's
protocol and asserts the exact bytes written, so the wire format is covered
without needing infinitty (or macOS) present.

## Related

- [infinitty](https://github.com/jasonkneen/infinitty) — the terminal. Its
  control-socket protocol is documented in the README and implemented in
  `Sources/InfinittyKit/ControlServer.swift` and `AppControlServer.swift`.
- [omp](https://oh-my-pi.dev) — the coding agent. Extension events are
  documented under `omp://extensions.md`; the todo tool's result shape under
  `omp://tools/todo.md`.

## License

MIT
