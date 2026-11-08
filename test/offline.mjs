#!/usr/bin/env node
/**
 * Offline acceptance harness — no host, no network, no real bank.
 *
 *   node test/offline.mjs [--log <session.v4.jsonl.zstd>]
 *
 * The first block drives `flush()`/`apply()` with a fake agent, a fake fetch,
 * and a throwaway DSH_HOME, asserting the write contract (no backfill, empty
 * turns free, retry keeps one operation_id, 404 creates the bank, receipts
 * dropped). With `--log` it also renders a real session log and asserts the
 * content contract from the README.
 *
 * Exit code 0 = every check passed; 1 = at least one failed.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { zstdDecompressSync } from "node:zlib"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

const results = []

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function equal(actual, expected, message) {
  const left = JSON.stringify(actual)
  const right = JSON.stringify(expected)
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`)
}

async function test(name, body) {
  try {
    await body()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error: error.message })
    console.log(`FAIL ${name}\n     ${error.message}`)
  }
}

// ---------------------------------------------------------------------------
// fake host
// ---------------------------------------------------------------------------

const BOOT = Date.now()
const HOUR = 3600_000

function makeHome() {
  const home = mkdtempSync(path.join(tmpdir(), "digest-home-"))
  const cwd = mkdtempSync(path.join(tmpdir(), "digest-cwd-"))
  writeFileSync(path.join(home, "hindsight-digest.json"), JSON.stringify({
    apiUrl: "http://digest.invalid:39197",
    apiToken: "test-token-000000000000",
    bankIdTemplate: "dsh::{gitProject}",
  }))
  return { home, cwd }
}

async function freshModule(home) {
  process.env.DSH_HOME = home
  return import(`${path.join(ROOT, "index.js")}?case=${Math.random().toString(36).slice(2)}`)
}

function userEvent(seq, text, time = BOOT + 1000) {
  return { type: "user/message", seq, time, data: { source: { kind: "user" }, content: [{ type: "text", text }] } }
}

function assistantEvent(seq, text, time = BOOT + 1000) {
  return { type: "assistant/message", seq, time, data: { message: { content: [{ type: "reasoning", text: "hidden" }, { type: "text", text }] } } }
}

function askCall(seq, callId, question) {
  return {
    type: "tool/call",
    seq,
    time: BOOT + 1000,
    data: { name: "ask_user_question", callId, arguments: JSON.stringify({ questions: [{ id: "q1", question }] }) },
  }
}

function askResult(seq, callId, answers) {
  return {
    type: "tool/result",
    seq,
    time: BOOT + 1000,
    data: { message: { source: { kind: "tool", callId }, content: [{ type: "text", text: JSON.stringify({ answers }) }] } },
  }
}

/** The URL a bank must be addressed by: the id is percent-encoded, as the API expects. */
function bankUrl(cwd, suffix = "") {
  const bank = `dsh::${path.basename(cwd)}`
  return `http://digest.invalid:39197/v1/default/banks/${encodeURIComponent(bank)}${suffix}`
}

function fakeAgent({ id, cwd, events, origin, inherited = 0 }) {
  return { id, session: { header: { id, cwd, origin }, inheritedEventCount: inherited, snapshotEvents: () => events } }
}

function jsonResponse(status, body = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  }
}

/** Replace globalThis.fetch and return the recorded calls. */
function stubFetch(handler) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    return handler(call, calls.length)
  }
  return calls
}

const realFetch = globalThis.fetch
const realConsole = { error: console.error, warn: console.warn }
let logs = []
function captureLogs() {
  logs = []
  console.error = (...args) => logs.push(args.join(" "))
  console.warn = (...args) => logs.push(args.join(" "))
}
function restoreAll() {
  globalThis.fetch = realFetch
  console.error = realConsole.error
  console.warn = realConsole.warn
}

// ---------------------------------------------------------------------------
// write contract
// ---------------------------------------------------------------------------

await test("session predating boot is never backfilled", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [
    userEvent(0, "old question", BOOT - HOUR),
    assistantEvent(1, "old answer", BOOT - HOUR),
  ]
  const calls = stubFetch(() => jsonResponse(200))
  await mod.flush(fakeAgent({ id: "session-old", cwd, events }))
  equal(calls.length, 0, "HTTP calls")
  const state = JSON.parse(readFileSync(path.join(home, "hindsight-digest", "state.json"), "utf8"))
  equal(state.sessions["session-old"].seq, 1, "cursor")
  equal(state.sessions["session-old"].skippedBackfill, true, "skippedBackfill flag")
})

