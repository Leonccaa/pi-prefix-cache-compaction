#!/usr/bin/env node
// Regression test for a crash seen live: background work (here the post-compaction warm-up)
// finishing after /reload or a session switch touched the stale ctx, Pi threw, and the
// exception escaped a fire-and-forget promise and killed the process. Compacts, replaces the
// session while the background work runs, waits, then checks Pi is alive and answering.
//   node scripts/stale-ctx-smoke.mjs --provider <id> --model <id> [--extension <path to index.ts>]
// Uses PI_CODING_AGENT_DIR (default ~/.pi/agent) for models.json.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
const args = process.argv.slice(2);
const opt = (n, d) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : d);
const provider = opt("provider"), model = opt("model");
const ext = opt("extension", new URL("../src/index.ts", import.meta.url).pathname);
if (!provider || !model) {
	console.error("usage: stale-ctx-smoke.mjs --provider <id> --model <id> [--extension <path>]");
	process.exit(2);
}
const srcAgent = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const agent = mkdtempSync(join(tmpdir(), "ppcc-stale-"));
const models = JSON.parse(readFileSync(join(srcAgent, "models.json"), "utf8"));
models.providers[provider].models.find((m) => m.id === model).contextWindow = 64000;
writeFileSync(join(agent, "models.json"), JSON.stringify(models));
writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProvider: provider, defaultModel: model }));
writeFileSync(join(agent, "pi-prefix-cache-compaction.json"), JSON.stringify({ background: true, backgroundAt: 0.3, persist: false }));
const work = mkdtempSync(join(tmpdir(), "ppcc-stale-work-"));
const line = (i) => `record ${i}: service=svc${i % 17} owner=team${i % 5} note=lorem ipsum dolor sit amet consectetur`;
for (const n of ["a.txt", "b.txt"]) writeFileSync(join(work, n), Array.from({ length: 500 }, (_, i) => line(i)).join("\n"));
const pi = spawn("pi", ["--mode", "rpc", "--provider", provider, "--model", model, "--thinking", "off", "--no-session", "-e", ext], { cwd: work, env: { ...process.env, PI_CODING_AGENT_DIR: agent } });
let exited = null, stderr = "";
pi.on("exit", (code, sig) => (exited = `${code ?? sig}`));
pi.stderr.on("data", (d) => (stderr += d));
const t0 = Date.now(), el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let buf = "", waiters = [];
pi.stdout.on("data", (d) => {
	buf += d; let i;
	while ((i = buf.indexOf("\n")) >= 0) {
		const raw = buf.slice(0, i); buf = buf.slice(i + 1);
		let ev; try { ev = JSON.parse(raw); } catch { continue; }
		if (ev.type === "extension_ui_request" && ev.method === "notify") console.log(el(), "notify:", ev.message.slice(0, 110));
		waiters = waiters.filter((w) => !w(ev));
	}
});
const send = (o) => pi.stdin.write(`${JSON.stringify(o)}\n`);
const until = (p, ms) => new Promise((res) => { const t = setTimeout(() => res(null), ms); waiters.push((e) => p(e) && (clearTimeout(t), res(e), true)); });
send({ type: "prompt", message: "Read a.txt and b.txt fully with your read tool (two reads), then reply OK." });
await until((e) => e.type === "extension_ui_request" && /Background compaction: started/.test(e.message ?? ""), 300_000);
await until((e) => e.type === "agent_end", 300_000);
send({ id: "c1", type: "compact" });
await until((e) => e.type === "response" && e.id === "c1", 300_000);
console.log(el(), "compacted; warm-up now running in the background; replacing the session");
send({ id: "ns", type: "new_session" });
await until((e) => e.type === "response" && e.id === "ns", 30_000);
await new Promise((r) => setTimeout(r, 60_000)); // let the old background work finish
console.log(el(), "process exited:", exited ?? "no");
if (!exited) {
	send({ type: "prompt", message: "Reply with the single word ALIVE." });
	const end = await until((e) => e.type === "agent_end", 120_000);
	console.log(el(), "answers after replacement:", JSON.stringify(end?.messages?.at(-1)?.content ?? null).slice(0, 80));
}
const crash = stderr.match(/stale[^\n]*/);
console.log("RESULT", JSON.stringify({ crashed: Boolean(exited), staleError: crash ? crash[0].slice(0, 120) : null }));
pi.kill(); process.exit(0);
