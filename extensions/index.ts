/**
 * pi-token-cost-ledger — Token & cost ledger for Pi.
 *
 * One extension replaces the former 3-part setup (@ctogg/pi-cost-counter +
 * api-equiv.sh + tokens.zsh). Owns the full lifecycle:
 *
 *   1. CAPTURE — forks @ctogg's message_end hook. Appends one JSONL record
 *      per assistant message to ~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/YYYY/MM/DD.jsonl.
 *      Format is byte-compatible with the existing ledger, so ~20 prior
 *      files are valid day one (zero migration).
 *   2. QUERY   — /usage command. Periods: today | day | week | month |
 *      year | all, plus `model <name>`. Shows BOTH real USD (from the
 *      provider's own cost) AND api-equivalent USD (what the same tokens
 *      cost pay-as-you-go on GLM), because on a flat plan the marginal
 *      cost is $0 and only the API-equiv axis is comparable across vendors.
 *
 * Prices are query-time computed (reprice semantics): history always
 * reflects the current prices.json, never a stale snapshot. The default
 * prices ship as a sibling asset; ~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/prices.json overrides
 * if present (preserves the single-file-edit convention).
 *
 * Multi-root: reads ~/.pi/extensions-data/estebanforge/pi-token-cost-ledger/roots.conf (one path/line, # comments,
 * first = primary write target). Construct sandbox and any other producers
 * are unioned read-only; ledgers are disjoint so no dedup is needed.
 *
 * Record shape (unchanged from @ctogg):
 *   {ts, provider, model,
 *    tokens:{input,output,cacheRead,cacheWrite},
 *    cost:{input,output,cacheRead,cacheWrite,total}}
 */
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

// ── Paths ────────────────────────────────────────────────────────────────────

// Ledger dir lives under the scoped extensions-data convention:
//   ~/.pi/extensions-data/<author>/<extension>/
// Derived from pi's getAgentDir() (~/.pi/agent/, honors PI_CODING_AGENT_DIR),
// so rebranded distros resolve correctly. GitHub-style namespace = collision-proof
// and self-documenting. Capture writes here; prices.json override + roots.conf
// live here too.
function ledgerDir(): string {
	return join(path.dirname(getAgentDir()), "extensions-data", "estebanforge", "pi-token-cost-ledger");
}

// Construct-cli sandbox ledger path. Only meaningful when THIS extension is
// running on the HOST (where a separate sandbox home exists at the fixed path
// below). Inside the sandbox itself, homedir() IS the overlay root, so the
// constant's "construct-cli/home" segment would build a phantom nested path
// (absent → silent skip). We detect host-vs-sandbox by checking whether
// homedir() already points inside a construct overlay; if so, there is no
// separate sandbox to union — return "" (disabled).
const CONSTRUCT_LEDGER = (() => {
	const home = homedir();
	if (home.includes("/construct-cli/home")) return ""; // we ARE the sandbox
	return join(home, ".config", "construct-cli", "home", ".pi", "extensions-data", "estebanforge", "pi-token-cost-ledger");
})();

// ── Types ────────────────────────────────────────────────────────────────────

