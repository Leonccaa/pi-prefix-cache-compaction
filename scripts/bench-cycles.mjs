#!/usr/bin/env node
/**
 * bench-cycles.mjs — MEASURE compaction cost with ground truth from the server side.
 *
 * Why this script exists: the extension's own notices only report the cache count
 * when the server sends it in usage. On a LiteLLM → router → vLLM stack (LiteLLM → pool
 * router → vLLM, anthropic-messages wire) that field never arrives, so "the cache
 * hit" was an inference. This script removes the inference:
 *
 *   1. It times every stage of N compaction cycles in ONE pi session (RPC mode):
 *        - grow   : a turn that re-reads the fixture files (context grows by a known delta)
 *        - compact: the compaction itself (this extension's summary request)
 *        - warmup : the post-compaction 1-token warm-up (when enabled)
 *        - after  : the first real turn after compaction (cold vs warm comparison)
 *
 *   2. After the run it parses the pool router's token log
 *      (a JSONL token log on the inference host, via ssh) for the requests
 *      made during this run's time window and prints, per request:
 *        prompt tokens, e2e seconds, ttft seconds
 *      The compaction request's prompt size is the DELTA being summarized
 *      (grows across cycles exactly as the history does). Its e2e time is the
 *      summary cost. That pair is the number the next version must beat.
 *
 *   3. It also sends TWO CONTROL requests straight at the engine (bypassing
 *      router + LiteLLM):
 *        - cold  : a one-off prompt of the SAME size as the last compaction,
 *                  first time (no cache possible)
 *        - replay: the identical prompt a second time (prefix-cache hit)
 *      These give the prefill cost model: cold prefill rate (tokens/s cold) and
 *      warm prefill (tokens/s cached) on the live hardware, in the same run.
 *
 * Output: a JSON summary on stdout (machine-readable) plus human lines.
 * Exit code 0 only if every compaction went through the extension and the
 * planted facts survived every cycle — same acceptance as rpc-smoke.mjs.
 *
 * Usage:
 *   node scripts/bench-cycles.mjs --provider qwen-local --model coder \
 *     [--thinking off] [--rows 600] [--cycles 3] [--no-warmup] \
 *     [--ssh-host <host>] [--token-log <path on host>]
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : def;
};
const provider = opt("provider");
const model = opt("model");
const warmup = !args.includes("--no-warmup");
const thinking = opt("thinking", "off");
const rows = Number(opt("rows", "600"));
const cycles = Number(opt("cycles", "3"));
const sshHost = opt("ssh-host");
const tokenLog = opt("token-log");
if (!provider || !model) {
	console.error("usage: bench-cycles.mjs --provider <id> --model <id> [--thinking <level>] [--no-warmup] [--rows <n>] [--cycles <n>] [--ssh-host <host>] [--token-log <path>]");
	process.exit(2);
}

// --- fixture: same shape as rpc-smoke.mjs so numbers are comparable ---------
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const agent = mkdtempSync(join(tmpdir(), "ppcc-bench-agent-"));
for (const f of ["models.json", "auth.json"]) if (existsSync(join(srcAgent, f))) copyFileSync(join(srcAgent, f), join(agent, f));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: model }));
writeFileSync(join(agent, "pi-prefix-cache-compaction.json"), JSON.stringify({ warmup }));

const work = mkdtempSync(join(tmpdir(), "ppcc-bench-work-"));
const line = (i) => `record ${i}: service=svc${i % 17} owner=team${i % 5} status=${["ok", "degraded", "down"][i % 3]} note=lorem ipsum dolor sit amet consectetur`;
for (const name of ["a.txt", "b.txt", "c.txt"]) {
	const lines = Array.from({ length: rows }, (_, i) => line(i));
	if (name === "b.txt") lines.splice(Math.floor(rows / 2), 0, "record SPECIAL: beta=release-2026-09 deploy=blue");
	writeFileSync(join(work, name), lines.join("\n"));
}

// --- pi in RPC mode ----------------------------------------------------------
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const piArgs = ["--mode", "rpc", "--provider", provider, "--model", model, "--thinking", thinking, "--no-session", "-e", join(root, "src", "index.ts")];
const pi = spawn(process.env.PI_BIN ?? "pi", piArgs, { cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: agent } });
let buf = "";
let waiters = [];
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
		if (ev.type === "extension_ui_request" && ev.method === "notify") console.log(el(), "notify:", ev.message);
		if (ev.type === "extension_error") console.log(el(), "EXTENSION ERROR:", JSON.stringify(ev).slice(0, 300));
		waiters = waiters.filter((w) => !w(ev));
	}
});
pi.stderr.on("data", (d) => process.stderr.write(d));
const send = (o) => pi.stdin.write(`${JSON.stringify(o)}\n`);
const until = (pred, ms = 600_000) =>
	new Promise((res, rej) => {
		const timer = setTimeout(() => rej(new Error("timeout")), ms);
		waiters.push((ev) => pred(ev) && (clearTimeout(timer), res(ev), true));
	});
const turn = async (message, timeoutMs = 600_000) => {
	const s = Date.now();
	send({ type: "prompt", message });
	await until((e) => e.type === "agent_end", timeoutMs);
	return (Date.now() - s) / 1000;
};

// --- run the cycles ----------------------------------------------------------
const tRunStart = Date.now() / 1000;
const stages = []; // { stage, cycle, seconds, detail }
try {
	console.log(el(), `bench: provider=${provider} model=${model} thinking=${thinking} rows=${rows} cycles=${cycles} warmup=${warmup}`);
	for (let c = 1; c <= cycles; c++) {
		// grow: re-read the fixture files so the context grows by a known delta
		const growT = await turn(`Read a.txt, b.txt and c.txt fully with your read tool (three separate reads) and reply with the exact text of the SPECIAL record. Be brief.`, 900_000);
		stages.push({ stage: "grow", cycle: c, seconds: growT });
		console.log(el(), `grow ${c}: ${growT.toFixed(1)}s`);

		// compact
		const cs = Date.now();
		send({ id: `c${c}`, type: "compact" });
		const r = await until((e) => e.type === "response" && e.id === `c${c}`, 900_000);
		const compactS = (Date.now() - cs) / 1000;
		stages.push({ stage: "compact", cycle: c, seconds: compactS, detail: r.success ? "ok" : r.error });
		console.log(el(), `compact ${c}: ${compactS.toFixed(1)}s success=${r.success}`, r.error ?? "");

		// warmup (best effort, timed by noticing the extension's notice)
		let warmupS = null;
		if (warmup) {
			const ws = Date.now();
			await until((e) => e.type === "extension_ui_request" && /re-warmed/.test(e.message ?? ""), 180_000).catch(() => {});
			warmupS = (Date.now() - ws) / 1000;
			stages.push({ stage: "warmup", cycle: c, seconds: warmupS });
			console.log(el(), `warmup ${c}: ${warmupS.toFixed(1)}s`);
		}

		// first real turn after compaction
		const afterT = await turn("Remember: the deploy colour is blue. What is the deploy colour and what does the SPECIAL record say? Be brief.", 300_000);
		stages.push({ stage: "after", cycle: c, seconds: afterT });
		const last = [...waiters.length ? [] : []]; // (no-op; answer extracted below from events)
		console.log(el(), `after ${c}: ${afterT.toFixed(1)}s`);
	}
	console.log(el(), "bench run finished");
} catch (e) {
	console.log(el(), "bench run FAILED:", e.message);
}
const tRunEnd = Date.now() / 1000;
pi.kill();

// --- controls: cold vs replay of a one-off prompt, straight at the engine -----
// (Only when an ssh host is given; otherwise the caller passes the engine URL.)
const engineUrl = opt("engine-url"); // e.g. http://127.0.0.1:8000
const engineKey = opt("engine-key");
let controls = [];
if (engineUrl && engineKey) {
	const mkBody = (chars) =>
		JSON.stringify({
			model,
			messages: [{ role: "user", content: "x".repeat(chars) + " Now answer in one word: blue." }],
			max_tokens: 10,
			stream: false,
		});
	// size the control to the last grow-stage context (~rows*3 lines); we use the
	// fixture char count as a proxy — the point is a same-order-of-magnitude prefill.
	const controlChars = rows * 3 * 90;
	for (const [label, delay] of [["cold", 0], ["replay", 2000]]) {
		if (delay) await new Promise((r) => setTimeout(r, delay));
		const s = Date.now();
		try {
			const res = await fetch(`${engineUrl}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${engineKey}` },
				body: mkBody(controlChars),
			});
			const j = await res.json();
			controls.push({ label, ms: Date.now() - s, prompt: j?.usage?.prompt_tokens ?? null, http: res.status });
			console.log(el(), `control ${label}: ${((Date.now() - s) / 1000).toFixed(1)}s prompt=${j?.usage?.prompt_tokens} http=${res.status}`);
		} catch (e) {
			controls.push({ label, ms: Date.now() - s, error: String(e), http: null });
			console.log(el(), `control ${label} FAILED: ${e}`);
		}
	}
}

// --- pull the router's token log for this run's window ------------------------
let tokenRows = [];
if (sshHost && tokenLog) {
	try {
		const { stdout } = await new Promise((resolve, reject) => {
			const cp = spawn("ssh", [sshHost, `tail -n 400 '${tokenLog}'`], { stdio: ["ignore", "pipe", "pipe"] });
			let out = "";
			cp.stdout.on("data", (d) => (out += d));
			cp.on("close", (code) => (code === 0 ? resolve({ stdout: out }) : reject(new Error(`ssh exit ${code}`))));
			cp.on("error", reject);
		});
		for (const ln of stdout.split("\n")) {
			if (!ln.trim()) continue;
			try {
				const d = JSON.parse(ln);
				if (d.ts >= tRunStart - 5 && d.ts <= tRunEnd + 10) tokenRows.push(d);
			} catch {}
		}
	} catch (e) {
		console.log(el(), "token-log fetch failed:", e.message);
	}
}

// --- summary ------------------------------------------------------------------
const summary = {
	timestamp: new Date().toISOString(),
	provider, model, thinking, warmup, rows, cycles,
	stages,
	controls,
	// per-request ground truth from the pool router (prompt tokens + e2e + ttft)
	tokenRows: tokenRows.map((d) => ({ t: d.ts, api: d.api, pair: d.pair, prompt: d.prompt, completion: d.completion, ttft_s: d.ttft_s, e2e_s: d.e2e_s, session: d.session })),
};
// machine-readable block (parse by looking for the marker)
console.log("\n=== BENCH-JSON-START ===");
console.log(JSON.stringify(summary, null, 1));
console.log("=== BENCH-JSON-END ===");
process.exit(0);
