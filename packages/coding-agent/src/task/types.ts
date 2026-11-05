import { type BaseType, type FluentType, type } from "@oh-my-pi/omptype";
import {
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import {
	type AgentProgress,
	type AgentSource,
	LABEL_MAX,
	oneLineLabel,
	type SubagentRunTelemetry,
} from "@oh-my-pi/pi-tui/tools/task";
import { $env, isRecord } from "@oh-my-pi/pi-utils";

import type { AgentSessionEvent } from "../session/agent-session";

// The task types moved to `@oh-my-pi/pi-tui/tools/task` (and the observer
// registry) upstream; this module keeps only the runtime pieces that live in
// the coding agent and re-exports the canonical shapes so existing
// `./task/types` importers keep resolving to the single definition.
export { LABEL_MAX, oneLineLabel, TASK_SUBAGENT_LIFECYCLE_CHANNEL, TASK_SUBAGENT_PROGRESS_CHANNEL };
export type {
	AgentProgress,
	AgentSource,
	NestedRepoPatch,
	ReviewData,
	ReviewFinding,
	ReviewGateIteration,
	ReviewGateOutcome,
	ReviewGateProgress,
	ReviewGateResult,
	ReviewSummary,
	SingleResult,
	StructuredSubagentOutput,
	StructuredSubagentSchemaMode,
	StructuredSubagentSchemaSource,
	StructuredSubagentValidationStatus,
	SubagentAbortReason,
	SubagentRunPhase,
	SubagentRunStatus,
	SubagentRunTelemetry,
	SubagentRunTimings,
	TaskItem,
	TaskParams,
	TaskToolDetails,
	YieldItem,
} from "@oh-my-pi/pi-tui/tools/task";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

export const MAX_TASK_FILE_BYTES = 4 * 1024 * 1024;

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** Session custom-entry discriminator for persisted subagent runtime telemetry. */
export const SUBAGENT_RUN_CUSTOM_TYPE = "subagent_run";

/** Payload emitted on TASK_SUBAGENT_PROGRESS_CHANNEL */
export interface SubagentProgressPayload {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
	/** See {@link SubagentLifecyclePayload.detached}. */
	detached?: boolean;
}
/** Payload emitted on TASK_SUBAGENT_EVENT_CHANNEL */
export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

/** Payload emitted on TASK_SUBAGENT_LIFECYCLE_CHANNEL */
export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	agentSource: AgentSource;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
	/** Present only on terminal lifecycle events. */
	telemetry?: SubagentRunTelemetry;
	/**
	 * Spawn runs as a detached background job: the parent turn keeps working
	 * while this agent runs. Sync task spawns (parent blocked on the call) and
	 * eval `agent()` bridge spawns (rendered inside their eval cell) leave this
	 * unset — surfaces like the subagent HUD only list detached spawns.
	 */
	detached?: boolean;
}

// Keep this explicit: ArkType serializes `unknown` as a boolean subschema, which llama.cpp grammars reject.
const outputSchemaInputSchema = type("object | boolean | string | null");
// Coarse per-spawn thinking effort; must stay in sync with TASK_EFFORTS in ../thinking.
const effortRule = '"lo" | "med" | "hi"' as const;

// Per-spawn fields the seance schema adds or widens. Typed against
// SeanceTaskSchemaFields so a field added there fails to compile until it is
// listed here too; a missed key would be dropped on batch items.
const SEANCE_ITEM_KEY_SET = { sourceSession: true, model: true } as const satisfies Record<SeanceItemKey, true>;
const SEANCE_ITEM_KEYS = Object.keys(SEANCE_ITEM_KEY_SET);

/**
 * Keep a batch item's seance keys through undeclared-key deletion: the item
 * schema declares `sourceSession` only while seance is advertised, and argument
 * validation re-attaches only root keys, so without this a
 * `tasks[].sourceSession` on an ordinary agent is deleted before execute()
 * instead of reaching the refusal. Other stale item keys are still deleted, and
 * the wire schema is unchanged.
 */
function keepSeanceItemKeys<T, I>(item: FluentType<T, I>): FluentType<unknown, I> {
	return item.onUndeclaredKey("ignore").pipe((input: unknown): unknown => {
		const out: unknown = item(input);
		if (out instanceof type.errors || !isRecord(out) || !isRecord(input)) return out;
		for (const key of SEANCE_ITEM_KEYS) {
			if (Object.hasOwn(input, key) && !Object.hasOwn(out, key)) out[key] = input[key];
		}
		return out;
	});
}