interface CostRecord {
	ts: number;
	provider: string;
	model: string;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

interface PriceTier {
	i: number; // input per 1M
	c: number; // cache-read per 1M
	o: number; // output per 1M
}

type Prices = Record<string, PriceTier>;

/**
 * Case-insensitive price index. Ledger model strings come from whatever the
 * provider reports (e.g. "MiniMax-M3" mixed case, "mimo-v2.5-pro" lowercase);
 * prices.json keys are canonical lowercase. This index normalizes both sides
 * to lowercase so a casing drift never silently reports $0.00. Built once per
 * query from the loaded Prices.
 */
interface PriceIndex {
	byLower: Map<string, PriceTier>;
}

function buildPriceIndex(prices: Prices): PriceIndex {
	const byLower = new Map<string, PriceTier>();
	for (const [k, v] of Object.entries(prices)) {
		if (k.startsWith("_")) continue; // skip _doc / _refresh / _tier_note meta keys
		byLower.set(k.toLowerCase(), v);
	}
	return { byLower };
}

function lookupPrice(model: string, idx: PriceIndex): PriceTier | undefined {
	return idx.byLower.get((model ?? "").toLowerCase());
}

interface Bucket {
	calls: number;
	tokIn: number;
	tokOut: number;
	tokCache: number;
	tokCacheW: number;
	realUsd: number;
	equivUsd: number;
	unpricedCalls: number; // records whose model had no entry in prices.json
	unpricedTok: number; // tokens from those records (for the warning line)
}

const emptyBucket = (): Bucket => ({
	calls: 0,
	tokIn: 0,
	tokOut: 0,
	tokCache: 0,
	tokCacheW: 0,
	realUsd: 0,
	equivUsd: 0,
	unpricedCalls: 0,
	unpricedTok: 0,
});

// ── Date helpers (all LOCAL time — matches the file-partitioning scheme) ─────

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

function dateParts(d: Date): { year: string; month: string; day: string } {
	return {
		year: String(d.getFullYear()),
		month: pad2(d.getMonth() + 1),
		day: pad2(d.getDate()),
	};
}

/** YYYY-MM-DD local. */
function dayKey(d: Date): string {
	const { year, month, day } = dateParts(d);
	return `${year}-${month}-${day}`;
}

/** YYYY-MM local. */
function monthKey(d: Date): string {
	const { year, month } = dateParts(d);
	return `${year}-${month}`;
}

/** Absolute path to a root's JSONL for a given date. */
function dayFilePath(root: string, d: Date): string {
	const { year, month, day } = dateParts(d);
	return join(root, year, month, `${day}.jsonl`);
}

/** Enumerate local-midnight dates from start to end inclusive. */
function dateRange(start: Date, end: Date): Date[] {
	const out: Date[] = [];
	const cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
	const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
	while (cur <= last) {
		out.push(new Date(cur));
		cur.setDate(cur.getDate() + 1);
	}
	return out;
}

/** Monday (local) of the week containing `d`. getDay: 0=Sun..6=Sat. */
function mondayOf(d: Date): Date {
	const day = d.getDay();
	const diff = day === 0 ? -6 : 1 - day; // back up to Monday
	const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
	m.setDate(m.getDate() + diff);
	return m;
}

// ── Config: prices + roots ───────────────────────────────────────────────────

let _bundledPrices: Prices | null = null;
function loadBundledPrices(): Prices {
	if (_bundledPrices !== null) return _bundledPrices;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		_bundledPrices = JSON.parse(readFileSync(join(here, "prices.json"), "utf8")) as Prices;
	} catch {
		_bundledPrices = {};
	}
	return _bundledPrices;
}

/**
 * Override precedence: <baseDir>/prices.json > bundled default.
 * Refreshed on every query so an edit to the override file takes effect
 * immediately (no reload), matching the old `api-equiv.sh` behavior.
 */
function loadPrices(baseDir: string): Prices {
	try {
		const override = join(baseDir, "prices.json");
		if (existsSync(override)) {
			return JSON.parse(readFileSync(override, "utf8")) as Prices;
		}
	} catch {
		// fall through to bundled
	}
	return loadBundledPrices();
}

/**
 * Ledger roots. Precedence mirrors the old scripts:
 *   PI_COST_LEDGER (single) > PI_COST_LEDGERS (colon-sep) > roots.conf > default
 * First root is PRIMARY (the capture write target + override location).
 * Default unions the base dir with the construct-cli sandbox ledger IF it exists
 * (soft-fail: absent = silent skip, no error). Disjoint ledgers, no dedup.
 */
