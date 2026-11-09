/**
 * dsh-hindsight-digest — host-plane Cordis plugin.
 *
 * A turn boundary only marks its session dirty. Every `flushIntervalMinutes`
 * (default 30) the timer takes each dirty session, extracts the events appended
 * since its cursor, keeps only the decision layer (user text, assistant text,
 * ask exchanges — see `src/digest.js`), appends that to one
 * `conversation:<sessionId>` document in a self-hosted Hindsight bank, and
 * advances the cursor only after the write succeeded. Batching matters because
 * every POST makes the server run `retain_extract_facts`, and that call pays the
 * same long system prefix each time; one POST per interval pays it once.
 *
 * Invariants that matter more than features:
 *   - a listener here MUST NOT throw: a throwing `agent/turn-stopping` listener
 *     ends the turn with an error and pollutes the host flow.
 *   - the cursor moves only after a 2xx; a failed write is retried with the
 *     SAME operation_id, so the server's dedupe keeps the document single.
 *   - a session that existed before this process started is never backfilled.
 *   - exiting before the timer fires loses nothing: the cursor has not moved, so
 *     the next process flushes the same events.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import { extractDigest } from "./src/digest.js"

export const name = "hindsight-digest"
export const inject = ["agents"]

/** Sessions that predate this process are history, not input (no backfill). */
const BOOT_AT = Date.now()

const DEFAULT_BANK_TEMPLATE = "dsh::{gitProject}"
const RETAIN_TAGS = ["source:conversation", "harness:dsh"]
const REQUEST_TIMEOUT_MS = 5000
const STATE_VERSION = 2
const MAX_STATE_SESSIONS = 200
const DEFAULT_FLUSH_INTERVAL_MINUTES = 30
const MIN_FLUSH_INTERVAL_MINUTES = 1

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), ".dsh")
}

function homeDir() {
  return os.homedir()
}

function stateFile() {
  return path.join(dshHome(), "hindsight-digest", "state.json")
}

function overrideConfigFile() {
  return path.join(dshHome(), "hindsight-digest.json")
}

function sharedConfigFile() {
  return path.join(homeDir(), ".hindsight", "coding-agent.json")
}

// ---------------------------------------------------------------------------
// logging — never echo the token, never throw
// ---------------------------------------------------------------------------

function redact(text, config) {
  let out = String(text ?? "")
  const token = config?.apiToken
  if (token && token.length >= 8) out = out.split(token).join("<redacted>")
  return out
}

function logError(where, error, config) {
  try {
    console.error(`[hindsight-digest] ${where}: ${redact(error?.message ?? error, config)}`)
  } catch {
    /* a log line must never fail a hook */
  }
}

function logWarn(message) {
  try {
    console.warn(`[hindsight-digest] ${message}`)
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// configuration
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * `flushIntervalMinutes`: a missing or unparseable value falls back to the
 * default; a real number below the floor is raised to it rather than silently
 * ignored, so `0.5` means "as often as allowed", not "thirty minutes".
 */
function resolveIntervalMinutes(raw) {
  const value = typeof raw === "number" ? raw : Number(raw)
  if (!Number.isFinite(value)) return DEFAULT_FLUSH_INTERVAL_MINUTES
  return Math.max(MIN_FLUSH_INTERVAL_MINUTES, value)
}

/**
 * Resolve the effective configuration.
 *
 * `~/.hindsight/coding-agent.json` is shared with every other Hindsight
 * coding-agent harness and therefore wins nothing; `~/.dsh/hindsight-digest.json`
 * overrides it key by key. Both are re-read on every turn so a fix takes effect
 * without a restart (the host keeps no copy of these files).
 */
export function resolveConfig() {
  const shared = readJsonFile(sharedConfigFile()) ?? {}
  const override = readJsonFile(overrideConfigFile()) ?? {}
  const merged = { ...shared, ...override }
  const apiUrl = typeof merged.apiUrl === "string" ? merged.apiUrl.trim().replace(/\/+$/, "") : ""
  const apiToken = typeof merged.apiToken === "string" ? merged.apiToken.trim() : ""
  const template = typeof merged.bankIdTemplate === "string" && merged.bankIdTemplate.trim()
    ? merged.bankIdTemplate.trim()
    : DEFAULT_BANK_TEMPLATE
  const fixedBank = typeof merged.bankId === "string" && merged.bankId.trim() ? merged.bankId.trim() : ""
  return {
    apiUrl,
    apiToken,
    template,
    fixedBank,
    disabled: merged.disabled === true,
    flushIntervalMinutes: resolveIntervalMinutes(merged.flushIntervalMinutes),
  }
}

// ---------------------------------------------------------------------------
// bank naming
// ---------------------------------------------------------------------------

const projectNameCache = new Map()

function gitRootFor(cwd) {
  const options = { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], options).trim()
    // `<root>/.git` for a normal checkout, `<main>/.git` for a linked worktree:
    // both cases fold a worktree onto the main tree.
    if (commonDir && path.basename(commonDir) === ".git") return path.dirname(commonDir)
  } catch {
    /* fall through to --show-toplevel, then to the directory name */
  }
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim()
    if (top) return top
  } catch {
    /* not a repository: the brief's fallback is the directory name */
  }
  return undefined
}