await test("new session appends one decision-layer document", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [
    userEvent(0, "记忆写入模式怎么定？"),
    { type: "tool/call", seq: 1, time: BOOT + 1000, data: { name: "bash", callId: "c1", arguments: "{}" } },
    { type: "tool/result", seq: 2, time: BOOT + 1000, data: { message: { source: { callId: "c1" }, content: [{ type: "text", text: "noise" }] } } },
    assistantEvent(3, "我的建议是只留决策层。"),
  ]
  const calls = stubFetch(() => jsonResponse(200, { operation_id: "op" }))
  await mod.flush(fakeAgent({ id: "session-new", cwd, events }))
  equal(calls.length, 1, "HTTP calls")
  const body = calls[0].body
  check(calls[0].method === "POST", "uses POST")
  equal(calls[0].url, bankUrl(cwd, "/memories"), "bank-scoped URL")
  equal(body.async, true, "async")
  check(typeof body.operation_id === "string" && body.operation_id.length === 36, "operation_id is a uuid")
  equal(body.items.length, 1, "one item")
  const item = body.items[0]
  equal(item.document_id, "conversation:session-new", "document_id")
  equal(item.update_mode, "append", "update_mode")
  equal(item.tags, ["source:conversation", "harness:dsh"], "tags")
  check(item.content.includes("## 用户") && item.content.includes("## 助手"), "sections present")
  check(!item.content.includes("noise"), "tool result excluded")
  const state = JSON.parse(readFileSync(path.join(home, "hindsight-digest", "state.json"), "utf8"))
  equal(state.sessions["session-new"].seq, 3, "cursor advanced to last event")
})

await test("a tool-only turn costs no request but advances the cursor", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [
    userEvent(0, "first question"),
    assistantEvent(1, "first answer"),
  ]
  const calls = stubFetch(() => jsonResponse(200))
  const agent = fakeAgent({ id: "session-tools", cwd, events })
  await mod.flush(agent)
  equal(calls.length, 1, "first write")

  events.push(
    { type: "tool/call", seq: 2, time: BOOT + 2000, data: { name: "bash", callId: "c2", arguments: "{}" } },
    { type: "tool/result", seq: 3, time: BOOT + 2000, data: { message: { source: { callId: "c2" }, content: [{ type: "text", text: "noise" }] } } },
    assistantEvent(4, "only tools ran here", BOOT + 2000),
  )
  await mod.flush(agent)
  equal(calls.length, 1, "no request for a user-less batch")
  const state = JSON.parse(readFileSync(path.join(home, "hindsight-digest", "state.json"), "utf8"))
  equal(state.sessions["session-tools"].seq, 4, "cursor still advanced")
})

await test("receipts never enter memory", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [
    userEvent(0, "执行"),
    askCall(1, "call-auth", "①目标环境…②动作…③回滚…④回执…"),
    askResult(2, "call-auth", [{ id: "q1", selected: ["②-1 做这件事"], custom: "执行" }]),
  ]
  const calls = stubFetch(() => jsonResponse(200))
  await mod.flush(fakeAgent({ id: "session-receipt", cwd, events }))
  equal(calls.length, 0, "no write for a receipt-only turn")
})

await test("a substantive ask is kept", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [
    userEvent(0, "记忆写入模式怎么定？"),
    askCall(1, "call-mode", "记忆写入模式怎么定？"),
    askResult(2, "call-mode", [{ id: "q1", selected: ["自定义：只写决策层"] }]),
  ]
  const calls = stubFetch(() => jsonResponse(200))
  await mod.flush(fakeAgent({ id: "session-ask", cwd, events }))
  equal(calls.length, 1, "one write")
  const content = calls[0].body.items[0].content
  check(content.includes("## 问答"), "ask section present")
  check(content.includes("Q: 记忆写入模式怎么定？"), "question text present")
  check(content.includes("A: 自定义：只写决策层"), "answer text present")
})

await test("an ask answered by typing the receipt is dropped even with options selected", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [
    userEvent(0, "把这段视频截一下"),
    askCall(1, "call-auth", "①目标环境…②动作…③回滚…④回执…"),
    askResult(2, "call-auth", [{ id: "q1", selected: ["②-1 生成 clip.mp4"], custom: "执行" }]),
  ]
  const calls = stubFetch(() => jsonResponse(200))
  await mod.flush(fakeAgent({ id: "session-auth", cwd, events }))
  const content = calls[0].body.items[0].content
  check(!content.includes("## 问答"), "authorisation ask must not enter memory")
  check(!content.includes("②-1"), "option label must not enter memory")
})