function loadRoots(): { roots: string[]; primary: string } {
	const baseDir = ledgerDir();
	const envSingle = process.env.PI_COST_LEDGER;
	if (envSingle) return { roots: [envSingle], primary: envSingle };
	const envMulti = process.env.PI_COST_LEDGERS;
	if (envMulti) {
		const roots = envMulti.split(":").filter(Boolean);
		if (roots.length) return { roots, primary: roots[0] };
	}
	const conf = join(baseDir, "roots.conf");
	if (existsSync(conf)) {
		const roots: string[] = [];
		for (const line of readFileSync(conf, "utf8").split("\n")) {
			const trimmed = line.replace(/#.*$/, "").trim();
			if (trimmed) roots.push(trimmed);
		}
		if (roots.length) return { roots, primary: roots[0] };
	}
	// Default: base dir + construct sandbox (auto-detected, soft-fail if absent).
	const roots = existsSync(CONSTRUCT_LEDGER) ? [baseDir, CONSTRUCT_LEDGER] : [baseDir];
	return { roots, primary: baseDir };
}

/** Cache convention, same knob as the old scripts. Default separate. */
function cacheConv(): "separate" | "included" {
	return process.env.CACHE_CONV === "included" ? "included" : "separate";
}

// ── Cost math (ported from api-equiv.sh jq) ──────────────────────────────────

// Cost math is inlined into addRecord below (single price lookup per record).

function addRecord(b: Bucket, r: CostRecord, idx: PriceIndex, conv: "separate" | "included"): void {
	b.calls += 1;
	b.tokIn += r.tokens.input ?? 0;
	b.tokOut += r.tokens.output ?? 0;
	b.tokCache += r.tokens.cacheRead ?? 0;
	b.tokCacheW += r.tokens.cacheWrite ?? 0;
	b.realUsd += r.cost?.total ?? 0;
	// Single price lookup per record (inlined; was two via equivCost + isPriced).
	const tier = lookupPrice(r.model, idx);
	if (tier) {
		const noncached =
			conv === "included" ? Math.max(0, (r.tokens.input ?? 0) - (r.tokens.cacheRead ?? 0)) : r.tokens.input ?? 0;
		b.equivUsd += (noncached * tier.i + (r.tokens.cacheRead ?? 0) * tier.c + (r.tokens.output ?? 0) * tier.o) / 1e6;
	} else {
		b.unpricedCalls += 1;
		b.unpricedTok += (r.tokens.input ?? 0) + (r.tokens.output ?? 0) + (r.tokens.cacheRead ?? 0);
	}
}

// ── Record reading (streaming, across roots, bounded to a date list) ─────────

/** True only if `r` has the shape we can aggregate without crashing. */
function isCostRecord(r: unknown): r is CostRecord {
	if (typeof r !== "object" || r === null) return false;
	const o = r as Record<string, unknown>;
	return (
		typeof o.ts === "number" &&
		typeof o.model === "string" &&
		!!o.tokens &&
		typeof o.tokens === "object"
	);
}

/**
 * Stream records from one JSONL file. Tolerant: malformed lines, unreadable
 * files, and records missing the expected shape are skipped rather than
 * crashing the whole query. Matches the old jq tolerant-of-bad-JSON behavior
 * but also guards against partial/corrupt records (e.g. legacy producers).
 */
async function readRecordsFromFile(file: string, into: CostRecord[]): Promise<void> {
	let stream;
	try {
		stream = createReadStream(file, { encoding: "utf8" });
	} catch {
		return; // unreadable (permissions, etc.) — skip
	}
	const rl = createInterface({ input: stream, crlfDelay: Infinity });
	try {
		for await (const line of rl) {
			const s = line.trim();
			if (!s) continue;
			try {
				const parsed = JSON.parse(s);
				if (isCostRecord(parsed)) into.push(parsed);
			} catch {
				// skip malformed line
			}
		}
	} catch {
		// mid-read failure (file rotated/permissions flipped) — what we have is fine
	} finally {
		stream.destroy();
	}
}

/**
 * Read records whose LOCAL file date is in `dates`. Streams line-by-line to
 * avoid loading huge files into memory. Roots are unioned disjointly.
 */
async function readRecords(roots: string[], dates: Date[]): Promise<CostRecord[]> {
	const targets = new Set<string>();
	for (const root of roots) {
		for (const d of dates) targets.add(dayFilePath(root, d));
	}
	const out: CostRecord[] = [];
	for (const file of targets) {
		if (!existsSync(file)) continue;
		await readRecordsFromFile(file, out);
	}
	return out;
}

/** Read ALL records across roots (for `all` / `model` queries). */
async function readAllRecords(roots: string[]): Promise<CostRecord[]> {
	const files = new Set<string>();
	for (const root of roots) {
		if (!existsSync(root)) continue;
		await collectJsonl(root, files);
	}
	const out: CostRecord[] = [];
	for (const file of files) {
		await readRecordsFromFile(file, out);
	}
	return out;
}

async function collectJsonl(dir: string, into: Set<string>): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const full = join(dir, name);
		// Recurse into dirs; collect *.jsonl files. Symlinks are followed by
		// readdir+stat semantics, which is fine for the ledger layout.
		const st = await stat(full).catch(() => null);
		if (!st) continue;
		if (st.isDirectory()) {
			await collectJsonl(full, into);
		} else if (name.endsWith(".jsonl")) {
			into.add(full);
		}
	}
}

