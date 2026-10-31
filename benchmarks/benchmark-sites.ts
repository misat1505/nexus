/**
 * Lighthouse benchmark for multiple sites x multiple profiles (CPU / network).
 *
 * Build and run: pnpm benchmark:sites
 * List the plan: pnpm benchmark:sites:list
 * After building: node ./dist/benchmark-sites.js [options]
 *
 * Options:
 *   --site a,b        only the selected site IDs
 *   --render csr,ssg  only the selected rendering methods
 *   --profile x,y     only the selected profile IDs
 *   --iterations N    number of measurements (default: 10)
 *   --warmup N        number of warm-up runs (default: 2)
 *   --resume <runId>  resume an interrupted run (skips pairs that have already been saved)
 *   --list            print the plan and exit
 */

import { launch } from "chrome-launcher";
import fs from "fs/promises";
import lighthouse, { type Flags } from "lighthouse";
import path from "path";
import { importantMetrics, outputDir } from "./constants";
import type { MetricKey, MetricResult } from "./types";

const RENDER_MODES = ["csr", "ssr", "ssg"] as const;
type RenderMode = (typeof RENDER_MODES)[number];

interface SiteConfig {
	id: string;
	url: string;
	renderMode: RenderMode;
	headers?: Record<string, string>;
}

const SITES: SiteConfig[] = [
	{ id: "linkup-next", url: "https://linkup-web-next.vercel.app", renderMode: "ssg" },
	{ id: "linkup-frontend", url: "https://linkup-frontend-xaom.onrender.com/", renderMode: "csr" },
	{ id: "linea-csr", url: "https://linea.demo.commercengine.com", renderMode: "csr" },
	{ id: "linea-next", url: "https://linea-next.demo.commercengine.com", renderMode: "ssg" },
	{ id: "pokedex-csr", url: "https://pokedexwnext.netlify.app/csr", renderMode: "csr" },
	{ id: "pokedex-ssr", url: "https://pokedexwnext.netlify.app/ssr", renderMode: "ssr" },
	{ id: "pokedex-ssg", url: "https://pokedexwnext.netlify.app/ssg", renderMode: "ssg" },
	{
		id: "react-router-ssr",
		url: "https://react-router-mix-render-template.edgeone.app/ssr",
		renderMode: "ssr",
	},
	{
		id: "react-router-csr",
		url: "https://react-router-mix-render-template.edgeone.app/csr",
		renderMode: "csr",
	},
];

const DEFAULT_WARMUP_RUNS = 2;
const DEFAULT_MEASURED_RUNS = 10;

const NETWORK_RTT_MS = 20;

const FORM_FACTOR = "desktop" as const;
const SCREEN = {
	mobile: false,
	width: 1920,
	height: 1080,
	deviceScaleFactor: 1,
	disabled: false,
};

const MAX_WAIT_MS = 300_000;

type NetworkId = "100mbps" | "10mbps" | "1mbps" | "100kbps";
type ProfileGroup = "baseline" | "cpu" | "network" | "combined";

const NETWORKS: Record<NetworkId, { label: string; kbps: number }> = {
	"100mbps": { label: "100 Mbps", kbps: 100_000 },
	"10mbps": { label: "10 Mbps", kbps: 10_000 },
	"1mbps": { label: "1 Mbps", kbps: 1_000 },
	"100kbps": { label: "100 kbps", kbps: 100 },
};

interface SiteProfile {
	id: string;
	label: string;
	group: ProfileGroup;
	description: string;
	cpuSlowdownMultiplier: number;
	network: {
		id: NetworkId;
		label: string;
		rttMs: number;
		downloadThroughputKbps: number;
		uploadThroughputKbps: number;
	};
}

function makeProfile(
	cpu: number,
	networkId: NetworkId,
	group: ProfileGroup,
	description: string,
): SiteProfile {
	const network = NETWORKS[networkId];
	return {
		id: `cpu${cpu}x-net${networkId}`,
		label: `${cpu}x CPU, ${network.label}`,
		group,
		description,
		cpuSlowdownMultiplier: cpu,
		network: {
			id: networkId,
			label: network.label,
			rttMs: NETWORK_RTT_MS,
			downloadThroughputKbps: network.kbps,
			uploadThroughputKbps: network.kbps,
		},
	};
}

