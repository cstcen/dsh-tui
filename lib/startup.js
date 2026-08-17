import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";
//#region lib/types/startup.js
/**
* The tui app's command-line provider: it parses the `dsh --profile tui` flag
* family (`--resume`, `--workspace`) and its `--help` text, then provides the
* immutable values as {@link TUI_STARTUP_SERVICE}. The REPL row injects that
* service before reading it from lazy config.
* @module dsh-tui/startup
*/
/** Stable Cordis plugin name. */
const name = "tui-startup";
/** Services required before the flags can be resolved. */
const inject = ["cmdlineArgs"];
/** Service provided by this plugin and injected by the REPL row. */
const TUI_STARTUP_SERVICE = "tuiStartup";
/**
* This app's command: its flags, its description, and its help text.
* @returns a fresh program, so one process can parse more than once (tests).
*/
function tuiCommand() {
	return new Command().name("dsh --profile tui").description("Interactive terminal client for the DeepSeek Harness core agent.").helpOption("-h, --help", "show this help").option("--resume <sessionId>", "resume an existing persisted session by id (e.g. session-7)").option("--workspace <dir>", "working directory for the session (default: the current directory)").addHelpText("after", `
Examples:
  dsh --profile tui                        start a new session in the current directory
  dsh --profile tui --resume session-7     resume a persisted session
  dsh --profile tui --workspace ~/Code/x   start a session rooted at another directory
`);
}
/**
* Parse and provide the TUI invocation as an ordinary Cordis service. The
* command's action publishes the flags this invocation named; on `--help` or a
* grammar rejection nothing is provided and commander exits the process.
* @param ctx - plugin context carrying the command line.
*/
function apply(ctx) {
	const program = tuiCommand();
	program.action(() => {
		const options = program.opts();
		ctx.provide(TUI_STARTUP_SERVICE, {
			resumeSessionId: options.resume ?? "",
			workspace: options.workspace ?? process.cwd()
		});
	});
	parseCmdline(ctx, program);
}
//#endregion
export { TUI_STARTUP_SERVICE, apply, inject, name };
