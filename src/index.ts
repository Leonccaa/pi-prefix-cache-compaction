/**
 * pi-prefix-cache-compaction
 *
 * Pi's default compaction serializes the history into ONE new user message under a
 * different system prompt, so a server-side prefix cache (vLLM, SGLang, llama.cpp)
 * misses completely and the whole history is prefilled again. On local GPUs that is
 * minutes per compaction.
 *
 * This extension instead:
 *  1. captures each real provider request (before_provider_request),
 *  2. on compaction re-sends that exact request plus one summarize instruction,
 *     thinking settings untouched -> the prefix is served from cache (Qwen-style
 *     templates render reasoning effort into the system prompt, so changing thinking
 *     would change the whole prefix),
 *  3. after compaction, optionally sends a 1-token warm-up with the new context so the
 *     next turn does not prefill the summary + kept messages cold.
 *
 * Works for the Anthropic Messages and OpenAI Chat Completions wire formats.
 * Anything unexpected returns nothing, and Pi runs its default compaction.
 * Technique credit: pisceslailai/deepseek-kvcache (MIT), adapted to Anthropic Messages.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
	appliesTo,
	backgroundFits,
	backgroundStartTokens,
	buildSummaryBody,
	buildWarmupBody,
	type Config,
	createCollector,
	endpointUrl,
	fileListSuffix,
	isCapturable,
	mergeConfig,
	captureFileName,
	modelKey,
	parseStoredCapture,
	requestHeaders,
	serializeCapture,
	type ResolvedAuth,
	type SseResult,
	type StreamCollector,
	streamMessages,
	summaryTokenBudget,
	toPiUsage,
	wireApi,
} from "./core.ts";

const CONFIG_NAME = "pi-prefix-cache-compaction.json";
const CAPTURE_TTL_MS = 14 * 24 * 3600_000;
/** Debug: PI_PREFIX_CACHE_DUMP=<dir> writes every real request and warm-up body there. */
let dumpSeq = 0;
function dump(kind: string, body: unknown) {
	const dir = process.env.PI_PREFIX_CACHE_DUMP;
	if (!dir) return;
	try {
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, `${String(++dumpSeq).padStart(3, "0")}-${kind}.json`), JSON.stringify(body, null, 1));
	} catch {
		// debug only
	}
}
const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const captureDir = () => join(agentDir(), "cache", "pi-prefix-cache-compaction");

function readJsonFile(path: string, problems: string[]): Partial<Config> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (err) {
		problems.push(`${path}: ${(err as Error).message}`);
		return undefined;
	}
}

function loadConfig(cwd: string): { config: Config; problems: string[] } {
	const problems: string[] = [];
	const config = mergeConfig(readJsonFile(join(agentDir(), CONFIG_NAME), problems), readJsonFile(join(cwd, ".pi", CONFIG_NAME), problems));
	return { config, problems };
}

type Capture = {
	payload?: Record<string, any>;
	headers?: Record<string, unknown>;
	/** modelKey() of the model the payload was captured for (undefined = legacy capture). */
	modelKey?: string;
	/** True after a Pi-default compaction invalidated the prefix; a new real turn clears it. */
	stale?: boolean;
	/** Session leaf when the payload was sent: the last entry the payload contains. */
	leafId?: string | null;
	/** Pi's context estimate when the payload was sent. */
	tokens?: number | null;
};