/** `{gitProject}` — git work-tree root basename, else the directory basename. */
export function projectName(cwd) {
  const directory = path.resolve(cwd || process.cwd())
  const cached = projectNameCache.get(directory)
  if (cached !== undefined) return cached
  const root = gitRootFor(directory)
  const resolved = path.basename(root || directory) || "workspace"
  projectNameCache.set(directory, resolved)
  return resolved
}

export function bankFor(cwd, config) {
  if (config.fixedBank) return config.fixedBank
  return config.template.replace(/\{gitProject\}/g, () => projectName(cwd))
}

// ---------------------------------------------------------------------------
// state — `~/.dsh/hindsight-digest/state.json`
// ---------------------------------------------------------------------------

let state
let stateLoadAttempted = false

function loadState() {
  if (stateLoadAttempted) return state
  stateLoadAttempted = true
  const parsed = readJsonFile(stateFile())
  state = {
    version: STATE_VERSION,
    bootAt: new Date(BOOT_AT).toISOString(),
    sessions: parsed && typeof parsed.sessions === "object" && parsed.sessions ? parsed.sessions : {},
  }
  return state
}

function pruneState() {
  const entries = Object.entries(state.sessions)
  if (entries.length <= MAX_STATE_SESSIONS) return
  entries
    .sort((left, right) => String(right[1]?.updatedAt ?? "").localeCompare(String(left[1]?.updatedAt ?? "")))
    .slice(MAX_STATE_SESSIONS)
    .forEach(([sessionId]) => delete state.sessions[sessionId])
}