export const taskItemSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"max_runtime_seconds?": "number.integer >= 0",
	"self_review?": "boolean",
	solutionSpace: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"model?": "string",
	"+": "delete",
});
const taskItemSchemaIsolated = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	solutionSpace: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"model?": "string",
	"isolated?": "boolean",
	"max_runtime_seconds?": "number.integer >= 0",
	"self_review?": "boolean",
	"+": "delete",
});

export const taskSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"max_runtime_seconds?": "number.integer >= 0",
	solutionSpace: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"model?": "string",
	"isolated?": "boolean",
	"self_review?": "boolean",
	"+": "delete",
});
const taskSchemaNoIsolation = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"max_runtime_seconds?": "number.integer >= 0",
	"self_review?": "boolean",
	solutionSpace: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"model?": "string",
	"+": "delete",
});
function guardBatchAgent(schema: BaseType): BaseType {
	// Inspect the input before undeclared-key deletion can erase the requested agent.
	return schema.in
		.narrow((params, ctx) => {
			if (params !== null && typeof params === "object" && Object.hasOwn(params, "agent")) {
				return ctx.reject("a batch with `agent` specified in `tasks[].agent`, not at the top level");
			}
			return true;
		})
		.pipe(schema);
}

const taskSchemaBatch = guardBatchAgent(
	type.raw({
		context: "string",
		tasks: keepSeanceItemKeys(taskItemSchemaIsolated).array(),
		"+": "delete",
	}),
);
const taskSchemaBatchNoIsolation = guardBatchAgent(
	type.raw({
		context: "string",
		tasks: keepSeanceItemKeys(taskItemSchema).array(),
		"+": "delete",
	}),
);
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema | BaseType;

const TASK_AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const taskSchemaCache = new Map<string, BaseType>();

function taskAgentSchemaRule(defaultAgent: string): string {
	const trimmed = defaultAgent.trim();
	if (TASK_AGENT_NAME_PATTERN.test(trimmed)) {
		return `string = '${trimmed}'`;
	}
	return "string";
}

/** Task fields the seance schema adds or widens; `seanceTaskSchemaFields` in ./seance must match it exactly. */
export type SeanceTaskSchemaFields = {
	"sourceSession?"?: FluentType<string>;
	"model?"?: FluentType<string | string[]>;
};

type SeanceItemKey = {
	[K in keyof SeanceTaskSchemaFields]-?: K extends `${infer Name}?` ? Name : never;
}[keyof SeanceTaskSchemaFields];

function createTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent: string;
	effortEnabled: boolean;
	evalToolsEnabled: boolean;
	structured: boolean;
	file: boolean;
	seanceFields: SeanceTaskSchemaFields;
}): BaseType {
	const agent = taskAgentSchemaRule(options.defaultAgent);
	const taskFields = options.file ? { "task?": "string", "taskFile?": "string" } : { task: "string" };
	const effortField = options.effortEnabled ? { "effort?": effortRule } : {};
	const schemaFields = options.structured
		? { "outputSchema?": outputSchemaInputSchema, "schemaMode?": '"permissive" | "strict"' }
		: {};
	const toolsField = options.evalToolsEnabled ? { "tools?": "string[]" } : {};
	// `model` is always declared, and preflight decides whether a per-call model
	// is allowed; seance widens it to a list.
	const seanceFields = { "model?": "string", ...options.seanceFields };
	if (options.batchEnabled) {
		if (options.isolationEnabled) {
			const item = type.raw({
				"name?": "string",
				agent,
				...taskFields,
				solutionSpace: "string",
				...effortField,
				...schemaFields,
				...toolsField,
				...seanceFields,
				"isolated?": "boolean",
				"max_runtime_seconds?": "number.integer >= 0",
				"self_review?": "boolean",
				"+": "delete",
			});
			return guardBatchAgent(
				type.raw({
					context: "string",
					tasks: keepSeanceItemKeys(item).array(),
					"+": "delete",
				}),
			);
		}
		const item = type.raw({
			"name?": "string",
			agent,
			...taskFields,
			"max_runtime_seconds?": "number.integer >= 0",
			"self_review?": "boolean",
			solutionSpace: "string",
			...effortField,
			...schemaFields,
			...toolsField,
			...seanceFields,
			"+": "delete",
		});
		return guardBatchAgent(
			type.raw({
				context: "string",
				tasks: keepSeanceItemKeys(item).array(),
				"+": "delete",
			}),
		);
	}
	if (options.isolationEnabled) {
		return type.raw({
			"name?": "string",
			agent,
			...taskFields,
			"max_runtime_seconds?": "number.integer >= 0",
			solutionSpace: "string",
			...effortField,
			...schemaFields,
			...toolsField,
			...seanceFields,
			"isolated?": "boolean",
			"self_review?": "boolean",
			"+": "delete",
		});
	}
	return type.raw({
		"name?": "string",
		agent,
		...taskFields,
		"max_runtime_seconds?": "number.integer >= 0",
		"self_review?": "boolean",
		solutionSpace: "string",
		...effortField,
		...schemaFields,
		...toolsField,
		...seanceFields,
		"+": "delete",
	});
}

