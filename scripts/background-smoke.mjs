#!/usr/bin/env node
/**
 * Live test of background mode against a real server, through Pi's own threshold
 * auto-compaction (not /compact). The model's contextWindow is shrunk in a temp copy of
 * models.json so the threshold is reached with a few file reads:
 *
 *   1. read two fixture files  -> context passes backgroundAt, a background summary starts
 *   2. a short turn            -> the summary finishes while the session is idle
 *   3. read one more file, then small reads until Pi auto-compacts at its threshold; the
 *      extension must hand over the ready summary, so the compaction takes ~no time, and
 *      the first request after it must find the pre-warmed context in the cache
 *   4. ask for facts from before the compaction
 *
 *   node scripts/background-smoke.mjs --provider deepseek-oa --model deepseek-flash [--window 64000] [--rows 500] [--no-background]
 *
 * --no-background runs the identical scenario with background mode off (the baseline: Pi
 * blocks on a cached-prefix summary at the threshold), for an A/B of the blocking time.
 *
 * Exit code 0 only if the auto-compaction went through the extension (from the background
 * summary, unless --no-background) and the facts survived.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
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
const window = Number(opt("window", "64000"));
const rows = Number(opt("rows", "500"));
const backgroundAt = Number(opt("background-at", "0.35"));
const background = !args.includes("--no-background");
if (!provider || !model) {
	console.error("usage: background-smoke.mjs --provider <id> --model <id> [--window <tokens>] [--rows <n>] [--background-at <0..1>]");
	process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const agent = mkdtempSync(join(tmpdir(), "ppcc-bg-agent-"));
const models = JSON.parse(readFileSync(join(srcAgent, "models.json"), "utf8"));
const m = models.providers?.[provider]?.models?.find((x) => x.id === model);
if (!m) {
	console.error(`model ${provider}/${model} not in ${srcAgent}/models.json`);
	process.exit(2);
}
m.contextWindow = window;
writeFileSync(join(agent, "models.json"), JSON.stringify(models));
if (existsSync(join(srcAgent, "auth.json"))) copyFileSync(join(srcAgent, "auth.json"), join(agent, "auth.json"));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: model }));
writeFileSync(join(agent, "pi-prefix-cache-compaction.json"), JSON.stringify({ background, backgroundAt, persist: false }));

const work = mkdtempSync(join(tmpdir(), "ppcc-bg-work-"));
const line = (i) => `record ${i}: service=svc${i % 17} owner=team${i % 5} status=${["ok", "degraded", "down"][i % 3]} note=lorem ipsum dolor sit amet consectetur`;
for (const name of ["a.txt", "b.txt", "c.txt", "d.txt"]) {
	const lines = Array.from({ length: rows }, (_, i) => line(i));
	if (name === "b.txt") lines.splice(Math.floor(rows / 2), 0, "record SPECIAL: beta=release-2026-09 deploy=blue");
	writeFileSync(join(work, name), lines.join("\n"));
}

const piArgs = ["--mode", "rpc", "--provider", provider, "--model", model, "--thinking", "off", "--no-session", "-e", join(root, "src", "index.ts")];
const pi = spawn(process.env.PI_BIN ?? "pi", piArgs, { cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: agent } });

const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let buf = "";
let waiters = [];
const seen = [];
let lastStatus;
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
		ev.at = Date.now();
		seen.push(ev);
		if (ev.type === "extension_ui_request" && ev.method === "notify") console.log(el(), "notify:", ev.message);
		if (ev.type === "extension_ui_request" && ev.method === "setStatus") {
			// Strip ANSI and the spinner frame so only state changes are printed.
			const text = ev.statusText?.replace(/\x1b\[[0-9;]*m/g, "").trim();
			const state = text?.replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /, "").replace(/[\d.]+k? out|\d+s$/g, "");
			if (state !== lastStatus) console.log(el(), "status:", text ?? "(cleared)");
			lastStatus = state;
		}
		if (ev.type === "compaction_start" || ev.type === "compaction_end") console.log(el(), ev.type, ev.reason ?? "", ev.type === "compaction_end" ? `aborted=${ev.aborted} error=${ev.errorMessage ?? ""}` : "");
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
const turn = async (message) => {
	const s = Date.now();
	send({ type: "prompt", message });
	await until((e) => e.type === "agent_end");
	return (Date.now() - s) / 1000;
};
const notified = (re) => seen.some((e) => e.type === "extension_ui_request" && e.method === "notify" && re.test(e.message ?? ""));
const statused = (re) => seen.some((e) => e.type === "extension_ui_request" && e.method === "setStatus" && re.test(e.statusText ?? ""));

try {
	console.log(el(), "turn 1:", (await turn("Read a.txt and b.txt fully with your read tool (two reads) and tell me the SPECIAL record. Be brief.")).toFixed(1), "s");
	console.log(el(), "turn 2:", (await turn("Remember: the deploy colour is blue. Reply OK.")).toFixed(1), "s");
	if (background && !statused(/compaction ready/)) await until((e) => e.method === "setStatus" && /compaction ready|failed/.test(e.statusText ?? ""), 300_000).catch(() => {});
	const ready = statused(/compaction ready/);
	console.log(el(), `background summary ready before threshold: ${ready}`);
	// Grow the context the way a real session does: one large read, then small steps until
	// Pi's threshold fires, so the last turn before the compaction adds only a little.
	let turn3Seconds = await turn("Read c.txt fully with your read tool, then reply OK.");
	console.log(el(), "turn 3:", turn3Seconds.toFixed(1), "s");
	for (let step = 0; step < 20 && !seen.some((e) => e.type === "compaction_start"); step++) {
		turn3Seconds = await turn(`Read lines ${step * 60 + 1} to ${step * 60 + 60} of d.txt with your read tool (offset/limit), then reply OK.`);
		console.log(el(), `small step ${step + 1}:`, turn3Seconds.toFixed(1), "s");
	}
	const start = seen.find((e) => e.type === "compaction_start");
	const end = seen.find((e) => e.type === "compaction_end");
	const compactMs = start && end ? end.at - start.at : undefined;
	// What the user feels: the first model request after the compaction, how much of its
	// prompt was already cached and how long it took from the compaction to its reply.
	const firstAfter = end && seen.find((e) => e.at >= end.at && e.type === "message_end" && e.message?.role === "assistant");
	const fu = firstAfter?.message?.usage ?? {};
	const firstPrompt = (fu.input ?? 0) + (fu.cacheRead ?? 0) + (fu.cacheWrite ?? 0);
	const firstCachePct = firstPrompt ? Math.round(((fu.cacheRead ?? 0) / firstPrompt) * 100) : undefined;
	const firstReplyMs = firstAfter ? firstAfter.at - end.at : undefined;
	console.log(el(), `first request after compaction: prompt ${firstPrompt} tokens, ${firstCachePct}% from cache, reply ${firstReplyMs}ms after compaction`);
	const usedBackground = notified(/used background summary/);
	const fromExtension = usedBackground || notified(/Compaction done/);
	console.log(el(), `auto-compaction: reason=${start?.reason} took ${compactMs}ms usedBackground=${usedBackground} fromExtension=${fromExtension}`);
	const after = await turn("What is the SPECIAL record and the deploy colour? One line.");
	const last = [...seen].reverse().find((e) => e.type === "agent_end");
	const answer = JSON.stringify(last?.messages?.at(-1)?.content ?? "");
	const factsOk = /release-2026-09/.test(answer) && /blue/i.test(answer);
	console.log(el(), `after compaction: ${after.toFixed(1)}s facts=${factsOk} answer: ${answer.slice(0, 200)}`);
	const ok = Boolean(start && end && !end.aborted && (background ? usedBackground : fromExtension) && factsOk);
	console.log(JSON.stringify({ provider, model, background, window, rows, backgroundAt, ready, reason: start?.reason, compactMs, turn3Seconds, firstPrompt, firstCachePct, firstReplyMs, prewarmed: notified(/pre-warmed/), usedBackground, fromExtension, factsOk, ok }));
	pi.kill();
	process.exit(ok ? 0 : 1);
} catch (err) {
	console.error("background smoke failed:", err.message);
	pi.kill();
	process.exit(1);
}
