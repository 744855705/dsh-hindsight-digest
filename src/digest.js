/**
 * Decision-layer digest: session events in, markdown out.
 *
 * This module is deliberately pure — no filesystem, no network, no host
 * objects — so `bin/selftest.js` can run it against a saved session log on a
 * machine that has never seen DeepSeek Harness.
 *
 * The contract it implements (see README "What is kept"):
 *   keep  user/message whose source.kind === "user"
 *   keep  assistant/message text blocks (never reasoning blocks)
 *   keep  ask_user_question calls paired with their tool/result answers
 *   drop  everything else, the literal receipt "执行", and receipt-only asks
 */

/**
 * The one chat word that authorises work. It is a receipt, not content: a user
 * message that is only this word (trailing punctuation allowed) never enters
 * memory, and an answer whose `custom` text is only this word is a receipt too.
 */
export const AUTH_RECEIPT = /^执行[。．.、,，!！?？]*$/

const SECTION_LABEL = { user: "用户", assistant: "助手", ask: "问答" }

/** Whether `text` is exactly the authorisation receipt (trailing punctuation allowed). */
export function isReceiptText(text) {
  return typeof text === "string" && AUTH_RECEIPT.test(text.trim())
}

/**
 * Remove receipt-only lines from user text, leaving fenced code blocks alone.
 *
 * The brief drops a message that is *only* the receipt. In practice an approval
 * is often typed as the first (or last) line of a longer message — "执行\n记着
 * 分清楚图片提示词和视频提示词" — so the standalone line is removed and the
 * rest of the user's words are kept verbatim. A `执行` line inside a fence is
 * code being quoted, never a receipt.
 */
export function stripReceiptLines(text) {
  const kept = []
  let fenced = false
  for (const line of String(text).split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      kept.push(line)
      continue
    }
    if (!fenced && isReceiptText(line)) continue
    kept.push(line)
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Whether a rendered body still contains a standalone receipt line outside a fence. */
export function hasBareReceiptLine(markdown) {
  let fenced = false
  for (const line of String(markdown).split("\n")) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (!fenced && isReceiptText(line)) return true
  }
  return false
}

/**
 * Concatenate the `text` blocks of a message content array.
 * Reasoning and tool-call blocks are ignored by construction.
 */
export function textOf(blocks) {
  if (!Array.isArray(blocks)) return ""
  const parts = []
  for (const block of blocks) {
    if (block && block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      parts.push(block.text.trim())
    }
  }
  return parts.join("\n\n")
}

