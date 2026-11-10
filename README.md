# dsh-hindsight-digest

A DeepSeek Harness (DSH) plugin that appends **only the decision layer** of each
turn to a self-hosted [Hindsight](https://github.com/vectorize-io/hindsight)
bank: what you typed, what the assistant said, and the question/answer exchanges
you answered. Tool calls, tool results, reasoning blocks, and injected context
never reach memory.

It replaces the write path of `@vectorize-io/hindsight-coding-agents`, whose
per-turn transcript append cost ~109 LLM calls / 350k tokens for a 26-turn
session and left the bank ~87% `command_run` tool logs.

## What is kept

| kept | dropped |
|---|---|
| `user/message` with `source.kind === "user"` | every other `user/message` source (`agent-instructions`, `runtime-context`, `skill-catalog`, `time-context`, `goal`, `plugin:*`, …) |
| `assistant/message` **text** blocks | `reasoning` / thinking blocks, `tool-call` blocks, `assistant/attempt` |
| `tool/call` + paired `tool/result` for `ask_user_question` | every other `tool/*`, `hook/*`, `step/*`, `request/*`, `user-approval` |
| | a user message that is only `执行` (trailing punctuation allowed) |
| | an ask whose every answer is an authorisation receipt |

Rendered body, appended turn by turn into one document:

```markdown
## 用户
…

## 助手
…

## 问答
- Q: 记忆写入模式怎么定？
  A: 自定义：我认为不是所有东西都值得写
```

An answer is an authorisation receipt when its `custom` text is exactly `执行`
(trailing punctuation allowed). A receipt-only ask is dropped whole, so the
authorisation round-trips never enter memory; an ask that carries a real
selection or a written answer is kept.

A bare `执行` line inside a user message is a receipt too — the approvals in
this workflow are often typed as the first or last line of a longer message
(`执行` then the actual instruction). That one line is removed and the rest of
the words are kept verbatim. A `执行` line inside a fenced code block is code
being quoted, not a receipt, so fences are left untouched (this also applies to
assistant text: a quoted file is never rewritten).

## Install

The package is a normal DSH bundle: `package.json` declares
`dsh.bundle.patch`, and `cordis.patch.yml` inserts one host-plane row.

```sh
# GUI: plugin manager → install bundle → point it at this directory
# or, from a shell:
dsh plugin --profile web add github:<user>/dsh-hindsight-digest
```

`dsh plugin add` only forwards to pnpm — it does **not** write
`dsh.profile.bundles`. Add the package name to that list yourself (or install
through the GUI plugin manager, which does both), then restart DSH. With
`patchReload: "live"` the row mounts without a restart, but configuration is
read per turn, so a restart is never needed for config changes.

## Configure

Resolution order, later wins key by key:

1. `~/.hindsight/coding-agent.json` — shared with every Hindsight coding agent
2. `~/.dsh/hindsight-digest.json` — this plugin only

| key | meaning |
|---|---|
| `apiUrl` | Hindsight server root, e.g. `http://host:39197` |
| `apiToken` | bearer token (never logged, never placed in argv) |
| `bankId` | pin one bank, overriding the template |
| `bankIdTemplate` | default `dsh::{gitProject}`; `{gitProject}` = git work-tree root basename, else the directory basename |
| `disabled` | `true` writes nothing |

A worktree folds onto its main tree (the git **common** dir's parent), so a
linked worktree does not mint a second bank.

State lives in `~/.dsh/hindsight-digest/state.json`: one record per session with
the last processed `seq`. It is written atomically (tmp + rename); if it cannot
be written the plugin keeps the cursor in memory for the life of the process and
says so once.

## Behaviour

* **Trigger** — `agent/turn-stopping` writes immediately; `agent/disposed`
  flushes whatever is left before the session goes away.
* **Incremental** — each session has a cursor; only `event.seq > cursor` is
  processed. A message inserted mid-turn has a larger seq and is therefore
  picked up by the same flush, never lost.
* **No backfill** — a session whose first event predates this process
  (`BOOT_AT`) is skipped to its last seq on first sight. A session created after
  boot starts from the beginning.
* **Subagents are skipped** — `session.header.origin === "subagent"` is the
  parent's tool behaviour, not user conversation.
* **Tool-only turns cost nothing** — no user text in the batch means no request;
  the cursor still advances.
* **Cursor after success only** — a failed write keeps the batch as `pending`
  and the next flush replays it with the *same* `operation_id`, so the server's
  dedupe keeps the document single instead of appending the tail twice.
* **Never throws** — every hook path catches; a throwing `turn-stopping`
  listener would end the turn with an error.

## Write timing (写入时机)

Every turn boundary writes. The request is one `POST` with `async: true`: the
server stores the text and answers in milliseconds, and only the fact extraction
runs in the background (`retain_extract_facts`, a few seconds).

* **Why not batch** — 0.2.0 held writes for 30 minutes to pay one extraction call
  per interval instead of one per turn. That put the text in process memory:
  closing or killing the client lost the whole interval. The server has no
  "extract later" switch (`async: false` only waits, it does not move the
  extraction), so a delay can only live on the client, where it costs
  durability. 0.3.0 writes at every boundary instead.
* **Cost** — one extraction call per turn (deepseek: roughly 3–4K input,
  1–1.5K output, 2–3 s of server time). Accepted as the price of not losing text.
* **Concurrency** — a boundary that arrives while the same session is still
  writing is owed a second pass: the running write sets `again`, and the loop
  reads the cursor again as soon as it finishes. N turns produce at most N
  requests; none is folded into another and lost.
* **No timer, no interval** — `flushIntervalMinutes` is gone. A config file that
  still sets it is read normally and the key is ignored with one warning.

Write request:

```
POST {apiUrl}/v1/default/banks/{bankId}/memories
Authorization: Bearer {apiToken}
{
  "items": [{
    "content": "<markdown>",
    "document_id": "conversation:<sessionId>",
    "update_mode": "append",
    "timestamp": "<ISO of the last event in the batch>",
    "tags": ["source:conversation", "harness:dsh"]
  }],
  "async": true,
  "operation_id": "<uuid5-shaped sha1 of apiUrl|bank|session|fromSeq|toSeq>"
}
```

`404` ⇒ `PUT {apiUrl}/v1/default/banks/{bankId}` with `{}`, then one retry.

## Offline check

`bin/selftest.js` renders a saved session log without touching the host, the
network, or any bank:

```sh
node bin/selftest.js ~/.dsh/sessions/<dir>/session-<id>/session.v4.jsonl.zstd
node bin/selftest.js <log> --from-seq=9739     # empty: cursor is at the end
node bin/selftest.js <log> --json
```

Markdown goes to stdout, one `events= users= asks= dropped= chars=` line to
stderr. `--from-seq=N` is the exclusive cursor, matching how the plugin slices.

## Operate

```sh
# what did it write last?
tail -c 2000 ~/.dsh/hindsight-digest/state.json

# disable without uninstalling: put this in the profile's cordis.patch.yml
- id: hindsight-digest
  disabled: true
```

Remove the package from `dsh.profile.bundles` to uninstall. Existing
`conversation:<sessionId>` documents stay in the bank; delete them there if you
want them gone.

## Known pitfalls

1. A profile `cordis.patch.yml` must stay a **top-level YAML array**; a file with
   only comments parses as `null` and the loader refuses to start.
2. `dsh plugin add` does not register the bundle (see Install).
3. Configuration is read per turn here, but the **profile's** bundle list is not:
   installing or removing a bundle needs a restart to be authoritative.
4. `ask_user_question` answers live in the paired `tool/result`'s
   `content[0].text` (a JSON string), not in `tool/call`.
5. Session logs are zstd (`session.v4.jsonl.zstd`); Node ≥ 22.15 or the `zstd`
   CLI can read them.
6. A hot-loaded plugin really runs — installing it starts writing immediately.
7. DSH 0.2.2-rc.1 has **no** `agent/session-start` event; the real edges are
   `agent/created`, `agent/turn-stopping`, and `agent/disposed`.
