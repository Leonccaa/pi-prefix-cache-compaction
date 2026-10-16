#!/usr/bin/env node
/**
 * experiment.mjs — config-driven live A/B for this extension.
 *
 *   node scripts/experiment.mjs experiments/incremental.json [--repeats 2] [--dry-run]
 *
 * The JSON file describes everything (see experiments/README.md):
 *   endpoint  provider/model from your models.json, optionally a direct baseUrl
 *             (+ apiKeyEnv | apiKeyCommand, modelId) so runs do not take a slot on a shared proxy
 *   session   cycles, rows (fixture size), thinking, warmup, persist
 *   arms      [{ name, config }] — each arm is a pi-prefix-cache-compaction.json overlay
 *   repeats   how many times every arm runs (arms interleave per repeat: A B A B ...)
 *   compare   { baseline, candidate } arm names for the speed check
 *   accept    which checks gate the exit code + thresholds
 *   output    results file (default experiments/results/<name>-<timestamp>.json)
 *
 * Every arm runs the same scripted session in real Pi (RPC mode, isolated agent dir, this
 * extension only): per cycle plant one fact, grow the context past Pi's verbatim tail (so the
 * fact can only survive through the summary), compact. After the last cycle, recall every fact.
 *
 * Checks:
 *   viaExtension   every compaction in every run went through the extension
 *   incrementalWiring  in arms with config.incremental, compactions 2..N were incremental
 *                  (notice + details.previousSummary); in other arms none were
 *   noLostFacts    every planted fact recalled in every run
 *   faster         candidate vs baseline over compactions 2..N, summed per repeat then
 *                  medianed across repeats: summary seconds improve by >= accept.minTimeGainPct
 *                  and output tokens by >= accept.minTokenGainPct
 */
import { execSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const cfgPath = argv.find((a) => !a.startsWith("--"));
if (!cfgPath) {
	console.error("usage: experiment.mjs <experiment.json> [--repeats N] [--dry-run]");
	process.exit(2);
}
const flag = (name) => {
	const i = argv.indexOf(`--${name}`);
	return i >= 0 ? argv[i + 1] : undefined;
};

// ---- config ---------------------------------------------------------------------------
const exp = JSON.parse(readFileSync(cfgPath, "utf8"));
const name = exp.name ?? basename(cfgPath, ".json");
const endpoint = exp.endpoint ?? {};
const session = { cycles: 3, rows: 600, thinking: "off", warmup: false, persist: false, ...exp.session };
const repeats = Number(flag("repeats") ?? exp.repeats ?? 1);
const arms = exp.arms ?? [];
const accept = { viaExtension: true, incrementalWiring: true, noLostFacts: true, faster: true, minTimeGainPct: 0, minTokenGainPct: 0, ...exp.accept };
const problems = [];
if (!endpoint.provider || !endpoint.model) problems.push("endpoint.provider and endpoint.model are required");
if (arms.length < 1 || arms.some((a) => !a.name)) problems.push("arms: at least one { name, config }");
if (new Set(arms.map((a) => a.name)).size !== arms.length) problems.push("arms: names must be unique");
if (session.cycles < 2) problems.push("session.cycles must be >= 2 (compaction 1 is identical in every arm)");
if (exp.compare && !(arms.some((a) => a.name === exp.compare.baseline) && arms.some((a) => a.name === exp.compare.candidate)))
	problems.push("compare.baseline / compare.candidate must name arms");
if (endpoint.apiKeyEnv && endpoint.apiKeyCommand) problems.push("endpoint: use apiKeyEnv or apiKeyCommand, not both");
if (problems.length) {
	console.error(`invalid experiment ${cfgPath}:\n  - ${problems.join("\n  - ")}`);
	process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const output = resolve(exp.output ?? join(root, "experiments", "results", `${name}-${stamp}.json`));
const modelId = endpoint.baseUrl && endpoint.modelId ? endpoint.modelId : endpoint.model;

if (argv.includes("--dry-run")) {
	console.log(JSON.stringify({ name, endpoint: { ...endpoint, apiKeyCommand: endpoint.apiKeyCommand ? "<set>" : undefined }, session, repeats, arms, compare: exp.compare, accept, output }, null, 2));
	process.exit(0);
}

// Secrets never live in the experiment file: env var or a command that prints the key.
const apiKey = endpoint.apiKeyEnv ? process.env[endpoint.apiKeyEnv] : endpoint.apiKeyCommand ? execSync(endpoint.apiKeyCommand, { encoding: "utf8" }).trim() : undefined;
if ((endpoint.apiKeyEnv || endpoint.apiKeyCommand) && !apiKey) {
	console.error("endpoint api key resolved empty");
	process.exit(2);
}

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(0)}s`.padStart(6);
const FACTS = Array.from({ length: session.cycles }, (_, i) => ({ key: `codeword ${i + 1}`, value: `ZEPHYR-${4100 + 37 * (i + 1)}-${["KILO", "MANGO", "ORBIT", "PIXEL", "QUARTZ", "RAVEN"][i % 6]}` }));

// ---- one run ---------------------------------------------------------------------------
function makeAgent(arm) {
	const agent = mkdtempSync(join(tmpdir(), "ppcc-exp-agent-"));
	for (const f of ["models.json", "auth.json"]) if (existsSync(join(srcAgent, f))) copyFileSync(join(srcAgent, f), join(agent, f));
	if (endpoint.baseUrl) {
		const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8"));
		const p = models.providers[endpoint.provider];
		if (!p) throw new Error(`provider ${endpoint.provider} not in models.json`);
		p.baseUrl = endpoint.baseUrl;
		if (apiKey) p.apiKey = apiKey;
		if (endpoint.modelId) p.models = p.models.filter((m) => m.id === endpoint.model).map((m) => ({ ...m, id: endpoint.modelId }));
		writeFileSync(join(agent, "models.json"), JSON.stringify(models));
	}
	writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: endpoint.provider, defaultModel: modelId }));
	writeFileSync(join(agent, "pi-prefix-cache-compaction.json"), JSON.stringify({ warmup: session.warmup, persist: session.persist, ...arm.config }));
	const work = mkdtempSync(join(tmpdir(), "ppcc-exp-work-"));
	const line = (i) => `record ${i}: service=svc${i % 17} owner=team${i % 5} status=${["ok", "degraded", "down"][i % 3]} note=lorem ipsum dolor sit amet consectetur`;
	for (const n of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(work, n), Array.from({ length: session.rows }, (_, i) => line(i)).join("\n"));
	return { agent, work };
}

function startPi({ agent, work }) {
	const pi = spawn(process.env.PI_BIN ?? "pi", ["--mode", "rpc", "--provider", endpoint.provider, "--model", modelId, "--thinking", session.thinking, "-e", join(root, "src", "index.ts")], {
		cwd: work,
		env: { ...process.env, PI_CODING_AGENT_DIR: agent },
	});
	let buf = "";
	let waiters = [];
	const notices = [];
	pi.stdout.on("data", (d) => {
		buf += d;
		let i;
		while ((i = buf.indexOf("\n")) >= 0) {
			const raw = buf.slice(0, i);
			buf = buf.slice(i + 1);
			let ev;
			try {
				ev = JSON.parse(raw);
			} catch {
				continue;
			}
			if (ev.type === "extension_ui_request" && ev.method === "notify") {
				notices.push(ev.message);
				console.log(el(), "     notify:", ev.message);
			}
			if (ev.type === "extension_error") console.log(el(), "     EXTENSION ERROR:", JSON.stringify(ev).slice(0, 300));
			waiters = waiters.filter((w) => !w(ev));
		}
	});
	pi.stderr.on("data", (d) => process.stderr.write(d));
	const send = (o) => pi.stdin.write(`${JSON.stringify(o)}\n`);
	const until = (pred, ms = 1_800_000) =>
		new Promise((res, rej) => {
			const timer = setTimeout(() => rej(new Error("timeout")), ms);
			waiters.push((ev) => pred(ev) && (clearTimeout(timer), res(ev), true));
		});
	const turn = async (message) => {
		send({ type: "prompt", message });
		const end = await until((e) => e.type === "agent_end");
		const last = [...(end.messages ?? [])].reverse().find((m) => m.role === "assistant");
		if (last?.stopReason === "error") throw new Error(`turn failed: ${last.errorMessage ?? "?"}`);
		return (last?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
	};
	const compact = (id) => (send({ id, type: "compact" }), until((e) => e.type === "response" && e.id === id));
	const stop = async () => {
		const done = new Promise((r) => pi.on("exit", r));
		pi.stdin.end();
		pi.kill("SIGTERM");
		await done;
	};
	return { turn, compact, stop, notices };
}

function compactionEntries(agent) {
	const out = [];
	const dir = join(agent, "sessions");
	for (const d of readdirSync(dir))
		for (const f of readdirSync(join(dir, d)).filter((f) => f.endsWith(".jsonl")))
			for (const l of readFileSync(join(dir, d, f), "utf8").split("\n")) {
				try {
					const r = JSON.parse(l);
					if (r.type === "compaction") out.push(r);
				} catch {}
			}
	return out;
}

async function runArm(arm, repeat) {
	console.log(el(), `=== arm ${arm.name} · repeat ${repeat}/${repeats} · config ${JSON.stringify(arm.config ?? {})} ===`);
	const env = makeAgent(arm);
	const pi = startPi(env);
	const perCompaction = [];
	let recall = "";
	let error;
	try {
		for (let c = 1; c <= session.cycles; c++) {
			await pi.turn(`Remember this for later: ${FACTS[c - 1].key} is ${FACTS[c - 1].value}. Reply OK.`);
			await pi.turn("Read a.txt, b.txt and c.txt fully with your read tool (three reads), then reply OK.");
			const before = pi.notices.length;
			const s = Date.now();
			const r = await pi.compact(`c${c}`);
			const mine = pi.notices.slice(before);
			const done = mine.find((m) => /Compaction done in/.test(m)) ?? "";
			const m = done.match(/done in (\d+)s \((\d+|\?) tokens out(?:, ([\d,]+) prompt tokens served)?/);
			perCompaction.push({
				cycle: c,
				success: !!r.success,
				error: r.error,
				viaExtension: !!done,
				incrementalNotice: mine.some((x) => /incremental \(delta since last summary\)/.test(x)),
				summarySeconds: m ? Number(m[1]) : undefined,
				outputTokens: m && m[2] !== "?" ? Number(m[2]) : undefined,
				cachedPromptTokens: m?.[3] ? Number(m[3].replace(/,/g, "")) : undefined,
				wallSeconds: (Date.now() - s) / 1000,
				summaryChars: r.data?.summary?.length,
			});
			const p = perCompaction.at(-1);
			console.log(el(), `     compaction ${c}: ${p.summarySeconds}s, ${p.outputTokens} tok out, cached ${p.cachedPromptTokens}, via extension ${p.viaExtension}`);
		}
		recall = await pi.turn('Without using any tools, list every codeword you were asked to remember, in the form "codeword N is VALUE", one per line. Write UNKNOWN for any you do not know.');
	} catch (e) {
		error = e.message;
		console.log(el(), "     RUN ERROR:", error);
	} finally {
		await pi.stop();
	}
	compactionEntries(env.agent).forEach((e, i) => perCompaction[i] && (perCompaction[i].hasPreviousSummary = !!e.details?.previousSummary));
	const later = perCompaction.filter((p) => p.cycle >= 2);
	const total = (k) => later.reduce((a, p) => a + (p[k] ?? NaN), 0);
	return {
		arm: arm.name,
		repeat,
		error: error ?? null,
		perCompaction,
		facts: FACTS.map((f) => ({ ...f, recalled: recall.includes(f.value) })),
		recallText: recall, // kept so a failed recall can be told apart from an empty/odd answer
		later: { summarySeconds: total("summarySeconds"), outputTokens: total("outputTokens") },
	};
}

// ---- run all (interleaved so drift on a shared box hits every arm alike) -----------------
const runs = [];
for (let r = 1; r <= repeats; r++) for (const arm of arms) runs.push(await runArm(arm, r));

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const byArm = Object.fromEntries(
	arms.map((a) => {
		const rs = runs.filter((r) => r.arm === a.name);
		return [a.name, { summarySeconds: median(rs.map((r) => r.later.summarySeconds)), outputTokens: median(rs.map((r) => r.later.outputTokens)), runs: rs.length }];
	}),
);
const gain = (b, c) => ((b - c) / b) * 100;
const checks = {
	viaExtension: runs.every((r) => !r.error && r.perCompaction.length === session.cycles && r.perCompaction.every((p) => p.success && p.viaExtension)),
	incrementalWiring: runs.every((r) => {
		const inc = !!arms.find((a) => a.name === r.arm).config?.incremental;
		return r.perCompaction.every((p) => (inc && p.cycle >= 2 ? p.incrementalNotice && p.hasPreviousSummary : !p.incrementalNotice && !p.hasPreviousSummary));
	}),
	noLostFacts: runs.every((r) => r.facts.every((f) => f.recalled)),
};
let speed;
if (exp.compare) {
	const b = byArm[exp.compare.baseline];
	const c = byArm[exp.compare.candidate];
	speed = { baseline: exp.compare.baseline, candidate: exp.compare.candidate, timeGainPct: gain(b.summarySeconds, c.summarySeconds), tokenGainPct: gain(b.outputTokens, c.outputTokens) };
	checks.faster = speed.timeGainPct >= accept.minTimeGainPct && speed.tokenGainPct >= accept.minTokenGainPct;
}
const gated = Object.keys(checks).filter((k) => accept[k] !== false);
const pass = gated.every((k) => checks[k]);

const report = { name, config: cfgPath, startedAt: new Date(t0).toISOString(), model: modelId, session, repeats, arms, accept, checks, gated, pass, compactions2toN_median: byArm, speed, runs };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2));

console.log(`\n${"arm".padEnd(16)} ${"runs".padStart(4)} ${"summary s (2..N)".padStart(17)} ${"tokens out (2..N)".padStart(18)}`);
for (const [a, v] of Object.entries(byArm)) console.log(`${a.padEnd(16)} ${String(v.runs).padStart(4)} ${String(v.summarySeconds).padStart(17)} ${String(v.outputTokens).padStart(18)}`);
if (speed) console.log(`\n${speed.candidate} vs ${speed.baseline}: time ${speed.timeGainPct.toFixed(1)}% faster, tokens ${speed.tokenGainPct.toFixed(1)}% fewer (median over repeats)`);
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "PASS" : "FAIL"} ${k}${gated.includes(k) ? "" : " (not gated)"}`);
console.log(`\nresults: ${output}`);
process.exit(pass ? 0 : 1);
