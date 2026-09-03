import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import z from "@deepseek-ai/schemastery";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
//#region lib/types/index.js
/**
* dsh-tui — an interactive terminal client for the DeepSeek Harness core
* agent. The bundle patch mounts no Host, HTTP, or browser layer: this plugin
* drives the SAME core Agent/Session machinery the headless profile uses, but
* keeps the process alive with a readline REPL, streams live `session/event`
* output to the terminal, and can swap sessions at runtime (`/new`,
* `/resume <id>`) through the published agent handle's disposer.
*
* Sessions persist through the base layer's jsonl backend
* (`$DSH_HOME/sessions`), the same store the Web UI reads, so a TUI session
* can be resumed in the browser and vice versa.
* @module dsh-tui
*/
/** Stable Cordis plugin name. */
const name = "tui";
/** Services required before the REPL can start. */
const inject = ["tuiStartup", "agentDefaultModel", "agents", "sessions"];
/** Validated lazy config — the startup service's flag values. */
const Config = z.object({
	resumeSessionId: z.string().default(""),
	workspace: z.string().default("")
});
/** The process streams the REPL drives; tests substitute captures. */
const internals = {
	stdin: process.stdin,
	stdout: process.stdout,
	stderr: process.stderr
};
/** Truncate long payloads so tool lines stay readable. */
function truncate(value, max) {
	const text = typeof value === "string" ? value : safeStringify(value);
	return text.length <= max ? text : `${text.slice(0, max)}…`;
}
function safeStringify(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
/** Small ANSI styling helper; a no-op when the stream is not a TTY. */
function makeStyle(enabled) {
	const wrap = (code) => (text) => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;
	return {
		dim: wrap(2),
		red: wrap(31),
		green: wrap(32),
		cyan: wrap(36)
	};
}
/** The REPL's built-in help text. */
const HELP_TEXT = `commands:
  /help                    show this help
  /new                     start a fresh session (previous sessions stay open until exit)
  /sessions [n]            list the most recent n persisted/live sessions (default 15)
  /resume <sessionId>      switch to a persisted session (e.g. /resume session-7)
  /resume #<n>             switch to entry #n from the last /sessions listing
  /session                 print the current session id
  /cwd                     print the current session working directory
  /stop                    cancel the running turn
  /exit  (/quit, /q)       exit the TUI

anything else is sent to the agent as a message. Text typed while the agent
is working is queued and answered after the current turn finishes.
`;
/** Human-readable age of a session from its createdAt epoch. */
function formatAge(createdAt) {
	if (typeof createdAt !== "number") return "?";
	const minutes = Math.floor((Date.now() - createdAt) / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 30) return `${days}d ago`;
	return new Date(createdAt).toISOString().slice(0, 10);
}
/** Render one live session event to the terminal. */
function renderEvent(io, style, state, event) {
	switch (event.type) {
		case "turn/start":
			state.thinking = false;
			return;
		case "assistant/chunk": {
			const chunk = event.data?.chunk;
			if (chunk?.type === "text-delta" && chunk.text !== "") io.stdout.write(chunk.text);
			else if (chunk?.type === "reasoning-delta" && chunk.text !== "" && !state.thinking) {
				state.thinking = true;
				io.stdout.write(`\n${style.dim("(thinking…)")}\n`);
			}
			return;
		}
		case "tool/call": {
			const call = event.data ?? {};
			io.stdout.write(`\n${style.dim(`[tool] ${call.name}(${truncate(call.arguments ?? "", 160)})`)}\n`);
			break;
		}
		case "tool/result": {
			const message = event.data?.message;
			if (message?.isError) io.stdout.write(`${style.red("[error]")} ${style.red(truncate(message.content, 240))}\n`);
			else io.stdout.write(`${style.dim("[ok]")}\n`);
			return;
		}
		case "turn/end": {
			const reason = event.data?.reason;
			if (reason?.kind === "error") io.stdout.write(`\n${style.red(`[error] ${reason.error?.message ?? "unknown error"}`)}\n`);
			else if (reason?.kind === "aborted") io.stdout.write(`\n${style.dim("[stopped]")}\n`);
			else if (reason?.kind === "completed") io.stdout.write("\n");
			return;
		}
	}
}
/**
* Run the REPL: create or resume one agent/session, stream its events, and
* serialize input handling so queued messages answer in order.
* @param ctx - plugin context carrying core services and the launcher's exit request.
* @param config - validated startup config.
* @param io - process-facing streams.
*/
async function run(ctx, config, io) {
	await ctx.get("loader")?.await();
	const agents = ctx.get("agents");
	const defaultModel = ctx.get("agentDefaultModel");
	if (agents === void 0 || defaultModel === void 0) return;
	const selection = defaultModel.currentSelection();
	const workspace = path.resolve(config.workspace === "" ? process.cwd() : config.workspace);
	const style = makeStyle(!!io.stdout.isTTY && process.env.NO_COLOR === undefined);
	const rl = readline.createInterface({
		input: io.stdin,
		output: io.stdout,
		terminal: !!io.stdin.isTTY,
		historySize: 200
	});
	// Do not consume input until the initial session exists: `agents.resume`
	// must run inside an active fiber (owner-lifecycle tracking) and lines
	// arriving earlier would race the first createSession.
	rl.pause();
	/** Repaint the prompt on TTYs only, so piped stdout stays clean. */
	const promptLine = () => {
		if (rl.terminal) rl.prompt();
	};
	/** The live published handle: { agent, dispose } or null. */
	let handle = null;
	/** Serialize input handling: one message/command at a time, in order. */
	let chain = Promise.resolve();
	let closed = false;
	/** In-flight chain items; EOF waits for the turn to drain before exiting. */
	let pending = 0;
	let waitingToClose = false;
	/** Stop reading and request a graceful process exit through the launcher. */
	const finish = (code) => {
		if (closed) return;
		closed = true;
		unsubscribe();
		rl.close();
		io.exit(code);
	};
	const setup = (agentCtx) => {
		installModelSelection(agentCtx, {
			current: selection,
			assembled: void 0
		});
	};
	async function createSession(resumeId) {
		if (resumeId === "") {
			const sessionId = SessionId(`session-tui-${randomUUID()}`);
			handle = await agents.create({
				sessionId,
				meta: { cwd: workspace },
				agentOptions: { provider: selection.provider, model: selection.model },
				setup
			});
		} else {
			// Resuming an id that is already alive in THIS process would collide
			// with the in-memory session store, so refuse it explicitly. Agents
			// are never disposed mid-process (the previous handle is simply
			// dropped): disposing the published handle tears down the agent
			// loop's factory registration along the owner-fiber chain, so
			// creating another agent afterwards fails. The tree owns cleanup.
			if (ctx.get("sessions")?.store.has(resumeId)) {
				throw new Error(`session ${JSON.stringify(resumeId)} is already open in this process; exit and relaunch with --resume to re-attach`);
			}
			handle = await agents.resume({
				resumeSessionId: resumeId,
				agentOptions: { provider: selection.provider, model: selection.model },
				setup
			});
		}
		const session = handle.agent.session;
		io.stdout.write(`${style.green(`tui: session ${session.id}`)} (cwd: ${session.header.cwd ?? workspace}, model: ${selection.model})\n`);
	}
	/** Ids from the last /sessions listing, newest first — for /resume #<n>. */
	let lastListed = [];
	/** List persisted/live sessions through the base-mounted sessionQuery service. */
	async function listSessions(rawLimit) {
		const sessionQuery = ctx.get("sessionQuery");
		if (sessionQuery === void 0) {
			io.stderr.write("tui: sessionQuery service unavailable in this composition\n");
			return;
		}
		const parsed = rawLimit === void 0 ? 15 : Number(rawLimit);
		const cap = Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 50) : 15;
		let records;
		try {
			records = await sessionQuery.listSessions();
		} catch (error) {
			io.stderr.write(`tui: cannot list sessions: ${error instanceof Error ? error.message : String(error)}\n`);
			return;
		}
		const shown = records.slice(0, cap);
		lastListed = shown.map((record) => record.header.id);
		if (shown.length === 0) {
			io.stdout.write("(no sessions yet)\n");
			return;
		}
		let titles = /* @__PURE__ */ new Map();
		try {
			const results = await sessionQuery.readTitleSnapshots(lastListed);
			for (const result of results ?? []) {
				if (result?.status !== "fulfilled") continue;
				const snapshot = result.value?.title;
				const titleText = typeof snapshot === "string" ? snapshot : snapshot?.title;
				if (typeof titleText === "string" && titleText !== "") titles.set(result.sessionId, titleText);
			}
		} catch {
			// titles are a nicety; listing still works without them
		}
		for (const [index, record] of shown.entries()) {
			const header = record.header ?? {};
			const title = titles.get(header.id);
			const suffix = title === void 0 || title === "" ? "" : ` — ${title}`;
			const marker = record.live ? style.green("*") : " ";
			io.stdout.write(`${marker} #${index + 1} ${header.id}${suffix}\n      cwd: ${header.cwd ?? "?"} (${formatAge(header.createdAt)})\n`);
		}
		io.stdout.write(`${style.dim(`use /resume #<1..${shown.length}> or /resume <sessionId>`)}\n`);
	}
	/** Handle one command line; returns "exit" when the process is exiting. */
	function handleCommand(line) {
		const parts = line.trim().split(/\s+/);
		const command = parts[0];
		const rest = parts.slice(1);
		switch (command) {
			case "/help":
			case "/h":
				io.stdout.write(HELP_TEXT);
				return;
			case "/exit":
			case "/quit":
			case "/q":
				finish(0);
				return "exit";
			case "/new":
				return createSession("");
			case "/sessions":
				return listSessions(rest[0]);
			case "/resume": {
				const target = rest[0];
				if (target === void 0) {
					io.stderr.write("usage: /resume <sessionId> | /resume #<n>\n");
					return;
				}
				const shorthand = /^#(\d+)$/.exec(target);
				if (shorthand !== null) {
					const picked = lastListed[Number(shorthand[1]) - 1];
					if (picked === void 0) {
						io.stderr.write(`tui: no entry #${shorthand[1]} — run /sessions first\n`);
						return;
					}
					return createSession(picked);
				}
				return createSession(target);
			}
			case "/session":
				io.stdout.write(`${handle?.agent.session.id ?? "(no session)"}\n`);
				return;
			case "/cwd":
				io.stdout.write(`${handle?.agent.session.header.cwd ?? workspace}\n`);
				return;
			case "/stop": {
				const agent = handle?.agent;
				if (agent !== void 0 && agent !== null && agent.status === "running") {
					agent.cancel({ kind: "user", message: "stopped by user" });
					io.stdout.write(`${style.dim("[stopping…]")}\n`);
				} else io.stdout.write(`${style.dim("(no running turn)")}\n`);
				return;
			}
			default:
				io.stderr.write(`tui: unknown command ${JSON.stringify(command)} — try /help\n`);
		}
	}
	/** Stream live events from the CURRENT session only. */
	const state = { thinking: false };
	const unsubscribe = ctx.on("session/event", (session, event) => {
		if (handle === null || session.id !== handle.agent.session.id) return;
		renderEvent(io, style, state, event);
	});
	rl.on("line", (line) => {
		pending += 1;
		chain = chain.then(async () => {
			try {
				const trimmed = line.trim();
				if (trimmed === "") return;
				if (trimmed.startsWith("/")) {
					if ((await handleCommand(trimmed)) === "exit") return;
					return;
				}
				const agent = handle?.agent;
				if (agent === void 0 || agent === null) {
					io.stderr.write("tui: no session yet — use /new first\n");
					return;
				}
				await agent.whenIdle();
				agent.followup(createUserMessage({
					content: [{ type: "text", text: trimmed }],
					source: { kind: "user" }
				}));
				await agent.whenIdle();
				promptLine();
			} catch (error) {
				io.stderr.write(`tui: ${error instanceof Error ? error.message : String(error)}\n`);
			} finally {
				pending -= 1;
				if (pending === 0 && waitingToClose) finish(0);
			}
		}).catch((error) => {
			io.stderr.write(`tui: ${error instanceof Error ? error.message : String(error)}\n`);
		});
	});
	rl.on("close", () => {
		if (pending === 0) finish(0);
		else waitingToClose = true;
	});
	// Boot banner and the initial session.
	io.stdout.write(`${style.cyan("dsh tui — DeepSeek Harness terminal client")}\n`);
	try {
		await createSession(config.resumeSessionId);
	} catch (error) {
		io.stderr.write(`tui: cannot start session: ${error instanceof Error ? error.message : String(error)}\n`);
		finish(1);
		return;
	}
	io.stdout.write(`${style.dim("type /help for commands — /exit to quit")}\n`);
	rl.resume();
	if (rl.terminal) rl.setPrompt("tui> ");
	promptLine();
}
/**
* Mount the REPL driver.
* @param ctx - plugin context carrying core services and the launcher-provided exit request.
* @param config - validated startup config.
*/
function apply(ctx, config) {
	const exit = ctx.get("appExit");
	if (exit === void 0) throw new Error("tui: the launcher must provide ctx.appExit before the tree mounts");
	const io = {
		stdin: internals.stdin,
		stdout: internals.stdout,
		stderr: internals.stderr,
		exit
	};
	// Terminal-surface context for every agent assembled in this profile
	// (mirrors how the web bundle adds its "app:web-surface" prompt section).
	ctx.inject(["systemPrompt"], (promptCtx) => {
		promptCtx.systemPrompt.section({
			name: "app:tui-surface",
			order: -98,
			text: () => `You are interacting with the user through dsh-tui, a terminal REPL client for DeepSeek Harness — there is NO browser GUI and NO directory picker. Messages arrive as plain-text lines typed at a prompt; everything you print goes to a terminal, so keep answers compact and prefer plain text. The user can type slash commands such as /help, /new, /sessions, /resume <sessionId>, /stop and /exit. Address files and directories by explicit absolute paths; the session working directory is the project root.`
		});
	});
	// Run inside an async-generator effect so an ACTIVE fiber lives for the
	// whole REPL: agents.resume() tracks its caller's owner context, and a
	// bare fire-and-forget promise would let that owner effect dispose as
	// soon as the loader's apply fiber ends, aborting the resume. (Cordis
	// effect bodies may yield only disposers/nullables, so the await lives
	// inside the generator instead of being yielded.)
	ctx.effect(async function* () {
		try {
			await run(ctx, config, io);
		} catch (error) {
			io.stderr.write(`tui: ${error instanceof Error ? error.message : String(error)}\n`);
			io.exit(1);
		}
	}, "tui.repl()");
}
//#endregion
export { Config, apply, inject, internals, name };