const PROFILES: SiteProfile[] = [
	// Best-case scenario (baseline).
	makeProfile(1, "100mbps", "baseline", "Baseline: no CPU slowdown, 100 Mbps"),

	// CPU only (100 Mbps network).
	makeProfile(2, "100mbps", "cpu", "CPU only: 2x slowdown, 100 Mbps"),
	makeProfile(3, "100mbps", "cpu", "CPU only: 3x slowdown, 100 Mbps"),
	makeProfile(4, "100mbps", "cpu", "CPU only: 4x slowdown, 100 Mbps"),
	makeProfile(6, "100mbps", "cpu", "CPU only: 6x slowdown, 100 Mbps"),

	// Network only (CPU 1x).
	makeProfile(1, "10mbps", "network", "Network only: 10 Mbps, no CPU slowdown"),
	makeProfile(1, "1mbps", "network", "Network only: 1 Mbps, no CPU slowdown"),
	makeProfile(1, "100kbps", "network", "Network only: 100 kbps, no CPU slowdown"),

	// Combined CPU and network throttling.
	makeProfile(2, "10mbps", "combined", "Combined: 2x CPU + 10 Mbps"),
	makeProfile(3, "1mbps", "combined", "Combined: 3x CPU + 1 Mbps"),
	makeProfile(4, "100kbps", "combined", "Combined: 4x CPU + 100 kbps"),
];

interface MetricStats {
	n: number;
	mean: number | null;
	median: number | null;
	stddev: number | null;
	min: number | null;
	max: number | null;
}

type ProfileStats = Record<MetricKey, MetricStats>;

interface RunRecord {
	index: number;
	ok: boolean;
	durationMs: number;
	finalUrl: string | null;
	redirected: boolean;
	metrics: Record<MetricKey, MetricResult> | null;
	error: string | null;
}

interface PairResult {
	schemaVersion: 1;
	runId: string;
	generatedAt: string;
	site: { id: string; url: string; renderMode: RenderMode };
	profile: SiteProfile;
	settings: {
		warmupRuns: number;
		measuredRuns: number;
		formFactor: string;
		screen: typeof SCREEN;
		throttlingMethod: string;
	};
	environment: { lighthouseVersion: string | null; userAgent: string | null };
	durationMs: number;
	stats: ProfileStats;
	runs: RunRecord[];
}

type Lhr = NonNullable<Awaited<ReturnType<typeof lighthouse>>>["lhr"];
type SummaryRow = Record<string, string | number | boolean | null>;

type Args = Record<string, string | true>;

function parseArgs(argv: string[]): Args {
	const out: Args = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg || !arg.startsWith("--")) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next === undefined || next.startsWith("--")) {
			out[key] = true;
		} else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

