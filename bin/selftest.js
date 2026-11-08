#!/usr/bin/env node
/**
 * Offline renderer: one saved session log in, the exact markdown this plugin
 * would write out.
 *
 * It touches no host, no network, and no bank — the acceptance checks in the
 * README run entirely through this file.
 *
 *   node bin/selftest.js <session.v4.jsonl.zstd> [--from-seq=N] [--to-seq=N] [--json]
 *
 * Markdown goes to stdout, one stats line to stderr. `--json` prints
 * `{header, stats, markdown}` to stdout instead.
 */

import { readFileSync } from "node:fs"
import { zstdDecompressSync } from "node:zlib"

import { extractDigest, statsLine } from "../src/digest.js"

const USAGE = `usage: node bin/selftest.js <session.v4.jsonl.zstd> [--from-seq=N] [--to-seq=N] [--json]

  --from-seq=N   exclusive cursor: only events with seq > N
  --to-seq=N     inclusive upper bound
  --json         print {header, stats, markdown} as JSON on stdout`

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

function fail(message, code = 1) {
  console.error(`[selftest] ${message}`)
  process.exit(code)
}

function readLog(file) {
  let raw
  try {
    raw = readFileSync(file)
  } catch (error) {
    fail(`cannot read ${file}: ${error.message}`)
  }
  const compressed = raw.length >= 4 && ZSTD_MAGIC.every((byte, index) => raw[index] === byte)
  if (!compressed) return raw.toString("utf8")
  if (typeof zstdDecompressSync !== "function") {
    fail("this Node build lacks zlib.zstdDecompressSync (needs Node >= 22.15)", 2)
  }
  return zstdDecompressSync(raw).toString("utf8")
}

function parseEntries(text) {
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) fail("empty session log")
  const entries = []
  for (let index = 0; index < lines.length; index += 1) {
    try {
      entries.push(JSON.parse(lines[index]))
    } catch {
      fail(`line ${index + 1} is not JSON`)
    }
  }
  const [header, ...events] = entries
  if (header?.type !== "session") fail("first line is not a session header")
  return { header, events }
}

function numberArg(argv, flag) {
  const prefix = `--${flag}=`
  const found = argv.find((argument) => argument.startsWith(prefix))
  if (!found) return undefined
  const value = Number(found.slice(prefix.length))
  if (!Number.isFinite(value)) fail(`--${flag} expects a number`)
  return value
}

const argv = process.argv.slice(2)
const positional = argv.filter((argument) => !argument.startsWith("--"))
if (positional.length !== 1) {
  console.error(USAGE)
  process.exit(2)
}

const { header, events } = parseEntries(readLog(positional[0]))
const withSeq = events.filter((event) => event && typeof event.seq === "number")
const result = extractDigest(withSeq, {
  afterSeq: numberArg(argv, "from-seq"),
  toSeq: numberArg(argv, "to-seq"),
})

if (argv.includes("--json")) {
  console.log(JSON.stringify({
    header: { id: header.id, cwd: header.cwd, createdAt: header.createdAt },
    stats: result.stats,
    markdown: result.markdown,
  }, null, 2))
} else {
  process.stdout.write(result.markdown ? `${result.markdown}\n` : "")
  console.error(`stats: ${statsLine(result.stats)}`)
}