// ── Number formatting ───────────────────────────────────────────────────────
//
// Three styles via the `token-cost-ledger-numbers` flag (env TOKEN_COST_LEDGER_NUMBERS):
//   "auto"    detect from terminal locale (LC_NUMERIC > LC_ALL > LANG), via Intl.
//   "comma"   Latin/European: '.' thousands, ',' decimal  (e.g. $1.148,23)
//   "dot"     Anglo:           ',' thousands, '.' decimal  (e.g. $1,148.23)
// Default "auto" respects each user's locale; override for a fixed style.

/** Resolve LC_ALL/LC_NUMERIC/LANG (POSIX precedence) to an Intl tag, sans codeset. */
function detectLocaleTag(): string {
	// POSIX precedence: LC_ALL overrides everything, then category-specific
	// LC_NUMERIC, then LANG as the default. Empty string is falsy, so an
	// explicit `LC_ALL=` ("use defaults") falls through correctly.
	const raw = process.env.LC_ALL || process.env.LC_NUMERIC || process.env.LANG || "en_US";
	return raw.replace(/\.[A-Za-z0-9-]+$/, "").replace(/_/g, "-");
}

interface NumberStyle {
	group: string; // thousands separator
	decimal: string; // decimal separator
}

/** Detect the terminal's group/decimal separators via Intl + POSIX locale env. */
function detectStyle(): NumberStyle {
	try {
		const parts = new Intl.NumberFormat(detectLocaleTag()).formatToParts(1234567.89);
		const group = parts.find((p) => p.type === "group")?.value ?? ",";
		const decimal = parts.find((p) => p.type === "decimal")?.value ?? ".";
		return { group, decimal };
	} catch {
		return { group: ",", decimal: "." };
	}
}

/** Build a formatter from an explicit style ("comma" | "dot") or a detected one. */
function resolveStyle(setting: "auto" | "comma" | "dot"): NumberStyle {
	if (setting === "comma") return { group: ".", decimal: "," };
	if (setting === "dot") return { group: ",", decimal: "." };
	return detectStyle();
}

/** Format a number with the given style and decimal precision. */
function formatNum(n: number, decimals: number, s: NumberStyle): string {
	const neg = n < 0;
	const fixed = Math.abs(n).toFixed(decimals);
	const [intPart, decPart] = fixed.split(".");
	const intFmt = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, s.group);
	const body = decPart ? `${intFmt}${s.decimal}${decPart}` : intFmt;
	return (neg ? "-" : "") + body;
}

interface Formatter {
	money: (n: number) => string; // USD, 2 decimals
	tok: (n: number) => string; // tokens, K/M suffix
	int: (n: number) => string; // plain count
}

/** Build a formatter for a given style. One per query (cheap). */
function makeFormatter(s: NumberStyle): Formatter {
	return {
		money: (n) => `$${formatNum(n, 2, s)}`,
		tok: (n) => {
			if (n >= 1_000_000) return `${formatNum(n / 1_000_000, 1, s)}M`;
			if (n >= 1_000) return `${formatNum(n / 1_000, 1, s)}K`;
			return formatNum(n, 0, s);
		},
		int: (n) => formatNum(n, 0, s),
	};
}

/** Read the number-style setting: env TOKEN_COST_LEDGER_NUMBERS > flag > "auto". */
function numberStyleSetting(pi: ExtensionAPI): "auto" | "comma" | "dot" {
	const env = process.env.TOKEN_COST_LEDGER_NUMBERS?.trim().toLowerCase();
	if (env === "comma" || env === "dot" || env === "auto") return env;
	const flagVal = (pi.getFlag("token-cost-ledger-numbers") as string | undefined)?.trim().toLowerCase();
	if (flagVal === "comma" || flagVal === "dot" || flagVal === "auto") return flagVal;
	return "auto";
}

