#!/usr/bin/env node
/**
 * Live check for persist mode: a compaction right after resume (before any new turn) must
 * still go through this extension.
 *
 *   node scripts/resume-smoke.mjs --provider qwen-local --model coder [--persist false]
 *     [--base-url http://host:port --api-key KEY --model-id served-name]
 *
 * Process 1 runs two short turns in a real session and quits. Process 2 resumes it with
 * `--continue` and compacts immediately. Exit 0 only if process 2 printed "Compaction done".
 * With --persist false the same run must fall back ("no captured request yet").
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const persist = opt("persist", "true") !== "false";
if (!provider || !model) {
	console.error("usage: resume-smoke.mjs --provider <id> --model <id> [--persist false]");
	process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const agent = mkdtempSync(join(tmpdir(), "ppcc-agent-"));
for (const f of ["models.json", "auth.json"]) if (existsSync(join(srcAgent, f))) copyFileSync(join(srcAgent, f), join(agent, f));
// --base-url: talk to one inference server directly (e.g. a vLLM engine port), bypassing a
// shared proxy/router so the smoke run does not take a session slot from real users.
const baseUrl = opt("base-url");
if (baseUrl) {
	const models = JSON.parse(readFileSync(join(agent, "models.json"), "utf8"));
	const p = models.providers[provider];
	p.baseUrl = baseUrl;
	if (opt("api-key")) p.apiKey = opt("api-key");
	if (opt("model-id")) p.models = p.models.filter((m) => m.id === model).map((m) => ({ ...m, id: opt("model-id") }));
	writeFileSync(join(agent, "models.json"), JSON.stringify(models));
}
const modelId = baseUrl && opt("model-id") ? opt("model-id") : model;
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: opt("model-id") ?? model }));
writeFileSync(join(agent, "pi-prefix-cache-compaction.json"), JSON.stringify({ warmup: false, persist }));
const work = mkdtempSync(join(tmpdir(), "ppcc-work-"));
const line = (i) => `record ${i}: service=svc${i % 17} owner=team${i % 5} status=${["ok", "degraded", "down"][i % 3]} note=lorem ipsum dolor sit amet consectetur`;
// Pi keeps ~20k recent tokens out of a compaction; three ~25k-token reads make it compactable.
for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(work, name), Array.from({ length: 1200 }, (_, i) => line(i)).join("\n"));

function runPi(extraArgs, script) {
	const pi = spawn(process.env.PI_BIN ?? "pi", ["--mode", "rpc", "--provider", provider, "--model", modelId, "--thinking", "off", "-e", join(root, "src", "index.ts"), ...extraArgs], {
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
				console.log("  notify:", ev.message);
			}
			if (ev.type === "extension_error") console.log("  EXTENSION ERROR:", JSON.stringify(ev).slice(0, 300));
			waiters = waiters.filter((w) => !w(ev));
		}
	});
	pi.stderr.on("data", (d) => process.stderr.write(d));
	const send = (o) => pi.stdin.write(`${JSON.stringify(o)}\n`);
	const until = (pred, ms = 300_000) =>
		new Promise((res, rej) => {
			const timer = setTimeout(() => rej(new Error("timeout")), ms);
			waiters.push((ev) => pred(ev) && (clearTimeout(timer), res(ev), true));
		});
	const done = new Promise((r) => pi.on("exit", r));
	return script({ send, until, notices }).finally(async () => {
		pi.stdin.end();
		pi.kill("SIGTERM");
		await done;
	});
}

const turn = async ({ send, until }, message) => {
	send({ type: "prompt", message });
	await until((e) => e.type === "agent_end");
};

console.log("process 1: two turns, then quit");
await runPi([], async (p) => {
	await turn(p, "Read a.txt, b.txt and c.txt fully with your read tool (three reads), then reply OK.");
	await turn(p, "Remember: the deploy colour is blue. Reply OK.");
	await turn(p, "Remember: the release tag is r-2026-10. Reply OK.");
});
console.log(`process 2: --continue, compact before any turn (persist=${persist})`);
const notices = await runPi(["--continue"], async (p) => {
	p.send({ id: "c1", type: "compact" });
	const r = await p.until((e) => e.type === "response" && e.id === "c1");
	console.log("  compact response:", JSON.stringify(r).slice(0, 300));
	return p.notices;
});
const viaExtension = notices.some((m) => /Compaction done/.test(m));
const fellBack = notices.some((m) => /no captured request/.test(m));
const ok = persist ? viaExtension && !fellBack : fellBack && !viaExtension;
console.log(ok ? "PASS" : "FAIL", { persist, viaExtension, fellBack });
process.exit(ok ? 0 : 1);