await test("a receipt line inside a longer user message is removed, the rest kept", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [
    userEvent(0, "执行\n但是记得分清楚图片提示词和视频提示词，别把机制搞混了"),
    assistantEvent(1, "明白。"),
  ]
  const calls = stubFetch(() => jsonResponse(200))
  await mod.flush(fakeAgent({ id: "session-mixed", cwd, events }))
  const content = calls[0].body.items[0].content
  check(content.includes("但是记得分清楚图片提示词和视频提示词"), "the real words are kept")
  check(!/^执行$/m.test(content), "the receipt line is gone")
})

await test("no tool output, reasoning, or injected context can reach memory", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const canary = "CANARY-OFFLINE-4c1f"
  const events = [
    { type: "user/message", seq: 0, time: BOOT + 1000, data: { source: { kind: "agent-instructions" }, content: [{ type: "text", text: canary }] } },
    userEvent(1, "真正的问题"),
    { type: "tool/call", seq: 2, time: BOOT + 1000, data: { name: "bash", callId: "c9", arguments: JSON.stringify({ canary }) } },
    { type: "tool/result", seq: 3, time: BOOT + 1000, data: { message: { source: { callId: "c9" }, content: [{ type: "text", text: canary }] } } },
    { type: "assistant/message", seq: 4, time: BOOT + 1000, data: { message: { content: [{ type: "reasoning", text: canary }, { type: "text", text: "真正的回答" }] } } },
  ]
  const calls = stubFetch(() => jsonResponse(200))
  await mod.flush(fakeAgent({ id: "session-canary", cwd, events }))
  const content = calls[0].body.items[0].content
  check(!content.includes(canary), "a dropped block leaked")
  check(content.includes("真正的问题") && content.includes("真正的回答"), "the decision layer survived")
})

await test("a failed write is replayed with the same operation_id", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [userEvent(0, "会失败一次的问题"), assistantEvent(1, "会失败一次的回答")]
  let attempt = 0
  const calls = stubFetch(() => {
    attempt += 1
    if (attempt === 1) throw new Error("connection reset")
    return jsonResponse(200)
  })
  const agent = fakeAgent({ id: "session-retry", cwd, events })
  await mod.flush(agent)
  equal(calls.length, 1, "first attempt")
  let state = JSON.parse(readFileSync(path.join(home, "hindsight-digest", "state.json"), "utf8"))
  equal(state.sessions["session-retry"].seq, -1, "cursor not advanced after failure")
  check(Boolean(state.sessions["session-retry"].pending), "pending batch kept")

  await mod.flush(agent)
  equal(calls.length, 2, "retry happened")
  equal(calls[0].body.operation_id, calls[1].body.operation_id, "same operation_id on retry")
  equal(calls[0].body.items[0].content, calls[1].body.items[0].content, "same content on retry")
  state = JSON.parse(readFileSync(path.join(home, "hindsight-digest", "state.json"), "utf8"))
  equal(state.sessions["session-retry"].seq, 1, "cursor advanced after success")
  check(!state.sessions["session-retry"].pending, "pending cleared")

  await mod.flush(agent)
  equal(calls.length, 2, "no third request when nothing is new")
})

await test("a missing bank is created with an empty PUT and retried once", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const events = [userEvent(0, "需要建 bank 的会话"), assistantEvent(1, "回答")]
  let posts = 0
  const calls = stubFetch((call) => {
    if (call.method === "PUT") return jsonResponse(200, {})
    posts += 1
    return posts === 1 ? jsonResponse(404, { detail: "bank not found" }) : jsonResponse(200, {})
  })
  await mod.flush(fakeAgent({ id: "session-404", cwd, events }))
  equal(calls.map((call) => call.method), ["POST", "PUT", "POST"], "request sequence")
  equal(calls[1].url, bankUrl(cwd), "PUT targets the bank")
  equal(calls[1].body, {}, "PUT body")
})

await test("the token never appears in logs", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  captureLogs()
  const events = [userEvent(0, "触发一次 500"), assistantEvent(1, "回答")]
  stubFetch(() => jsonResponse(500, { detail: "leaked test-token-000000000000 in body" }))
  await mod.flush(fakeAgent({ id: "session-500", cwd, events }))
  restoreAll()
  check(logs.length > 0, "an error was logged")
  for (const line of logs) check(!line.includes("test-token-000000000000"), `token leaked: ${line}`)
})