/** A summary of one captured request, computed while the session keeps working. */
type BackgroundJob = {
	/** The assistant reply to the summarized request: the kept tail starts here. */
	firstKeptEntryId: string;
	tokensAt: number;
	modelKey?: string;
	abort: AbortController;
	collector: StreamCollector;
	done: Promise<void>;
	result?: SseResult;
	error?: string;
	t0: number;
	/** A pre-warm request for the post-compaction context is in flight. */
	prewarming?: boolean;
	/** Settles when the in-flight pre-warm finishes (success or not). */
	prewarmDone?: Promise<void>;
	/** Number of completed pre-warms (the first one prefills the whole future context). */
	prewarms: number;
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const STATUS_KEY = "prefix-cache-compaction";
type PillTone = "busy" | "bg" | "ok" | "warn";
const PILL_STYLE: Record<PillTone, { fg: "accent" | "muted" | "success" | "warning"; bg: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg" }> = {
	busy: { fg: "accent", bg: "toolPendingBg" },
	bg: { fg: "muted", bg: "toolPendingBg" },
	ok: { fg: "success", bg: "toolSuccessBg" },
	warn: { fg: "warning", bg: "toolErrorBg" },
};

/**
 * Footer pill (ctx.ui.setStatus): an animated spinner with elapsed time while a phase runs,
 * then a short-lived colored result. Pure decoration: every UI call is guarded so a Pi build
 * without themes or without a TUI (print / RPC mode) never affects the compaction itself.
 */
/**
 * Background work (summary, pre-warm, warm-up) can finish after `/reload` or a session switch,
 * when the ctx it captured is stale: Pi then throws on any ctx access, and an exception escaping
 * a fire-and-forget promise kills the whole process (seen live). Every UI touch goes through this.
 */
function uiAlive(ctx: ExtensionContext): boolean {
	try {
		return ctx.hasUI;
	} catch {
		return false;
	}
}

function createStatusPill() {
	let timer: ReturnType<typeof setInterval> | undefined;
	let clearTimer: ReturnType<typeof setTimeout> | undefined;
	// The background summary only paints while nothing in the foreground owns the pill.
	let owner: "fg" | "bg" | undefined;
	const stop = () => {
		clearInterval(timer);
		clearTimeout(clearTimer);
		timer = clearTimer = undefined;
	};
	const paint = (ctx: ExtensionContext, tone: PillTone, text: string) => {
		try {
			const theme = ctx.ui.theme;
			const label = ` ${text} `;
			const pill = theme ? theme.bg(PILL_STYLE[tone].bg, theme.bold(theme.fg(PILL_STYLE[tone].fg, label))) : label;
			ctx.ui.setStatus(STATUS_KEY, pill);
		} catch {
			// decoration only
		}
	};
	return {
		/** Animate `label()` (re-evaluated every tick, so it can show live progress). */
		start(ctx: ExtensionContext, label: (secs: number) => string, who: "fg" | "bg" = "fg") {
			if (!uiAlive(ctx) || (who === "bg" && owner === "fg" && timer)) return;
			stop();
			owner = who;
			const t0 = Date.now();
			let i = 0;
			const tone: PillTone = who === "bg" ? "bg" : "busy";
			const tick = () => paint(ctx, tone, `${SPINNER[i++ % SPINNER.length]} ${label(Math.floor((Date.now() - t0) / 1000))}`);
			tick();
			timer = setInterval(tick, 120);
			timer.unref?.();
		},
		/** Show a final state for a few seconds, then remove the pill. */
		finish(ctx: ExtensionContext, tone: PillTone, text: string, holdMs = 8_000, who: "fg" | "bg" = "fg") {
			if (!uiAlive(ctx) || (who === "bg" && owner !== "bg")) return;
			stop();
			owner = who;
			paint(ctx, tone, text);
			if (holdMs <= 0) return; // stays until the next start/finish/clear
			clearTimer = setTimeout(() => this.clear(ctx, who), holdMs);
			clearTimer.unref?.();
		},
		/** Remove the pill; a background caller only removes its own. */
		clear(ctx: ExtensionContext, who: "fg" | "bg" = "fg") {
			if (who === "bg" && owner !== "bg") return;
			stop();
			owner = undefined;
			try {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			} catch {
				// decoration only
			}
		},
	};
}

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

const stats = { compactions: 0, fallbacks: 0, warmups: 0, lastSeconds: 0, lastReason: "", lastWarmupError: "", background: 0, backgroundUsed: 0, lastBackgroundError: "", prewarms: 0, lastPrewarmError: "" };

/**
 * Request-time auth, the same way Pi resolves it for a real turn. `before_provider_headers`
 * sees Pi's header map BEFORE the API key is attached (the key goes to the SDK as `apiKey`),
 * so the captured headers alone are keyless against any authenticated endpoint (issue #2).
 * Older Pi builds without `getApiKeyAndHeaders` fall back to the captured map only.
 */
async function resolveAuth(ctx: ExtensionContext): Promise<{ auth?: ResolvedAuth; error?: string }> {
	const registry = ctx.modelRegistry as { getApiKeyAndHeaders?: (m: any) => Promise<any> } | undefined;
	if (!ctx.model || typeof registry?.getApiKeyAndHeaders !== "function") return {};
	try {
		const r = await registry.getApiKeyAndHeaders(ctx.model);
		if (!r?.ok) return { error: r?.error ?? "auth resolution failed" };
		return { auth: { apiKey: r.apiKey, headers: r.headers, baseUrl: r.baseUrl } };
	} catch (err) {
		return { error: (err as Error).message };
	}
}

/**
 * One 1-token request with the context Pi would build from `entries` at `leafId`, through
 * Pi's model registry (request-time auth, Pi's own converter) with the captured system
 * prompt, tools and thinking settings, so that context lands in the server's prefix cache.
 */
async function sendWarm(ctx: ExtensionContext, cap: Capture, id: string, entries: any[], leafId: string | null): Promise<void> {
	const model = ctx.model;
	if (!model || !cap.payload) throw new Error("no model or capture");
	const session = buildSessionContext(entries, leafId);
	const messages = convertToLlm(session.messages);
	// The captured map only contributes routing / attribution headers; the credential
	// is resolved at request time, never replayed from the capture (issue #2).
	const headers = requestHeaders(wireApi(model)!, cap.headers, undefined, { "x-session-id": id });
	delete headers["content-type"];
	const context = { systemPrompt: "", messages, tools: [] };
	const payload = cap.payload;
	const onPayload = (built: unknown) => {
		const body = buildWarmupBody(payload, built as Record<string, any>);
		dump(leafId === "pi-prefix-cache-compaction-prewarm" ? "prewarm" : "warmup", body);
		return body;
	};
	const registry = ctx.modelRegistry as unknown as { streamSimple?: (m: any, c: any, o: any) => { result(): Promise<any> } };
	let result: { stopReason?: string; errorMessage?: string };
	if (typeof registry.streamSimple === "function") {
		// Pi >= 0.86: the registry streams with request-time auth exactly like a real turn.
		result = await registry.streamSimple(model, context, { maxTokens: 1, headers, onPayload }).result();
	} else {
		// Pi 0.85: the registry facade cannot stream. Resolve auth through it and call the
		// same pi-ai entrypoint Pi 0.85 uses for its own compaction.
		const { auth, error } = await resolveAuth(ctx);
		if (error) throw new Error(`auth: ${error}`);
		const routed = auth?.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
		result = await completeSimple(routed, context, {
			maxTokens: 1,
			headers: { ...headers, ...(auth?.headers ?? {}) },
			apiKey: auth?.apiKey,
			onPayload,
		});
	}
	if (result.stopReason === "error" || result.stopReason === "aborted") {
		throw new Error(result.errorMessage ?? `stop reason ${result.stopReason}`);
	}
}

export default function prefixCacheCompaction(pi: ExtensionAPI) {
	const captures = new Map<string, Capture>(); // Pi session id -> last real request
	let config: Config | undefined;
	const cfg = (ctx: ExtensionContext) => (config ??= loadConfig(ctx.cwd).config);
	const notify = (ctx: ExtensionContext, msg: string, kind: "info" | "warning" = "info") => {
		try {
			if (cfg(ctx).notify) ctx.ui.notify(msg, kind);
		} catch {
			// stale ctx after /reload or a session switch: the message has nowhere to go
		}
	};
	const pill = createStatusPill();
	const jobs = new Map<string, BackgroundJob>(); // Pi session id -> background summary
	const dropJob = (id: string) => {
		jobs.get(id)?.abort.abort();
		jobs.delete(id);
	};
	const prewarmed = new Set<string>(); // sessions whose last compaction used a pre-warmed summary

	/**
	 * Warm the context Pi will build after it compacts with this job's summary: system,
	 * summary message, then every entry from firstKeptEntryId to now. That context only grows
	 * at the end, so each later pre-warm prefills just the turns added since the last one, and
	 * the first turn after the compaction finds it cached instead of prefilling ~100k cold.
	 */
	const prewarm = (ctx: ExtensionContext, id: string, job: BackgroundJob) => {
		try {
			startPrewarm(ctx, id, job);
		} catch {
			job.prewarming = false; // stale ctx: no pre-warm, the first turn after compaction prefills normally
		}
	};
	const startPrewarm = (ctx: ExtensionContext, id: string, job: BackgroundJob) => {
		const c = cfg(ctx);
		const cap = captures.get(id);
		if (!c.warmup || !job.result || job.prewarming || !cap?.payload || jobs.get(id) !== job) return;
		job.prewarming = true;
		const t0 = Date.now();
		const virtual = {
			type: "compaction",
			id: "pi-prefix-cache-compaction-prewarm",
			parentId: ctx.sessionManager.getLeafId(),
			timestamp: new Date().toISOString(),
			summary: job.result.text,
			firstKeptEntryId: job.firstKeptEntryId,
			tokensBefore: 0,
			// Pi stores the current system message on the compaction entry (Pi >= 1.0) and puts it
			// before the summary; mirror that so the warmed prefix is the one Pi will send.
			systemMessage: [...(ctx.sessionManager.buildSessionProjection?.().messages ?? [])].reverse().find((m: any) => m.role === "system"),
		};
		job.prewarmDone = sendWarm(ctx, cap, id, [...ctx.sessionManager.getEntries(), virtual], virtual.id)
			.then(() => {
				job.prewarms++;
				stats.prewarms++;
				stats.lastPrewarmError = "";
				if (job.prewarms === 1) notify(ctx, `Background compaction: post-compaction context pre-warmed in ${Math.round((Date.now() - t0) / 1000)}s; the first turn after compaction starts from cache`);
			})
			.catch((err) => {
				stats.lastPrewarmError = (err as Error).message ?? String(err);
			})
			.finally(() => {
				job.prewarming = false;
			});
	};
	const fallback = (ctx: ExtensionContext, reason: string) => {
		stats.fallbacks++;
		stats.lastReason = reason;
		if (cfg(ctx).statusBar) pill.finish(ctx, "warn", `⚠ prefix-cache skipped: ${reason.length > 48 ? `${reason.slice(0, 47)}…` : reason}`);
		notify(ctx, `Prefix-cache compaction skipped (${reason}); using Pi default`, "warning");
	};

	// Persist mode: the last real request per session, written off the hot path (debounced)
	// and flushed on shutdown, so a resumed session can compact from cache before its first turn.
	const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>();
	const writeCapture = (id: string) => {
		pendingWrites.delete(id);
		const cap = captures.get(id);
		if (!cap?.payload || cap.stale) return;
		try {
			mkdirSync(captureDir(), { recursive: true });
			const file = join(captureDir(), captureFileName(id));
			writeFileSync(`${file}.tmp`, serializeCapture(id, { payload: cap.payload, headers: cap.headers, modelKey: cap.modelKey }));
			renameSync(`${file}.tmp`, file);
		} catch {
			// best effort: no file just means the old "no captured request" fallback
		}
	};
	const scheduleWrite = (id: string) => {
		clearTimeout(pendingWrites.get(id));
		const t = setTimeout(() => writeCapture(id), 2_000);
		t.unref?.();
		pendingWrites.set(id, t);
	};
	const dropStored = (id: string) => {
		clearTimeout(pendingWrites.get(id));
		pendingWrites.delete(id);
		try {
			unlinkSync(join(captureDir(), captureFileName(id)));
		} catch {
			// absent is fine
		}
	};
	const loadStored = (id: string): Capture | undefined => {
		try {
			const stored = parseStoredCapture(readFileSync(join(captureDir(), captureFileName(id)), "utf8"), id);
			return stored && { payload: stored.payload, headers: stored.headers, modelKey: stored.modelKey, stale: false };
		} catch {
			return undefined;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		const { config: c, problems } = loadConfig(ctx.cwd);
		config = c;
		if (problems.length && c.notify) ctx.ui.notify(`pi-prefix-cache-compaction: ignoring malformed config (${problems.join("; ")})`, "warning");
		try {
			for (const f of readdirSync(captureDir())) {
				const p = join(captureDir(), f);
				if (Date.now() - statSync(p).mtimeMs > CAPTURE_TTL_MS) unlinkSync(p);
			}
		} catch {
			// no cache dir yet
		}
	});

	// Release the (potentially megabyte-scale) captured payload when a session goes away;
	// in persist mode flush it first so `pi -c` can pick it up.
	pi.on("session_shutdown", (_event, ctx) => {
		const id = ctx.sessionManager.getSessionId();
		if (pendingWrites.has(id)) {
			clearTimeout(pendingWrites.get(id));
			writeCapture(id);
		}
		captures.delete(id);
		dropJob(id);
		pill.clear(ctx);
	});

	pi.on("before_provider_headers", (event, ctx) => {
		if (!appliesTo(ctx.model, cfg(ctx))) return;
		const id = ctx.sessionManager.getSessionId();
		const cap = captures.get(id) ?? {};
		cap.headers = { ...event.headers }; // copy: later extensions may mutate event.headers in place
		captures.set(id, cap);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!appliesTo(ctx.model, cfg(ctx)) || !isCapturable(event.payload)) return;
		const id = ctx.sessionManager.getSessionId();
		const cap = captures.get(id) ?? {};
		cap.payload = structuredClone(event.payload as Record<string, any>);
		dump("request", cap.payload);
		cap.modelKey = modelKey(ctx.model);
		cap.stale = false; // this real turn re-anchors the prefix
		cap.leafId = ctx.sessionManager.getLeafId();
		cap.tokens = ctx.getContextUsage?.()?.tokens;
		captures.set(id, cap);
		if (cfg(ctx).persist) scheduleWrite(id);
	});

	// Background mode: after a turn whose request crossed `backgroundAt`, summarize that request
	// (its prefix is now in the server cache) while the session keeps going. Runs at most one
	// job per session; a job whose kept tail grew too large is replaced by a fresher one.
	pi.on("turn_end", (event, ctx) => {
		const c = cfg(ctx);
		const api = wireApi(ctx.model);
		if (!c.background || !api || !appliesTo(ctx.model, c)) return;
		const id = ctx.sessionManager.getSessionId();
		const cap = captures.get(id);
		const window = ctx.model?.contextWindow ?? 0;
		if (!cap?.payload || cap.stale || cap.modelKey !== modelKey(ctx.model) || cap.tokens == null) return;
		if (cap.tokens < backgroundStartTokens(window, c)) return;
		// The reply must directly follow the captured request, or the kept tail would miss entries.
		if (!cap.leafId || ctx.sessionManager.getEntry(event.messageEntryId)?.parentId !== cap.leafId) return;
		const job = jobs.get(id);
		if (job && job.modelKey === cap.modelKey && !job.error && backgroundFits(window, cap.tokens, job.tokensAt, job.collector.text.length)) {
			prewarm(ctx, id, job); // extend the warmed post-compaction prefix by this turn
			return;
		}
		if (job?.error && cap.tokens - job.tokensAt < window * 0.1) return; // failed recently: no retry storm
		const budget = summaryTokenBudget(window, cap.tokens, c);
		if (!budget) return;
		const refreshing = Boolean(job?.result);
		dropJob(id);
		const abort = new AbortController();
		const collector = createCollector(api);
		const next: BackgroundJob = { firstKeptEntryId: event.messageEntryId, tokensAt: cap.tokens, modelKey: cap.modelKey, abort, collector, done: Promise.resolve(), t0: Date.now(), prewarms: 0 };
		const payload = cap.payload;
		const headers = cap.headers;
		stats.background++;
		notify(
			ctx,
			refreshing
				? `Background compaction: refreshing the summary (too much happened since the last one), ${cap.tokens.toLocaleString()} tokens`
				: `Background compaction: started at ${cap.tokens.toLocaleString()} / ${window.toLocaleString()} tokens (${Math.round((cap.tokens / window) * 100)}%); you can keep working`,
		);
		if (c.statusBar) {
			pill.start(ctx, (secs) => {
				const out = collector.text.length + collector.thinkingChars;
				return `pre-summarizing in background${out ? ` · ~${fmtTokens(Math.round(out / 4))} out` : ""} · ${secs}s`;
			}, "bg");
		}
		next.done = (async () => {
			try {
				const { auth, error } = await resolveAuth(ctx);
				if (error) throw new Error(`auth: ${error}`);
				next.result = await streamMessages(
					endpointUrl(auth?.baseUrl ?? ctx.model?.baseUrl, api),
					requestHeaders(api, headers, auth, { "x-session-id": id }, ctx.model?.headers),
					JSON.stringify(buildSummaryBody(payload, budget, api)),
					collector,
					abort.signal,
				);
				if (!next.result.text.trim()) throw new Error("empty summary");
				const secs = Math.round((Date.now() - next.t0) / 1000);
				const u = next.result.usage;
				const promptIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
				notify(
					ctx,
					`Background compaction: summary ready in ${secs}s (${promptIn ? `${promptIn.toLocaleString()} tokens in` : `${cap.tokens!.toLocaleString()} tokens`}${u.cache_read_input_tokens ? `, ${u.cache_read_input_tokens.toLocaleString()} from prefix cache` : ""}, ${u.output_tokens ?? "?"} out); ready for the next compaction`,
				);
				// Stays visible until the compaction uses it, so it is clear one is on hand.
				if (c.statusBar) pill.finish(ctx, "ok", `● compaction ready · summary made in ${secs}s`, 0, "bg");
				prewarm(ctx, id, next);
			} catch (err) {
				next.result = undefined;
				next.error = abort.signal.aborted ? "aborted" : (err as Error).message;
				if (!abort.signal.aborted) {
					stats.lastBackgroundError = next.error;
					notify(ctx, `Background compaction failed (${next.error}); the next compaction runs normally`, "warning");
					if (c.statusBar) pill.finish(ctx, "warn", "⚠ background summary failed; will compact normally", 6_000, "bg");
				} else pill.clear(ctx, "bg");
			}
		})().catch(() => {});
		jobs.set(id, next);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		const c = cfg(ctx);
		const api = wireApi(ctx.model);
		if (!api || !appliesTo(ctx.model, c)) return;
		const id = ctx.sessionManager.getSessionId();
		const job = jobs.get(id);
		if (c.background && job && !event.customInstructions && job.modelKey === modelKey(ctx.model) && event.branchEntries.some((e) => e.id === job.firstKeptEntryId)) {
			const { preparation, signal } = event;
			const window = ctx.model?.contextWindow ?? 0;
			const tCompact = Date.now();
			if (!job.result && !job.error) {
				// Still streaming: waiting for the rest beats starting a summary from scratch.
				notify(ctx, `Compaction: background summary still running (${Math.round((Date.now() - job.t0) / 1000)}s so far); waiting for the rest instead of starting over`);
				if (c.statusBar) pill.start(ctx, (secs) => `finishing background summary · ~${fmtTokens(Math.round((job.collector.text.length + job.collector.thinkingChars) / 4))} out · ${secs}s`);
				const onAbort = () => job.abort.abort();
				signal.addEventListener("abort", onAbort, { once: true });
				await job.done;
				signal.removeEventListener("abort", onAbort);
				if (signal.aborted) {
					jobs.delete(id);
					pill.clear(ctx);
					return { cancel: true };
				}
			}
			if (job.result && backgroundFits(window, preparation.tokensBefore, job.tokensAt, job.result.text.length)) {
				if (job.prewarming && job.prewarmDone) {
					// The next request goes out right after this returns. Racing an in-flight pre-warm
					// of the same prefix makes it prefill everything itself (measured: 32.6 s vs 3.3 s
					// after the pre-warm finished), so let the pre-warm finish first. It only covers
					// the turns since the previous pre-warm, so this is normally a few seconds.
					if (c.statusBar) pill.start(ctx, (secs) => `finishing pre-warm · ${secs}s`);
					let onAbort = () => {};
					await Promise.race([
						job.prewarmDone,
						new Promise<void>((r) => {
							setTimeout(r, 90_000).unref?.();
						}),
						new Promise<void>((r) => {
							onAbort = () => r();
							signal.addEventListener("abort", onAbort, { once: true });
						}),
					]);
					signal.removeEventListener("abort", onAbort);
					if (signal.aborted) {
						pill.clear(ctx);
						return { cancel: true };
					}
				}
				jobs.delete(id);
				job.abort.abort(); // nothing in flight should outlive the job (a pre-warm finishes on its own)
				if (job.prewarms > 0) prewarmed.add(id);
				stats.compactions++;
				stats.backgroundUsed++;
				stats.lastSeconds = 0;
				notify(ctx, `Compaction: used background summary (${preparation.tokensBefore.toLocaleString()} tokens; kept everything after the summarized request)`);
				const took = ((Date.now() - tCompact) / 1000).toFixed(1);
				if (c.statusBar) pill.finish(ctx, "ok", `✓ compacted in ${took}s · ${job.prewarms ? "context pre-warmed" : "summary from background"}`);
				return {
					compaction: {
						// Exactly the pre-warmed text: a file-list suffix (only known now) would change
						// the summary message and lose the cache hit on everything after it.
						summary: job.result.text,
						firstKeptEntryId: job.firstKeptEntryId,
						tokensBefore: preparation.tokensBefore,
						usage: toPiUsage(job.result.usage),
					},
				};
			}
			if (job.result) notify(ctx, "Compaction: background summary is out of date (too much happened since it was made); compacting normally", "warning");
			dropJob(id); // failed or outgrown: fall through to the normal path
		}
		if (event.reason === "overflow") return; // context already over the window; nothing to reuse
		let cap = captures.get(id);
		if (!cap?.payload && c.persist) {
			// Resumed session compacting before its first turn: replay the request the previous
			// process sent. That prefix is what the server cached, whatever this process would
			// render now (the warm-up afterwards uses this process's converter).
			const stored = loadStored(id);
			if (stored) captures.set(id, (cap = { ...stored, headers: cap?.headers ?? stored.headers }));
		}
		if (!cap?.payload) return fallback(ctx, "no captured request yet in this process");
		if (cap.modelKey !== modelKey(ctx.model)) return fallback(ctx, "last captured request was from a different model");
		if (cap.stale) return fallback(ctx, "capture is stale after an earlier default compaction");

		const { preparation, signal } = event;
		const budget = summaryTokenBudget(ctx.model?.contextWindow ?? 0, preparation.tokensBefore, c);
		if (!budget) return fallback(ctx, "not enough room left in the context window");

		const { auth, error } = await resolveAuth(ctx);
		if (error) return fallback(ctx, `auth: ${error}`);

		const t0 = Date.now();
		const incremental = c.incremental && event.reason !== "overflow" ? preparation.previousSummary : undefined;
		notify(ctx, `Compaction: reusing cached prefix (${preparation.tokensBefore.toLocaleString()} tokens${incremental ? `, incremental (delta since last summary)` : ""})`);
		const collector = createCollector(api);
		if (c.statusBar) {
			const size = fmtTokens(preparation.tokensBefore);
			pill.start(ctx, (secs) => {
				// ~4 chars per token is only for a sense of motion, not a count.
				const out = collector.text.length + collector.thinkingChars;
				return out ? `summarizing ${size} · ~${fmtTokens(Math.round(out / 4))} out · ${secs}s` : `prefilling ${size} from cache · ${secs}s`;
			});
		}
		try {
			const { text, usage } = await streamMessages(
				endpointUrl(auth?.baseUrl ?? ctx.model?.baseUrl, api),
				requestHeaders(api, cap.headers, auth, { "x-session-id": id }, ctx.model?.headers),
				JSON.stringify(buildSummaryBody(cap.payload, budget, api, incremental)),
				collector,
				signal,
			);
			const secs = Math.round((Date.now() - t0) / 1000);
			stats.compactions++;
			stats.lastSeconds = secs;
			const cached = usage.cache_read_input_tokens;
			notify(ctx, `Compaction done in ${secs}s (${usage.output_tokens ?? "?"} tokens out${cached ? `, ${cached.toLocaleString()} prompt tokens served from prefix cache` : ""})`);
			// Warm-up (if any) takes over the pill in session_compact.
			if (c.statusBar) pill.finish(ctx, "ok", `✓ compacted in ${secs}s${cached ? ` · ${fmtTokens(cached)} cached` : ""}`);
			return {
				compaction: {
					summary: text + fileListSuffix(preparation.fileOps),
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					usage: toPiUsage(usage),
					// Incremental: carry the previous summary through so the NEXT cycle can
				// merge its delta into this one. Pi 0.99's prepareCompaction reads the prior
			// compaction entry's `summary` for preparation.previousSummary, so storing the
			// merged delta summary here is what makes the chain work. (Pi's own entries use
			// a details field for extension data; we keep the previous summary in it.)
					details: incremental ? { previousSummary: incremental } : undefined,
				},
			};
		} catch (err) {
			if (signal.aborted) {
				pill.clear(ctx);
				return { cancel: true };
			}
			return fallback(ctx, (err as Error).message);
		}
	});

	// Warm the new prefix (summary + kept messages) so the next turn is not a cold prefill.
	pi.on("session_compact", async (event, ctx) => {
		const c = cfg(ctx);
		const id = ctx.sessionManager.getSessionId();
		const cap = captures.get(id);
		// A Pi-default compaction means the captured prefix no longer describes the session.
		// Keep it only to feed the warm-up below; never for a summary again until a real turn
		// re-anchors it (before_provider_request clears `stale`).
		if (cap && !event.fromExtension) cap.stale = true;
		// The stored request now describes pre-compaction history; never replay it on resume.
		dropStored(id);
		dropJob(id); // any background summary describes pre-compaction history too
		pill.clear(ctx, "bg"); // a "compaction ready" pill would now be wrong
		if (!c.warmup || !appliesTo(ctx.model, c) || event.willRetry) return;
		if (!cap?.payload || !ctx.model) return;
		if (cap.modelKey !== modelKey(ctx.model)) return; // warmed prefix would not match the new model
		const warmed = prewarmed.delete(id);
		const warmup = async () => {
			try {
				const t0 = Date.now();
				if (c.statusBar) pill.start(ctx, (secs) => `warming next turn · ${secs}s`);
				await sendWarm(ctx, cap, id, ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
				stats.warmups++;
				stats.lastWarmupError = "";
				const warmSecs = Math.round((Date.now() - t0) / 1000);
				notify(ctx, `Context re-warmed in ${warmSecs}s; next turn starts from cache`);
				if (c.statusBar) pill.finish(ctx, "ok", `✓ compacted · warm in ${warmSecs}s`);
			} catch (err) {
				// Warm-up is best effort; the next turn simply prefills normally. The reason is
				// kept for /prefix-compaction so a silently failing warm-up is diagnosable.
				stats.lastWarmupError = (err as Error).message ?? String(err);
				if (c.statusBar) pill.finish(ctx, "warn", "⚠ warm-up failed; next turn prefills cold");
				if (process.env.PI_PREFIX_CACHE_DEBUG) console.error(`[pi-prefix-cache-compaction] warm-up failed: ${stats.lastWarmupError}`);
			}
		};
		if (!c.background) return void (await warmup().catch(() => {}));
		// Background mode never holds the session for a warm-up.
		if (warmed) return; // the post-compaction context was pre-warmed before Pi compacted
		// A request that is about to go out (auto-compaction mid-run) prefills this context
		// itself; a parallel warm-up would prefill the same tokens twice and slow it down.
		if (typeof ctx.isIdle === "function" && !ctx.isIdle()) return;
		void warmup().catch(() => {});
	});

	pi.registerCommand("prefix-compaction", {
		description: "pi-prefix-cache-compaction: status and config",
		handler: async (_args, ctx) => {
			const { config: c, problems } = loadConfig(ctx.cwd); // fresh read so edits are visible
			config = c;
			ctx.ui.notify(
				[
					`applies to current model: ${appliesTo(ctx.model, c)} (api: ${ctx.model?.api ?? "none"})`,
					`cached compactions: ${stats.compactions} (last ${stats.lastSeconds}s), fallbacks: ${stats.fallbacks}${stats.lastReason ? ` (last: ${stats.lastReason})` : ""}, warm-ups: ${stats.warmups}${stats.lastWarmupError ? ` (last warm-up error: ${stats.lastWarmupError})` : ""}`,
					`background summaries: ${stats.background} started, ${stats.backgroundUsed} used${stats.lastBackgroundError ? ` (last error: ${stats.lastBackgroundError})` : ""}; pre-warms: ${stats.prewarms}${stats.lastPrewarmError ? ` (last error: ${stats.lastPrewarmError})` : ""}`,
					`config: ${JSON.stringify(c)}`,
					...problems.map((p) => `config problem: ${p}`),
				].join("\n"),
				"info",
			);
		},
	});
}