function parseJson(value) {
  if (typeof value !== "string" || !value.trim()) return undefined
  try {
    return JSON.parse(value)
  } catch {
    const start = value.indexOf("{")
    const end = value.lastIndexOf("}")
    if (start === -1 || end <= start) return undefined
    try {
      return JSON.parse(value.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

function parseQuestions(rawArguments) {
  const parsed = parseJson(rawArguments)
  const questions = parsed?.questions
  return Array.isArray(questions) ? questions : []
}

function parseAnswers(text) {
  const parsed = parseJson(text)
  const answers = parsed?.answers
  return Array.isArray(answers) ? answers : []
}

/** An answer is a receipt when the user typed "执行" (optionally plus punctuation). */
function isReceiptAnswer(answer) {
  return isReceiptText(answer?.custom)
}

function answerText(answer) {
  const selected = Array.isArray(answer?.selected)
    ? answer.selected.filter((entry) => typeof entry === "string" && entry.trim())
    : []
  const custom = typeof answer?.custom === "string" ? answer.custom.trim() : ""
  const parts = [...selected.map((entry) => entry.trim())]
  if (custom && !isReceiptText(custom)) parts.push(custom)
  return parts.join("；")
}

function indentLines(prefix, text) {
  const [first, ...rest] = String(text).split("\n")
  return [`${prefix}${first}`, ...rest.map((line) => `  ${line}`)]
}

/**
 * Render one ask exchange as Q/A lines, or "" when it must be dropped:
 * unparseable, unanswered, or every answer is an authorisation receipt.
 */
function renderAsk(entry) {
  if (!entry || entry.answers.length === 0) return ""
  if (entry.answers.every(isReceiptAnswer)) return ""
  const lines = []
  for (const question of entry.questions) {
    const answer = entry.answers.find((candidate) => candidate && candidate.id === question.id)
    if (!answer) continue
    const value = answerText(answer)
    if (!value) continue
    lines.push(...indentLines("- Q: ", String(question.question ?? question.header ?? "").trim()))
    lines.push(...indentLines("  A: ", value))
  }
  return lines.join("\n")
}

function keepSegment(segments, segment) {
  const last = segments[segments.length - 1]
  if (last && last.role === segment.role) {
    last.text += "\n\n" + segment.text
    return
  }
  segments.push(segment)
}

/** Render ordered segments into the markdown body written to memory. */
export function renderDigest(segments) {
  const sections = []
  for (const segment of segments) {
    const label = SECTION_LABEL[segment.role]
    if (!label) continue
    sections.push(`## ${label}\n\n${segment.text}`)
  }
  return sections.join("\n\n")
}

/**
 * Extract the decision layer from one ordered batch of session events.
 *
 * @param {readonly object[]} events - session events carrying a numeric `seq`.
 * @param {{afterSeq?: number, toSeq?: number}} [options] - `afterSeq` is the
 *   exclusive cursor (the last already-processed seq); `toSeq` is inclusive.
 * @returns {{markdown: string, segments: object[], stats: object, firstSeq: number|null, lastSeq: number|null}}
 *   `markdown` is "" when the batch holds nothing worth writing.
 */
export function extractDigest(events, options = {}) {
  const afterSeq = Number.isFinite(options.afterSeq) ? options.afterSeq : -Infinity
  const toSeq = Number.isFinite(options.toSeq) ? options.toSeq : Infinity
  const batch = (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event.seq === "number" && event.seq > afterSeq && event.seq <= toSeq)
    .sort((left, right) => left.seq - right.seq)

  // Index ask exchanges first: the question lives on tool/call, the answer on
  // the paired tool/result, and both may be separated by other events.
  const asks = new Map()
  for (const event of batch) {
    if (event.type === "tool/call" && event.data?.name === "ask_user_question") {
      const callId = event.data.callId
      if (typeof callId !== "string" || !callId) continue
      asks.set(callId, {
        callSeq: event.seq,
        questions: parseQuestions(event.data.arguments),
        answers: [],
      })
      continue
    }
    if (event.type === "tool/result") {
      const callId = event.data?.message?.source?.callId
      const entry = typeof callId === "string" ? asks.get(callId) : undefined
      if (!entry) continue
      entry.answers = parseAnswers(textOf(event.data.message.content))
    }
  }

  const segments = []
  let users = 0
  let askCount = 0
  let dropped = 0

  for (const event of batch) {
    if (event.type === "user/message") {
      if (event.data?.source?.kind !== "user") {
        dropped += 1
        continue
      }
      const text = stripReceiptLines(textOf(event.data.content))
      if (!text || isReceiptText(text)) {
        dropped += 1
        continue
      }
      users += 1
      keepSegment(segments, { role: "user", text, seq: event.seq })
      continue
    }
    if (event.type === "assistant/message") {
      const text = textOf(event.data?.message?.content)
      if (!text) {
        dropped += 1
        continue
      }
      keepSegment(segments, { role: "assistant", text, seq: event.seq })
      continue
    }
    if (event.type === "tool/call" && event.data?.name === "ask_user_question") {
      const rendered = renderAsk(asks.get(event.data.callId))
      if (!rendered) {
        dropped += 1
        continue
      }
      askCount += 1
      keepSegment(segments, { role: "ask", text: rendered, seq: event.seq })
      continue
    }
    dropped += 1
  }

  const markdown = renderDigest(segments)
  return {
    markdown,
    segments,
    stats: { events: batch.length, users, asks: askCount, dropped, chars: markdown.length },
    firstSeq: batch.length ? batch[0].seq : null,
    lastSeq: batch.length ? batch[batch.length - 1].seq : null,
  }
}

/** One line of counters, stable enough for a test to assert on. */
export function statsLine(stats) {
  return `events=${stats.events} users=${stats.users} asks=${stats.asks} dropped=${stats.dropped} chars=${stats.chars}`
}