/** Build the task wire schema for the current settings and spawn policy. */
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	effortEnabled?: boolean;
	/** Advertise the `tools` field for eval-defined tools (`eval.tools.enabled`, default on). */
	evalToolsEnabled?: boolean;
	/** Advertise `outputSchema`/`schemaMode` (`task.structured`); default on. */
	structured?: boolean;
	/** Advertise `taskFile` (`task.file`); default off. */
	file?: boolean;
	defaultAgent?: string;
	/** Advertise historical source/model fields for the bundled seance agent. */
	seanceFields?: SeanceTaskSchemaFields;
}): TaskToolSchemaInstance {
	const defaultAgent = options.defaultAgent ?? "task";
	const effortEnabled = options.effortEnabled ?? false;
	const evalToolsEnabled = options.evalToolsEnabled ?? true;
	const structured = options.structured ?? true;
	const file = options.file ?? false;
	const seanceFields = options.seanceFields ?? {};
	if (defaultAgent === "task" && !effortEnabled && evalToolsEnabled && structured && !file && !options.seanceFields) {
		if (options.batchEnabled) return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
		return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
	}
	const key = `${options.isolationEnabled ? "iso" : "flat"}:${options.batchEnabled ? "batch" : "single"}:${effortEnabled ? "effort" : "default"}:${evalToolsEnabled ? "tools" : "notools"}:${structured ? "structured" : "prose"}:${file ? "file" : "inline"}:${options.seanceFields ? "seance" : "plain"}:${defaultAgent}`;
	const cached = taskSchemaCache.get(key);
	if (cached) return cached;
	const schema = createTaskSchema({
		...options,
		effortEnabled,
		evalToolsEnabled,
		structured,
		file,
		defaultAgent,
		seanceFields,
	});
	taskSchemaCache.set(key, schema);
	return schema;
}

/** Select the stable roster and telemetry label for a specialized subagent. */
export function resolveSubagentDisplayName(role: string | undefined, agentName: string): string {
	const trimmed = role?.trim();
	return trimmed ? oneLineLabel(trimmed) : agentName;
}

/**
 * Whether an agent at `taskDepth` may still spawn children — i.e. it currently
 * holds the `task` tool. Mirrors the task-tool availability gate;
 * `maxRecursionDepth < 0` disables the cap entirely.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

/**
 * Agent-local review-gate policy declared in agent frontmatter.
 *
 * When present on the selected agent, it overrides the global `task.reviewGate.*`
 * defaults for that agent invocation. This lets bundled/native agents opt into
 * strict, light, or disabled review behavior without requiring user config.
 */
export interface AgentReviewGatePolicy {
	enabled: boolean;
	reviewerAgent?: string;
	reviewerModel?: string[];
	fixerAgent?: string;
	maxFixIterations?: number;
	failOnPriorities?: number[];
	requireCorrectVerdict?: boolean;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	resourceProfile?: "minimal";
	/** `true` = task spawns keep the `yield` tool and this agent's `output` schema even when `task.structured` is off. */
	structured?: boolean;
	autoloadSkills?: string[];
	reviewGate?: AgentReviewGatePolicy;
	/** When `false`, the agent's `read` tool returns verbatim file content instead of structural summaries. */
	readSummarize?: boolean;
	/** Prewalk hand-off for the spawned session: `true` = switch to the default prewalk target at the first edit/write, string = custom target model pattern. */
	prewalk?: boolean | string;
	/** Advisor for spawned sessions of this agent: `true` = advise with the default advisor-role model, string = advise with that model pattern (optional `:level` suffix). Absent/`false` = no advisor. */
	advisor?: boolean | string;
	source: AgentSource;
	filePath?: string;
}