// ── Period parsing ───────────────────────────────────────────────────────────

interface Range {
	start: Date;
	end: Date;
	subtotalKey: "day" | "month"; // how to break down within the range
	label: string;
}

function localToday(): Date {
	const n = new Date();
	return new Date(n.getFullYear(), n.getMonth(), n.getDate());
}

function parseRange(args: string): Range | null {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	const now = localToday();
	const kind = parts[0] ?? "today";

	const monthRegex = /^(\d{4})-(\d{2})$/;
	const dateRegex = /^(\d{4})-(\d{2})-(\d{2})$/;
	const yearRegex = /^(\d{4})$/;

	if (kind === "today" || parts.length === 0) {
		return { start: now, end: now, subtotalKey: "day", label: `today (${dayKey(now)})` };
	}
	if (kind === "day") {
		// Parse the YYYY-MM-DD groups ourselves. `new Date("2026-07-19")` would
		// be parsed as UTC midnight, and the local getters used downstream
		// would then shift it to the previous day west of UTC.
		if (parts[1]) {
			const m = parts[1].match(dateRegex);
			if (!m) return null;
			const day = new Date(+m[1], +m[2] - 1, +m[3]);
			return { start: day, end: day, subtotalKey: "day", label: dayKey(day) };
		}
		return { start: now, end: now, subtotalKey: "day", label: dayKey(now) };
	}
	if (kind === "week") {
		const n = parts[1] ? parseInt(parts[1], 10) : 0;
		if (isNaN(n) || n < 0) return null;
		const mon = mondayOf(now);
		mon.setDate(mon.getDate() - n * 7);
		const sun = new Date(mon);
		sun.setDate(mon.getDate() + 6);
		return { start: mon, end: sun, subtotalKey: "day", label: `week (${dayKey(mon)} → ${dayKey(sun)})` };
	}
	if (kind === "month") {
		let y = now.getFullYear();
		let m = now.getMonth();
		if (parts[1]) {
			// Validate the month component is 01-12, not just digit shape.
			const mt = parts[1].match(monthRegex);
			if (!mt) return null;
			y = +mt[1]; m = +mt[2] - 1;
			if (m < 0 || m > 11) return null;
		}
		const start = new Date(y, m, 1);
		const end = new Date(y, m + 1, 0);
		return { start, end, subtotalKey: "day", label: `${y}-${pad2(m + 1)}` };
	}
	if (kind === "year") {
		const y = parts[1] && yearRegex.test(parts[1]) ? parseInt(parts[1], 10) : now.getFullYear();
		return {
			start: new Date(y, 0, 1),
			end: new Date(y, 11, 31),
			subtotalKey: "month",
			label: String(y),
		};
	}
	if (kind === "all") {
		// Sentinel handled by the caller via readAllRecords (directory walk).
		// No date range is materialized here, so there's no hardcoded floor year
		// pretending to be "all history".
		return { start: now, end: now, subtotalKey: "month", label: "all history" };
	}
	return null;
}

// ── Aggregation ──────────────────────────────────────────────────────────────

interface Aggregate {
	total: Bucket;
	byModel: Map<string, Bucket>;
	byPeriod: Map<string, Bucket>; // keyed by day or month
}