function csvList(v: string | true | undefined): string[] | null {
	if (typeof v !== "string") return null;
	return v
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

function intArg(v: string | true | undefined, fallback: number): number {
	if (v === undefined || v === true) return fallback;
	const n = parseInt(v, 10);
	if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid number: ${v}`);
	return n;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const round2 = (n: number): number => Math.round(n * 100) / 100;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const pad = (s: string, width: number) => (s.length >= width ? s : s + " ".repeat(width - s.length));

function calcStats(values: number[]): MetricStats {
	if (values.length === 0) {
		return { n: 0, mean: null, median: null, stddev: null, min: null, max: null };
	}
	const n = values.length;
	const mean = values.reduce((a, b) => a + b, 0) / n;
	const stddev = Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
	const sorted = [...values].sort((a, b) => a - b);
	const at = (i: number) => sorted[i] as number;
	const mid = Math.floor(n / 2);
	const median = n % 2 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
	return {
		n,
		mean: round2(mean),
		median: round2(median),
		stddev: round2(stddev),
		min: round2(at(0)),
		max: round2(at(n - 1)),
	};
}

function aggregate(runs: RunRecord[]): ProfileStats {
	const stats = {} as ProfileStats;
	for (const metric of importantMetrics) {
		const values: number[] = [];
		for (const run of runs) {
			if (!run.ok || !run.metrics) continue;
			const v = run.metrics[metric].value;
			if (v !== null) values.push(v);
		}
		stats[metric] = calcStats(values);
	}
	return stats;
}

const normalizeUrl = (u: string) => u.replace(/\/+$/, "");

function fmtMs(v: number | null | undefined): string {
	if (v === null || v === undefined) return "-";
	return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${Math.round(v)}ms`;
}

function banner(text: string, char = "─") {
	const width = 78;
	const padLen = Math.max(0, width - text.length - 2);
	const left = Math.floor(padLen / 2);
	console.log(`\n${char.repeat(left)} ${text} ${char.repeat(padLen - left)}`);
}

async function exists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

function buildFlags(port: number, profile: SiteProfile, site: SiteConfig): Flags {
	const { network } = profile;
	return {
		port,
		output: "json",
		logLevel: "error",
		onlyAudits: [...importantMetrics],
		formFactor: FORM_FACTOR,
		screenEmulation: SCREEN,
		throttlingMethod: "devtools",
		throttling: {
			rttMs: network.rttMs,
			requestLatencyMs: network.rttMs,
			throughputKbps: network.downloadThroughputKbps,
			downloadThroughputKbps: network.downloadThroughputKbps,
			uploadThroughputKbps: network.uploadThroughputKbps,
			cpuSlowdownMultiplier: profile.cpuSlowdownMultiplier,
		},
		maxWaitForLoad: MAX_WAIT_MS,
		maxWaitForFcp: MAX_WAIT_MS,
		...(site.headers ? { extraHeaders: site.headers } : {}),
	};
}

async function runLighthouseOnce(url: string, flags: Flags): Promise<Lhr> {
	const result = await lighthouse(url, flags);
	if (!result) throw new Error("Lighthouse did not return a result");
	const { lhr } = result;
	if (lhr.runtimeError) {
		throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
	}
	return lhr;
}

function extractMetrics(lhr: Lhr): Record<MetricKey, MetricResult> {
	const metrics = {} as Record<MetricKey, MetricResult>;
	for (const metric of importantMetrics) {
		const audit = lhr.audits[metric];
		metrics[metric] = {
			value: audit?.numericValue ?? null,
			display: audit?.displayValue ?? null,
			score: audit?.score ?? null,
		};
	}
	return metrics;
}

interface Measurement {
	environment: PairResult["environment"];
	durationMs: number;
	runs: RunRecord[];
	stats: ProfileStats;
}

async function measure(
	site: SiteConfig,
	profile: SiteProfile,
	warmupRuns: number,
	measuredRuns: number,
): Promise<Measurement> {
	const chrome = await launch({ chromeFlags: ["--headless=new"] });
	const flags = buildFlags(chrome.port, profile, site);
	const start = performance.now();
	const runs: RunRecord[] = [];
	let environment: PairResult["environment"] = { lighthouseVersion: null, userAgent: null };

	try {
		if (warmupRuns > 0) console.log(`   warm-up (${warmupRuns})...`);
		for (let i = 0; i < warmupRuns; i++) {
			try {
				await runLighthouseOnce(site.url, flags);
			} catch (e) {
				console.warn(`   ⚠️  warm-up ${i + 1} failed: ${errMsg(e)}`);
			}
		}

		for (let i = 0; i < measuredRuns; i++) {
			const runStart = performance.now();
			process.stdout.write(`   measurement ${i + 1}/${measuredRuns}...`);
			try {
				const lhr = await runLighthouseOnce(site.url, flags);
				environment = {
					lighthouseVersion: lhr.lighthouseVersion,
					userAgent: lhr.environment?.hostUserAgent ?? null,
				};
				const finalUrl = lhr.finalDisplayedUrl ?? null;
				const redirected = finalUrl !== null && normalizeUrl(finalUrl) !== normalizeUrl(site.url);
				const elapsedS = (performance.now() - runStart) / 1000;
				process.stdout.write(
					` ${elapsedS.toFixed(1)}s  LCP ${fmtMs(lhr.audits["largest-contentful-paint"]?.numericValue)}` +
						`${redirected ? `  ⚠️ redirect → ${finalUrl}` : ""}\n`,
				);
				runs.push({
					index: i + 1,
					ok: true,
					durationMs: Math.round(performance.now() - runStart),
					finalUrl,
					redirected,
					metrics: extractMetrics(lhr),
					error: null,
				});
			} catch (e) {
				process.stdout.write(` ❌ ${errMsg(e)}\n`);
				runs.push({
					index: i + 1,
					ok: false,
					durationMs: Math.round(performance.now() - runStart),
					finalUrl: null,
					redirected: false,
					metrics: null,
					error: errMsg(e),
				});
			}
		}
	} finally {
		await chrome.kill();
		await sleep(500);
	}

	return {
		environment,
		durationMs: Math.round(performance.now() - start),
		runs,
		stats: aggregate(runs),
	};
}

function csvCell(v: string | number | boolean | null | undefined): string {
	if (v === null || v === undefined) return "";
	const s = String(v);
	return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildSummaryRows(results: PairResult[]): SummaryRow[] {
	return results.map((r) => {
		const row: SummaryRow = {
			renderMode: r.site.renderMode,
			siteId: r.site.id,
			url: r.site.url,
			profileId: r.profile.id,
			profileGroup: r.profile.group,
			cpuSlowdownMultiplier: r.profile.cpuSlowdownMultiplier,
			downloadThroughputKbps: r.profile.network.downloadThroughputKbps,
			runsOk: r.runs.filter((x) => x.ok).length,
			runsFailed: r.runs.filter((x) => !x.ok).length,
			redirected: r.runs.some((x) => x.redirected),
		};
		for (const metric of importantMetrics) {
			const s = r.stats[metric];
			row[`${metric}.mean`] = s.mean;
			row[`${metric}.median`] = s.median;
			row[`${metric}.stddev`] = s.stddev;
		}
		return row;
	});
}

async function writeSummary(runDir: string, results: PairResult[]) {
	const rows = buildSummaryRows(results);
	await fs.writeFile(path.join(runDir, "summary.json"), JSON.stringify(rows, null, 2), "utf-8");
	const first = rows[0];
	if (!first) return;
	const columns = Object.keys(first);
	const lines = [
		columns.join(","),
		...rows.map((row) => columns.map((c) => csvCell(row[c])).join(",")),
	];
	await fs.writeFile(path.join(runDir, "summary.csv"), lines.join("\n") + "\n", "utf-8");
}

function printLcpTable(results: PairResult[], sites: SiteConfig[], profiles: SiteProfile[]) {
	banner("LCP (mean) — sites x profiles", "═");
	const rows: Record<string, Record<string, string>> = {};
	for (const site of sites) {
		const row: Record<string, string> = {};
		for (const profile of profiles) {
			const r = results.find((x) => x.site.id === site.id && x.profile.id === profile.id);
			row[profile.id] = r ? fmtMs(r.stats["largest-contentful-paint"].mean) : "-";
		}
		rows[`${site.id} [${site.renderMode}]`] = row;
	}
	console.table(rows);
}

function validateConfig() {
	const ids = new Set<string>();
	for (const site of SITES) {
		if (!/^[a-z0-9-]+$/.test(site.id)) throw new Error(`Invalid site ID: "${site.id}"`);
		if (ids.has(site.id)) throw new Error(`Duplicate site ID: "${site.id}"`);
		ids.add(site.id);
		if (!RENDER_MODES.includes(site.renderMode)) {
			throw new Error(`Site "${site.id}": unknown renderMode "${site.renderMode}"`);
		}
		new URL(site.url);
	}
	const profileIds = new Set<string>();
	for (const p of PROFILES) {
		if (profileIds.has(p.id)) throw new Error(`Duplicate profile ID: "${p.id}"`);
		profileIds.add(p.id);
	}
}

function pickByIds<T extends { id: string }>(all: T[], wanted: string[] | null, what: string): T[] {
	if (!wanted) return all;
	const known = new Set(all.map((x) => x.id));
	const unknown = wanted.filter((w) => !known.has(w));
	if (unknown.length > 0) {
		throw new Error(`Unknown ${what}: ${unknown.join(", ")}\nAvailable: ${[...known].join(", ")}`);
	}
	return all.filter((x) => wanted.includes(x.id));
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	validateConfig();

	const warmupRuns = intArg(args["warmup"], DEFAULT_WARMUP_RUNS);
	const measuredRuns = intArg(args["iterations"], DEFAULT_MEASURED_RUNS);

	let sites = pickByIds(SITES, csvList(args["site"]), "sites");
	const renderFilter = csvList(args["render"]);
	if (renderFilter) {
		const bad = renderFilter.filter((m) => !(RENDER_MODES as readonly string[]).includes(m));
		if (bad.length > 0) throw new Error(`Unknown renderMode: ${bad.join(", ")}`);
		sites = sites.filter((s) => renderFilter.includes(s.renderMode));
	}
	const profiles = pickByIds(PROFILES, csvList(args["profiles"]), "profiles");

	if (sites.length === 0 || profiles.length === 0) {
		throw new Error("No sites or profiles remain after applying the filters.");
	}

	const totalPairs = sites.length * profiles.length;

	if (args["list"]) {
		console.log(`Sites (${sites.length}):`);
		for (const s of sites) console.log(`  - ${pad(s.id, 18)} ${pad(s.renderMode, 4)} ${s.url}`);
		console.log(`\nProfiles (${profiles.length}):`);
		for (const p of profiles) console.log(`  - ${pad(p.id, 22)} [${p.group}] ${p.description}`);
		console.log(
			`\n${totalPairs} pairs x (${warmupRuns} warm-ups + ${measuredRuns} measurements) = ${
				totalPairs * (warmupRuns + measuredRuns)
			} Lighthouse runs`,
		);
		return;
	}

	const resumeArg = args["resume"];
	const isResume = typeof resumeArg === "string";
	const runId = isResume ? resumeArg : new Date().toISOString().replace(/[:.]/g, "-");
	const runDir = path.join(outputDir, "lighthouse-runs", runId);
	if (isResume && !(await exists(runDir))) throw new Error(`Run to resume not found: ${runDir}`);
	await fs.mkdir(runDir, { recursive: true });

	const manifestPath = path.join(runDir, "manifest.json");
	if (!(await exists(manifestPath))) {
		await fs.writeFile(
			manifestPath,
			JSON.stringify(
				{
					schemaVersion: 1,
					runId,
					startedAt: new Date().toISOString(),
					node: process.version,
					warmupRuns,
					measuredRuns,
					formFactor: FORM_FACTOR,
					screen: SCREEN,
					networkRttMs: NETWORK_RTT_MS,
					throttlingMethod: "devtools",
					metrics: importantMetrics,
					sites: sites.map(({ id, url, renderMode }) => ({ id, url, renderMode })),
					profiles,
				},
				null,
				2,
			),
			"utf-8",
		);
	}

	banner(
		`🚀 Lighthouse multi-site | ${sites.length} sites x ${profiles.length} profiles | ${warmupRuns}+${measuredRuns} runs`,
		"═",
	);
	console.log(`Run: ${runId}\nResults: ${runDir}\nStarted: ${new Date().toLocaleTimeString()}`);

	const totalStart = performance.now();
	const results: PairResult[] = [];
	let pairIndex = 0;

	for (const site of sites) {
		for (const profile of profiles) {
			pairIndex++;
			const outDir = path.join(runDir, site.renderMode, site.id);
			const outFile = path.join(outDir, `${profile.id}.json`);

			banner(`[${pairIndex}/${totalPairs}] ${site.id} (${site.renderMode}) · ${profile.label}`, "·");

			if (await exists(outFile)) {
				console.log("   ⏭️  already measured — skipping (loading result)");
				results.push(JSON.parse(await fs.readFile(outFile, "utf-8")) as PairResult);
				continue;
			}

			console.log(`   ${site.url}\n   ${profile.description}`);
			const m = await measure(site, profile, warmupRuns, measuredRuns);

			const result: PairResult = {
				schemaVersion: 1,
				runId,
				generatedAt: new Date().toISOString(),
				site: { id: site.id, url: site.url, renderMode: site.renderMode },
				profile,
				settings: {
					warmupRuns,
					measuredRuns,
					formFactor: FORM_FACTOR,
					screen: SCREEN,
					throttlingMethod: "devtools",
				},
				environment: m.environment,
				durationMs: m.durationMs,
				stats: m.stats,
				runs: m.runs,
			};

			await fs.mkdir(outDir, { recursive: true });
			await fs.writeFile(outFile, JSON.stringify(result, null, 2), "utf-8");
			results.push(result);

			const s = m.stats;
			console.log(
				`   ✅ ok ${m.runs.filter((r) => r.ok).length}/${m.runs.length} | ` +
					`LCP ${fmtMs(s["largest-contentful-paint"].mean)} ±${fmtMs(s["largest-contentful-paint"].stddev)} | ` +
					`FCP ${fmtMs(s["first-contentful-paint"].mean)} | ` +
					`TBT ${fmtMs(s["total-blocking-time"].mean)} | ` +
					`TTI ${fmtMs(s["interactive"].mean)}`,
			);

			await writeSummary(runDir, results);
		}
	}

	await writeSummary(runDir, results);
	printLcpTable(results, sites, profiles);

	const totalMin = (performance.now() - totalStart) / 1000 / 60;
	banner(`✅ Completed in ${totalMin.toFixed(1)} min`, "═");
	console.log(`   ${runDir}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});