function saveState() {
  try {
    const file = stateFile()
    mkdirSync(path.dirname(file), { recursive: true })
    pruneState()
    const temporary = `${file}.tmp-${process.pid}`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`)
    renameSync(temporary, file)
  } catch (error) {
    logWarn(`state not persisted (${redact(error?.message ?? error)}); continuing in memory`)
  }
}

// ---------------------------------------------------------------------------
// host accessors
// ---------------------------------------------------------------------------

/** Session events, `snapshotEvents()` first, `.events` as the documented fallback. */
export function sessionEvents(session) {
  if (session && typeof session.snapshotEvents === "function") {
    try {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
    } catch {
      /* fall through */
    }
  }
  if (session && Array.isArray(session.events)) return session.events
  return undefined
}

let contractWarned = false
function warnContractOnce() {
  if (contractWarned) return
  contractWarned = true
  logWarn("host contract mismatch (no session.snapshotEvents()/session.events) — going idle")
}

// ---------------------------------------------------------------------------
// write to Hindsight
// ---------------------------------------------------------------------------

/** Deterministic UUIDv5-shaped id derived from sha1, so a retry dedupes server-side. */
export function operationId(...parts) {
  const digest = createHash("sha1").update(parts.join("|")).digest()
  const bytes = Buffer.from(digest.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function sendJson(config, method, url, body) {
  return fetch(url, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${config.apiToken}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
}

function bankUrl(config, bank, suffix = "") {
  return `${config.apiUrl}/v1/default/banks/${encodeURIComponent(bank)}${suffix}`
}

/**
 * POST one append. A 404 means the bank does not exist yet: create it with an
 * empty PUT and retry exactly once, as the brief specifies.
 */
async function postRetain(config, bank, payload) {
  const body = {
    items: [payload.item],
    async: true,
    operation_id: payload.operationId,
  }
  let response
  try {
    response = await sendJson(config, "POST", bankUrl(config, bank, "/memories"), body)
    if (response.status === 404) {
      await sendJson(config, "PUT", bankUrl(config, bank), {})
      response = await sendJson(config, "POST", bankUrl(config, bank, "/memories"), body)
    }
  } catch (error) {
    logError("retain request", error, config)
    return false
  }
  if (!response.ok) {
    let detail = ""
    try {
      detail = (await response.text()).slice(0, 200)
    } catch {
      /* ignore */
    }
    logError("retain rejected", new Error(`HTTP ${response.status} ${detail}`), config)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

function buildPayload(config, bank, sessionId, digest, batch) {
  const fromSeq = batch[0].seq
  const toSeq = batch[batch.length - 1].seq
  let lastTime = Date.now()
  for (let index = batch.length - 1; index >= 0; index -= 1) {
    if (typeof batch[index].time === "number") {
      lastTime = batch[index].time
      break
    }
  }
  return {
    fromSeq,
    toSeq,
    operationId: operationId(config.apiUrl, bank, sessionId, fromSeq, toSeq),
    item: {
      content: digest.markdown,
      document_id: `conversation:${sessionId}`,
      update_mode: "append",
      timestamp: new Date(lastTime).toISOString(),
      tags: [...RETAIN_TAGS],
    },
  }
}

export async function flushSession(agent) {
  const config = resolveConfig()
  if (config.disabled || !config.apiUrl || !config.apiToken) return

  const session = agent?.session
  const sessionId = session?.header?.id
  if (typeof sessionId !== "string" || !sessionId) return
  // A subagent's turns are the parent's tool behaviour, not user conversation.
  if (session.header.origin === "subagent") return

  const events = sessionEvents(session)
  if (!events) {
    warnContractOnce()
    return
  }

  const inherited = Number.isFinite(session.inheritedEventCount) ? session.inheritedEventCount : 0
  const own = events.filter((event) => event && typeof event.seq === "number" && event.seq >= inherited)
  if (own.length === 0) return

  const cwd = session.header.cwd || process.cwd()
  const bank = bankFor(cwd, config)
  if (!bank) return

  const sessions = loadState().sessions
  const maxSeq = own[own.length - 1].seq
  let record = sessions[sessionId]
  if (!record || typeof record.seq !== "number") {
    const firstTime = typeof own[0].time === "number" ? own[0].time : BOOT_AT
    const preexisting = firstTime < BOOT_AT
    record = sessions[sessionId] = {
      seq: preexisting ? maxSeq : inherited - 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      writes: 0,
    }
    if (preexisting) record.skippedBackfill = true
    saveState()
    if (preexisting) return
  }

  // A previous attempt failed after the server may already have accepted it:
  // replay the exact same operation_id before building anything new.
  if (record.pending) {
    const replayed = await postRetain(config, bank, record.pending)
    if (!replayed) return
    record.seq = record.pending.toSeq
    record.updatedAt = new Date().toISOString()
    record.writes = (record.writes ?? 0) + 1
    delete record.pending
    saveState()
  }

  const batch = own.filter((event) => event.seq > record.seq)
  if (batch.length === 0) return

  const digest = extractDigest(batch)
  // A tool-only turn costs no request; the cursor still moves past it.
  if (!digest.segments.some((segment) => segment.role === "user")) {
    record.seq = batch[batch.length - 1].seq
    record.updatedAt = new Date().toISOString()
    saveState()
    return
  }

  const payload = buildPayload(config, bank, sessionId, digest, batch)
  const written = await postRetain(config, bank, payload)
  record.updatedAt = new Date().toISOString()
  if (!written) {
    record.pending = payload
    saveState()
    return
  }
  record.seq = payload.toSeq
  record.writes = (record.writes ?? 0) + 1
  record.documentId = payload.item.document_id
  saveState()
}

const inFlight = new Map()

/** Coalesce concurrent flushes of one session; never rejects. */
export function flush(agent) {
  const sessionId = agent?.session?.header?.id
  if (typeof sessionId !== "string" || !sessionId) return Promise.resolve()
  const running = inFlight.get(sessionId)
  if (running) return running
  const attempt = (async () => {
    try {
      await flushSession(agent)
    } catch (error) {
      logError("flush", error, resolveConfig())
    }
  })().finally(() => inFlight.delete(sessionId))
  inFlight.set(sessionId, attempt)
  return attempt
}

// ---------------------------------------------------------------------------
// batching — one timer for every dirty session
// ---------------------------------------------------------------------------

/** Sessions with unflushed turns. The agent is kept so the tick can read it. */
const dirty = new Map()
let flushTimer = null

/** The live timer; exposed so a test can assert it exists and does not hold the process. */
export function activeFlushTimer() {
  return flushTimer
}

function clearFlushTimer() {
  if (flushTimer === null) return
  clearTimeout(flushTimer)
  flushTimer = null
}

function ensureFlushTimer() {
  if (flushTimer !== null || dirty.size === 0) return
  const config = resolveConfig()
  if (config.disabled || !config.apiUrl || !config.apiToken) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    // An unhandled rejection here would leave the host with a dangling timer.
    flushDirty().catch((error) => logError("scheduled flush", error, config))
  }, config.flushIntervalMinutes * 60_000)
  // Never keep DSH alive just to write memory.
  flushTimer.unref?.()
}

/** Mark a session as having turns the next tick must write. */
export function markDirty(agent) {
  const session = agent?.session
  const sessionId = session?.header?.id
  if (typeof sessionId !== "string" || !sessionId) return
  // A subagent's turns are the parent's tool behaviour, not user conversation.
  if (session.header.origin === "subagent") return
  const config = resolveConfig()
  if (config.disabled || !config.apiUrl || !config.apiToken) return
  dirty.set(sessionId, agent)
  ensureFlushTimer()
}

/**
 * Flush every dirty session once, then stop. A session marked while the loop
 * runs stays dirty and restarts the timer, so nothing is dropped between ticks.
 * `flush()` never rejects and coalesces with an in-flight write of the same
 * session, so a tick racing `agent/disposed` writes at most once.
 */
export async function flushDirty() {
  const pending = [...dirty.values()]
  dirty.clear()
  clearFlushTimer()
  for (const agent of pending) {
    try {
      await flush(agent)
    } catch (error) {
      logError("scheduled flush", error, resolveConfig())
    }
  }
  ensureFlushTimer()
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx) {
  if (!ctx || typeof ctx.on !== "function") {
    logWarn("ctx.on is unavailable — plugin disabled")
    return
  }
  loadState()

  // DSH 0.2.x offers no `agent/session-start` (older harness docs still name
  // it); the real edges are `agent/turn-stopping` below and `agent/disposed`.
  ctx.on("agent/turn-stopping", ({ agent }) => {
    // No request here: the write waits for the tick, and a receipt-only or
    // tool-only stretch costs nothing when it arrives.
    try {
      markDirty(agent)
    } catch (error) {
      logError("turn-stopping", error, resolveConfig())
    }
  })
  ctx.on("agent/disposed", ({ agent }) => {
    // Last chance to capture the tail of a session that is going away. The
    // returned promise is ignored by the emit dispatch; a test awaits it.
    const sessionId = agent?.session?.header?.id
    if (typeof sessionId === "string") {
      dirty.delete(sessionId)
      if (dirty.size === 0) clearFlushTimer()
    }
    return flush(agent).catch((error) => logError("disposed flush", error, resolveConfig()))
  })
}

export default { name, inject, apply }