function aggregate(records: CostRecord[], idx: PriceIndex, conv: "separate" | "included", subtotalKey: "day" | "month"): Aggregate {
	const total = emptyBucket();
	const byModel = new Map<string, Bucket>();
	const byPeriod = new Map<string, Bucket>();
	for (const r of records) {
		addRecord(total, r, idx, conv);
		const mk = r.model ?? "unknown";
		if (!byModel.has(mk)) byModel.set(mk, emptyBucket());
		addRecord(byModel.get(mk)!, r, idx, conv);
		const d = new Date(r.ts);
		const pk = subtotalKey === "day" ? dayKey(d) : monthKey(d);
		if (!byPeriod.has(pk)) byPeriod.set(pk, emptyBucket());
		addRecord(byPeriod.get(pk)!, r, idx, conv);
	}
	return { total, byModel, byPeriod };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderTable(theme: Theme, range: Range, agg: Aggregate, conv: "separate" | "included", fmt: Formatter): string {
	const bold = theme.bold.bind(theme);
	const fg = theme.fg.bind(theme);
	const pad = (s: string, n: number) => s.padEnd(n);

	const lines: string[] = [];
	lines.push(bold(fg("accent", `Token usage — ${range.label}`)));
	lines.push(fg("dim", `  cache convention: ${conv} (input ${conv === "included" ? "includes" : "excludes"} cacheRead)`));
	lines.push("");

	const tokTotal = agg.total.tokIn + agg.total.tokOut + agg.total.tokCache + agg.total.tokCacheW;
	lines.push(
		`  ${fg("success", "Total")}: ${bold(fmt.money(agg.total.realUsd))} real  ·  ${bold(
			fmt.money(agg.total.equivUsd),
		)} api-equiv   ${fg("dim", `${fmt.tok(tokTotal)} tok · ${fmt.int(agg.total.calls)} calls`)}`,
	);
	lines.push("");

	// By model
	if (agg.byModel.size > 0) {
		lines.push(fg("accent", "  By model"));
		lines.push(fg("dim", "  " + "─".repeat(64)));
		const models = [...agg.byModel.entries()].sort((a, b) => b[1].equivUsd + b[1].realUsd - (a[1].equivUsd + a[1].realUsd));
		for (const [model, b] of models) {
			const mt = b.tokIn + b.tokOut + b.tokCache + b.tokCacheW;
			lines.push(
				`  ${fg("dim", pad(model, 26))} ${bold(pad(fmt.money(b.realUsd), 8))} · ${pad(
					fmt.money(b.equivUsd),
					8,
				)}  ${fg("dim", `${fmt.tok(mt)} tok · ${fmt.int(b.calls)}`)}`,
			);
		}
		lines.push("");
	}

	// By period (skip when the range is a single day — redundant with the total)
	const periods = [...agg.byPeriod.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
	if (periods.length > 1) {
		lines.push(fg("accent", `  By ${range.subtotalKey}`));
		lines.push(fg("dim", "  " + "─".repeat(64)));
		for (const [key, b] of periods) {
			const mt = b.tokIn + b.tokOut + b.tokCache + b.tokCacheW;
			lines.push(
				`  ${fg("dim", pad(key, 26))} ${bold(pad(fmt.money(b.realUsd), 8))} · ${pad(
					fmt.money(b.equivUsd),
					8,
				)}  ${fg("dim", `${fmt.tok(mt)} tok · ${fmt.int(b.calls)}`)}`,
			);
		}
		lines.push("");
	}

	if (agg.total.calls === 0) {
		lines.push(fg("dim", "  No usage recorded for this period."));
	} else if (agg.total.unpricedCalls > 0) {
		lines.push(
			fg("warning", `  ⚠ ${fmt.int(agg.total.unpricedCalls)} calls (${fmt.tok(agg.total.unpricedTok)} tok) had no price entry — shown as ${fmt.money(0)} api-equiv`),
		);
	}
	return lines.join("\n");
}

function renderModel(theme: Theme, modelName: string, records: CostRecord[], idx: PriceIndex, conv: "separate" | "included", fmt: Formatter): string {
	const bold = theme.bold.bind(theme);
	const fg = theme.fg.bind(theme);

	// Case-insensitive match so a typo or casing drift doesn't silently miss.
	const want = modelName.toLowerCase();
	const filtered = records.filter((r) => (r.model ?? "unknown").toLowerCase() === want);
	const agg = aggregate(filtered, idx, conv, "month");
	const lines: string[] = [];
	lines.push(bold(fg("accent", `Token usage — model: ${modelName}`)));
	lines.push("");
	if (filtered.length === 0) {
		// Suggest the distinct model names that DO exist, so a typo is obvious.
		const known = [...new Set(records.map((r) => r.model ?? "unknown"))].sort();
		lines.push(fg("dim", `  No records for model "${modelName}".`));
		lines.push(fg("dim", `  Known models: ${known.join(", ")}`));
		return lines.join("\n");
	}
	// Reuse the table, but force a per-month breakdown regardless.
	const tokTotal = agg.total.tokIn + agg.total.tokOut + agg.total.tokCache + agg.total.tokCacheW;
	lines.push(
		`  ${fg("success", "Total")}: ${bold(fmt.money(agg.total.realUsd))} real  ·  ${bold(
			fmt.money(agg.total.equivUsd),
		)} api-equiv   ${fg("dim", `${fmt.tok(tokTotal)} tok · ${fmt.int(agg.total.calls)} calls`)}`,
	);
	lines.push("");
	const periods = [...agg.byPeriod.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
	if (periods.length > 0) {
		lines.push(fg("accent", "  By month"));
		lines.push(fg("dim", "  " + "─".repeat(64)));
		for (const [key, b] of periods) {
			const mt = b.tokIn + b.tokOut + b.tokCache + b.tokCacheW;
			lines.push(
				`  ${fg("dim", key.padEnd(26))} ${bold(fmt.money(b.realUsd).padStart(8))} · ${fmt.money(b.equivUsd).padStart(
					8,
				)}  ${fg("dim", `${fmt.tok(mt)} tok · ${fmt.int(b.calls)}`)}`,
			);
		}
	}
	return lines.join("\n");
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Register the number-style flag at factory load time. registerFlag is static
	// setup; calling it per session would clobber user preferences on every /new
	// or /reload. Values: "auto" (default) | "comma" | "dot".
	pi.registerFlag("token-cost-ledger-numbers", {
		description:
			"Number format for /usage reports: \"auto\" (detect from terminal locale, default) | \"comma\" (1.148,23) | \"dot\" (1,148.23).",
		type: "string",
		default: "auto",
	});

	// ── OPTIONS: /token-cost-ledger — status panel + set the number-style flag ───
	const NUMBER_STYLES = ["auto", "comma", "dot"] as const;
	type NumberStyleName = (typeof NUMBER_STYLES)[number];
	const STYLE_SAMPLES: Record<NumberStyleName, string> = {
		auto: "locale-detected",
		comma: "1.148,23",
		dot: "1,148.23",
	};

	function renderStatusPanel(): string {
		const current = numberStyleSetting(pi);
		const lines = [
			"pi-token-cost-ledger — options",
			"",
			"  number format (token-cost-ledger-numbers):",
			...NUMBER_STYLES.map(
				(s) => `    ${current === s ? "[x]" : "[ ]"} ${s.padEnd(8)} ${STYLE_SAMPLES[s]}`,
			),
			"",
			"  set:    /token-cost-ledger <auto|comma|dot>",
			"  also:   pi config set token-cost-ledger-numbers <value>",
			"  env:    TOKEN_COST_LEDGER_NUMBERS=<value> (per-session)",
		];
		return lines.join("\n");
	}

	pi.registerCommand("token-cost-ledger", {
		description:
			"pi-token-cost-ledger options: show status, or set number format. Usage: /token-cost-ledger [auto|comma|dot]",
		getArgumentCompletions: (prefix: string) => {
			const trailingSpace = /\s$/.test(prefix);
			const tokens = prefix.trim().split(/\s+/).filter(Boolean);
			const partial = trailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
			// After `set` (with space or partial value), suggest values; else suggest
			// `set` + bare values as shorthand.
			const setComplete =
				(tokens.length === 1 && tokens[0] === "set") ||
				(tokens.length >= 2 && tokens[0] === "set");
			if (setComplete || tokens.length <= 1) {
				const hits = (setComplete ? NUMBER_STYLES : (["set", ...NUMBER_STYLES] as const)).filter((v) =>
					v.startsWith(partial),
				);
				return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim().toLowerCase();
			// Bare / status → show the panel.
			if (trimmed === "" || trimmed === "status") {
				ctx.ui.notify(renderStatusPanel(), "info");
				return;
			}
			// `/token-cost-ledger set <value>` or shorthand `/token-cost-ledger <value>`.
			const tokens = trimmed.split(/\s+/).filter(Boolean);
			const value = tokens[0] === "set" ? tokens[1] : tokens[0];
			if (!value || !NUMBER_STYLES.includes(value as NumberStyleName)) {
				ctx.ui.notify(
					`Unknown value "${value ?? ""}". Valid: ${NUMBER_STYLES.join(", ")}.`,
					"warning",
				);
				return;
			}
			const current = numberStyleSetting(pi);
			const result = await pi.exec("pi", ["config", "set", "token-cost-ledger-numbers", value]);
			if (result.code !== 0) {
				ctx.ui.notify(
					`Failed to set token-cost-ledger-numbers: ${result.stderr.trim() || `exit ${result.code}`}`,
					"error",
				);
				return;
			}
			ctx.ui.notify(`token-cost-ledger-numbers: ${current} → ${value}. Reloading...`, "info");
			await ctx.reload();
		},
	});

	// ── CAPTURE: append one record per assistant message (forks @ctogg) ──────
	// Best-effort: a logging side-channel must never break the chat session,
	// so any fs error (ENOSPC, EACCES, race) is swallowed.
	pi.on("message_end", async (event, _ctx) => {
		try {
			const msg = event.message as { role?: string; usage?: any; provider?: string; model?: string };
			if (msg.role !== "assistant") return;
			const usage = msg.usage;
			if (!usage?.cost) return;

			// Coerce to number; a provider returning a string field would otherwise
			// silently corrupt downstream sums via string concatenation.
			const num = (v: unknown) => (typeof v === "number" ? v : 0);

			const record: CostRecord = {
				ts: Date.now(),
				provider: msg.provider ?? "unknown",
				model: msg.model ?? "unknown",
				tokens: {
					input: num(usage.input),
					output: num(usage.output),
					cacheRead: num(usage.cacheRead),
					cacheWrite: num(usage.cacheWrite),
				},
				cost: {
					input: num(usage.cost.input),
					output: num(usage.cost.output),
					cacheRead: num(usage.cost.cacheRead),
					cacheWrite: num(usage.cost.cacheWrite),
					total: num(usage.cost.total),
				},
			};

			const { primary } = loadRoots();
			const file = dayFilePath(primary, new Date());
			await mkdir(path.dirname(file), { recursive: true });
			// O_APPEND makes a single-line write atomic under POSIX; concurrent
			// host writers (two pi tabs) are safe as long as each record is one
			// write(2) under PIPE_BUF, which a JSON line is.
			await appendFile(file, JSON.stringify(record) + "\n", "utf8");
		} catch (err) {
			// Swallow: never let the cost logger disrupt the chat. Logged to stderr
			// (not the pi UI) so a recurring failure is visible without being noisy.
			console.error("pi-token-cost-ledger: capture failed:", err instanceof Error ? err.message : err);
		}
	});

	// ── QUERY: /usage [today|day|week|month|year|all|model <name>] ──────────
	pi.registerCommand("usage", {
		description:
			"Token & cost usage. /usage [today|day [YYYY-MM-DD]|week [N]|month [YYYY-MM]|year [YYYY]|all|model <name>]. Shows real USD and api-equiv USD.",
		handler: async (args, ctx) => {
			const { roots, primary } = loadRoots();
			const prices = loadPrices(primary);
			const idx = buildPriceIndex(prices);
			const conv = cacheConv();
			const fmt = makeFormatter(resolveStyle(numberStyleSetting(pi)));

			const a = (args ?? "").trim();
			const parts = a.split(/\s+/).filter(Boolean);

			// model <name> — special path: scan all history for one model.
			if (parts[0] === "model" && parts[1]) {
				const all = await readAllRecords(roots);
				ctx.ui.notify(renderModel(ctx.ui.theme, parts.slice(1).join(" "), all, idx, conv, fmt), "info");
				return;
			}

			const range = parseRange(a);
			if (!range) {
				ctx.ui.notify(
					`Usage: /usage [today | day [YYYY-MM-DD] | week [N] | month [YYYY-MM] | year [YYYY] | all | model <name>]\nconv: ${conv}`,
					"warning",
				);
				return;
			}

			const dates = dateRange(range.start, range.end);
			// `all` walks the ledger directory instead of materializing a multi-year
			// date range. The sentinel start/end is ignored.
			const records = parts[0] === "all" ? await readAllRecords(roots) : await readRecords(roots, dates);
			const agg = aggregate(records, idx, conv, range.subtotalKey);
			ctx.ui.notify(renderTable(ctx.ui.theme, range, agg, conv, fmt), "info");
		},
	});
}