await test("apply() tolerates a broken host and never throws", async () => {
  const { home } = makeHome()
  const mod = await freshModule(home)
  const handlers = new Map()
  const ctx = { on: (event, listener) => { handlers.set(event, listener) } }
  mod.apply(ctx)
  check(handlers.has("agent/turn-stopping"), "turn-stopping wired")
  check(handlers.has("agent/disposed"), "disposed wired")
  stubFetch(() => jsonResponse(200))
  await handlers.get("agent/turn-stopping")({ agent: undefined })
  await handlers.get("agent/turn-stopping")({ agent: { session: null } })
  await handlers.get("agent/disposed")({ agent: { session: { header: {} } } })
  check(true, "reached here without throwing")
  mod.apply({})
})

await test("a subagent session is ignored", async () => {
  const { home, cwd } = makeHome()
  const mod = await freshModule(home)
  const calls = stubFetch(() => jsonResponse(200))
  const events = [userEvent(0, "子智能体的任务"), assistantEvent(1, "子智能体的回答")]
  await mod.flush(fakeAgent({ id: "session-child", cwd, events, origin: "subagent" }))
  equal(calls.length, 0, "no write for a subagent")
})

// ---------------------------------------------------------------------------
// content contract against a real log
// ---------------------------------------------------------------------------

const logIndex = process.argv.indexOf("--log")
const logPath = logIndex === -1 ? undefined : process.argv[logIndex + 1]

function readSessionLog(file) {
  const raw = readFileSync(file)
  const compressed = raw.length >= 4 && raw[0] === 0x28 && raw[1] === 0xb5 && raw[2] === 0x2f && raw[3] === 0xfd
  const text = compressed ? zstdDecompressSync(raw).toString("utf8") : raw.toString("utf8")
  const entries = text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line))
  const [header, ...events] = entries
  return { header, events: events.filter((event) => typeof event.seq === "number") }
}

if (logPath) {
  const { extractDigest, hasBareReceiptLine } = await import(path.join(ROOT, "src", "digest.js"))
  const { header, events } = readSessionLog(logPath)
  const whole = extractDigest(events)

  await test("real log: no tool, hook, or injected-context traces", async () => {
    check(whole.markdown.length > 0, "rendered something")
    for (const needle of ["tool/call", "tool/result", "tool_use", "<system-reminder>", "agent-instructions", "runtime-context"]) {
      check(!whole.markdown.includes(needle), `output contains ${needle}`)
    }
    check(!hasBareReceiptLine(whole.markdown), "bare receipt line present")
  })

  await test("real log: every kept question has its answer", async () => {
    const questions = whole.markdown.split("\n").filter((line) => line.startsWith("- Q: "))
    const answers = whole.markdown.split("\n").filter((line) => line.startsWith("  A: "))
    equal(questions.length, answers.length, "Q/A pairing")
  })

  await test("real log: passing the last seq yields nothing", async () => {
    const last = events[events.length - 1].seq
    const empty = extractDigest(events, { afterSeq: last })
    equal(empty.markdown, "", "markdown for a cursor at the end")
  })

  await test("real log: a mid-turn interjection keeps both user messages", async () => {
    let turnStart = null
    let seen = []
    let window = null
    for (const event of events) {
      if (event.type === "turn/start") {
        turnStart = event.seq
        seen = []
        continue
      }
      if (event.type === "user/message" && event.data?.source?.kind === "user") {
        seen.push(event)
        if (seen.length === 2 && turnStart !== null) {
          window = { from: turnStart, first: seen[0], second: seen[1] }
          break
        }
      }
    }
    check(Boolean(window), "no turn with two user messages in this log")
    const slice = extractDigest(events, { afterSeq: window.from - 1 })
    const firstText = window.first.data.content.map((block) => block.text).join("").trim().slice(0, 24)
    const secondText = window.second.data.content.map((block) => block.text).join("").trim().slice(0, 24)
    check(slice.markdown.includes(firstText), "first user message missing")
    check(slice.markdown.includes(secondText), "second user message missing")
  })
} else {
  console.log("skip real-log checks (pass --log <session.v4.jsonl.zstd>)")
}

// ---------------------------------------------------------------------------

restoreAll()
const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) {
  for (const entry of failed) console.log(` - ${entry.name}: ${entry.error}`)
  process.exit(1)
}
