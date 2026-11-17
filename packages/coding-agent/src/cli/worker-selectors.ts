/**
 * Hidden argv selectors for internal re-entry into the single CLI entrypoint
 * (`cli.ts` declares itself the worker host; worker threads and worker
 * subprocesses re-enter `Bun.main` with one of these as argv[0]).
 *
 * Keep these strings independent of each worker's protocol module: the CLI must
 * recognize a worker before importing protocol/runtime graphs whose top-level
 * evaluation is unnecessary in an ordinary interactive process.
 *
 * These never start a user session: they must be dispatched before — and
 * excluded from — the macOS self-sandbox relaunch. Otherwise a worker thread
 * re-entering the CLI inside an unsandboxed macOS process (e.g. the
 * `--smoke-test` probe) wraps itself into a detached `sandbox-exec` clone
 * that can never receive the thread's postMessage traffic, and the parent
 * hangs waiting for a pong (v1.2.0 darwin release smoke failure).
 */
/** Background self-update selector shared by the CLI dispatcher and `cli/auto-update.ts`. */
export const AUTO_UPDATE_WORKER_ARG = "__omp_worker_auto_update";
/** Blob-broker selector shared by the CLI dispatcher and worker launcher. */
export const BLOB_BROKER_WORKER_ARG = "__omp_worker_blob_broker";
/** Computer-worker selector shared by the CLI dispatcher and worker launcher. */
export const COMPUTER_WORKER_ARG = "__omp_worker_computer";
/** Daemon-broker selector shared by the CLI dispatcher and worker launcher. */
export const DAEMON_BROKER_WORKER_ARG = "__omp_worker_daemon_broker";
/** Disassembler-host selector shared by the CLI dispatcher and the broker daemon spec. */
export const DISASM_HOST_WORKER_ARG = "__omp_worker_disasm_host";
/** Mnemopi shared embedding-server selector shared by the CLI dispatcher and `embed-client.ts`. */
export const MNEMOPI_EMBED_SERVER_WORKER_ARG = "__omp_worker_mnemopi_embed_server";
/** LSP-multiplexer selector shared by the CLI dispatcher and worker launcher. */
export const LSP_MUX_WORKER_ARG = "__omp_worker_lsp_mux";
/** Parent-death watchdog thread selector shared by the CLI dispatcher and `startParentWatchdog`. */
export const PARENT_WATCHDOG_WORKER_ARG = "__omp_worker_parent_watchdog";
/** Subagent host worker selector shared by the CLI dispatcher and `SubagentWorker`. */
export const SUBAGENT_WORKER_ARG = "__omp_worker_subagent";
/** Activity-worker selector shared by the CLI dispatcher and worker launcher. */
export const STATS_ACTIVITY_WORKER_ARG = "__omp_worker_stats_activity";
/** Text-prediction daemon selector shared by the CLI dispatcher and the broker daemon spec. */
export const TEXT_PREDICT_WORKER_ARG = "__omp_worker_text_predict";
/** Terminal-output selector shared by the CLI dispatcher and worker launcher. */
export const TERMINAL_OUTPUT_WORKER_ARG = "__omp_worker_terminal_output";

export const TINY_WORKER_ARG = "__omp_worker_tiny_inference";
export const TINY_WORKER_ARGS: Record<string, true> = {
	[TINY_WORKER_ARG]: true,
	"--tiny-worker": true,
	__tiny_worker: true,
};
export const STATS_SYNC_WORKER_ARG = "__omp_worker_stats_sync";
/** Spotlight aggregation worker selector shared by the CLI dispatcher and `@oh-my-pi/omp-stats`. */
export const STATS_SPOTLIGHT_WORKER_ARG = "__omp_worker_stats_spotlight";
export const TAB_WORKER_ARG = "__omp_worker_tab";
export const JS_EVAL_WORKER_ARG = "__omp_worker_js_eval";

/** Every internal worker re-entry selector (thread and subprocess forms). */
export const INTERNAL_WORKER_ENTRY_ARGS: Record<string, true> = {
	...TINY_WORKER_ARGS,
	[STATS_SYNC_WORKER_ARG]: true,
	[STATS_SPOTLIGHT_WORKER_ARG]: true,
	[TAB_WORKER_ARG]: true,
	[JS_EVAL_WORKER_ARG]: true,
};
