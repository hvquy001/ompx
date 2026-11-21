/** Maps omp's per-step transcript onto one stateful agy turn. */
import { createHash } from "node:crypto";
import { prompt, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { ContentBlock } from "@oh-my-pi/pi-utils/acp";
import type {
	AntigravityCliCheckpoint,
	DeveloperMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "../../types";
import lateToolResultTemplate from "./late-tool-result.md" with { type: "text" };
import transcriptTemplate from "./transcript.md" with { type: "text" };

/** The exact leading transcript represented by the live conversation. */
export interface Ledger {
	count: number;
	digest: string;
	pendingToolCallId?: string;
}

/** New user-side input for agy. */
export type InputMessage = UserMessage | DeveloperMessage;

export type TurnPlan =
	| { kind: "resume"; toolResult?: ToolResultMessage; input: InputMessage[] }
	| {
			kind: "restore";
			conversationId: string;
			digest: string;
			checkpoint: AntigravityCliCheckpoint;
			replay: Message[];
	  }
	| { kind: "fresh"; replay: Message[] };

/** Reuse only an exact visible prefix; otherwise fork a recorded turn end or reseed. */
export function planTurn(messages: readonly Message[], ledger: Ledger | undefined): TurnPlan {
	if (
		ledger &&
		messages.length > ledger.count &&
		transcriptDigest(messages.slice(0, ledger.count)) === ledger.digest
	) {
		const tail = messages.slice(ledger.count);
		const first = tail[0];
		const toolResult =
			ledger.pendingToolCallId !== undefined &&
			first?.role === "toolResult" &&
			first.toolCallId === ledger.pendingToolCallId
				? first
				: undefined;
		const input = toolResult ? tail.slice(1) : tail;
		if ((ledger.pendingToolCallId === undefined || toolResult) && input.every(isInputMessage)) {
			return { kind: "resume", toolResult, input };
		}
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const payload = message.providerPayload;
		if (payload?.type !== "antigravityCli" || !payload.checkpoint) continue;
		if (transcriptDigest(messages.slice(0, index + 1)) !== payload.digest) continue;
		return {
			kind: "restore",
			conversationId: payload.conversationId,
			digest: payload.digest,
			checkpoint: payload.checkpoint,
			replay: messages.slice(index + 1),
		};
	}
	return { kind: "fresh", replay: [...messages] };
}

/**
 * Fingerprint model-visible ordered content, excluding timestamps, usage and presentation metadata.
 * agy's own replies count only by their tool-call ids.
 */
export function transcriptDigest(messages: readonly Message[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		hash.update(stableStringifyJson(messageContent(message)));
		hash.update("\n");
	}
	return hash.digest("hex");
}

/**
 * Safe UTF-8 byte budget for a single `<conversation-checkpoint>` replay prompt.
 * agy silently truncates oversized single prompts from the tail (observed on >224K
 * Vietnamese chars / ~312KB UTF-8, while 150KB passed intact), dropping recent turns
 * and causing amnesia loops. Staying under 120KB UTF-8 keeps both ASCII and multi-byte
 * Vietnamese transcripts safely below that ceiling with room for trailing user input.
 */
export const REPLAY_MAX_BYTES = 120_000;
const IMAGE_BYTE_WEIGHT = 4_000;

/** Replay earlier turns as labelled text and image blocks, keeping the newest tail within budget, then send trailing input directly. */
export function replayPrompt(replay: readonly Message[], maxBytes = REPLAY_MAX_BYTES): ContentBlock[] {
	let split = replay.length;
	while (split > 0 && isInputMessage(replay[split - 1]!)) split--;
	const blocks: ContentBlock[] = [];
	if (split > 0) {
		const history = replay.slice(0, split);
		const kept: ContentBlock[][] = [];
		let usedBytes = 0;
		for (let index = history.length - 1; index >= 0; index--) {
			const rendered = renderCheckpointMessage(history[index]!);
			const size = blocksWeight(rendered);
			if (kept.length > 0 && usedBytes + size > maxBytes) break;
			kept.push(kept.length === 0 && size > maxBytes ? trimBlocksTail(rendered, maxBytes) : rendered);
			usedBytes += Math.min(size, maxBytes);
		}
		kept.reverse();
		const omitted = history.length - kept.length;
		blocks.push({ type: "text", text: prompt.render(transcriptTemplate, {}) });
		if (omitted > 0) {
			blocks.push({
				type: "text",
				text: `[${omitted} earlier message${omitted === 1 ? "" : "s"} omitted to stay within Antigravity's single-prompt limit; showing the ${kept.length} most recent.]`,
			});
		}
		for (const messageBlocks of kept) blocks.push(...messageBlocks);
		blocks.push({ type: "text", text: "</conversation-checkpoint>" });
	}
	for (const message of replay.slice(split)) {
		if (isInputMessage(message)) blocks.push(...inputBlocks(message));
	}
	return blocks;
}

function renderCheckpointMessage(message: Message): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	const tag = message.role === "toolResult" ? "tool_result" : message.role;
	const attrs =
		message.role === "toolResult"
			? ` id=${JSON.stringify(message.toolCallId)} name=${JSON.stringify(message.toolName)} error=${message.isError}`
			: "";
	blocks.push({ type: "text", text: `<${tag}${attrs}>` });
	if (typeof message.content === "string") blocks.push({ type: "text", text: message.content });
	else
		for (const part of message.content) {
			switch (part.type) {
				case "text":
					blocks.push({ type: "text", text: part.text });
					break;
				case "image":
					blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
					break;
				case "thinking":
					blocks.push({ type: "text", text: `<thinking>${part.thinking}</thinking>` });
					break;
				case "toolCall":
					blocks.push({
						type: "text",
						text: `<tool_call id=${JSON.stringify(part.id)} name=${JSON.stringify(part.name)}>${stableStringifyJson(part.arguments)}</tool_call>`,
					});
					break;
			}
		}
	blocks.push({ type: "text", text: `</${tag}>` });
	return blocks;
}

function blocksWeight(blocks: readonly ContentBlock[]): number {
	let total = 0;
	for (const block of blocks) {
		total += block.type === "text" ? Buffer.byteLength(block.text, "utf8") : IMAGE_BYTE_WEIGHT;
	}
	return total;
}

function trimBlocksTail(blocks: readonly ContentBlock[], maxBytes: number): ContentBlock[] {
	if (blocks.length <= 2) return [...blocks];
	const open = blocks[0]!;
	const close = blocks[blocks.length - 1]!;
	let remaining = Math.max(0, maxBytes - blocksWeight([open, close]));
	const middle: ContentBlock[] = [];
	for (let index = blocks.length - 2; index >= 1 && remaining > 0; index--) {
		const block = blocks[index]!;
		if (block.type !== "text") {
			if (remaining >= IMAGE_BYTE_WEIGHT) {
				middle.push(block);
				remaining -= IMAGE_BYTE_WEIGHT;
			}
			continue;
		}
		const byteLen = Buffer.byteLength(block.text, "utf8");
		if (byteLen <= remaining) {
			middle.push(block);
			remaining -= byteLen;
		} else {
			const buf = Buffer.from(block.text, "utf8");
			const sliced = buf.subarray(Math.max(0, buf.length - remaining)).toString("utf8");
			middle.push({ type: "text", text: `...[truncated]...\n${sliced}` });
			remaining = 0;
		}
	}
	middle.reverse();
	return [open, ...middle, close];
}

/** Supply the actual delayed result only after agy's old prompt has confirmed cancellation. */
export function lateToolResultPrompt(result: ToolResultMessage): ContentBlock[] {
	return [
		{
			type: "text",
			text: prompt.render(lateToolResultTemplate, {
				toolName: result.toolName,
				toolCallId: result.toolCallId,
				isError: result.isError,
			}),
		},
		...contentBlocks(result.content),
		{ type: "text", text: "</tool_result>" },
	];
}

/** ACP input preserves text/image ordering and the complete image bytes. */
export function inputBlocks(message: InputMessage): ContentBlock[] {
	return contentBlocks(message.content);
}

/** Whether a transcript message can be sent directly as ACP user input. */
export function isInputMessage(message: Message): message is InputMessage {
	return message.role === "user" || message.role === "developer";
}

function contentBlocks(content: string | readonly (TextContent | ImageContent)[]): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map(part =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", data: part.data, mimeType: part.mimeType },
	);
}

function messageContent(message: Message): unknown {
	// agy keeps its own copy of what it wrote, and hosts may rewrite that text before
	// sending it back (secret obfuscation, redaction). Its tool-call ids still pin the turn.
	if (message.role === "assistant" && message.api === "antigravity-acp") {
		return {
			role: message.role,
			toolCalls: message.content.flatMap(part => (part.type === "toolCall" ? [part.id] : [])),
		};
	}
	const content =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.flatMap((part): unknown[] => {
					switch (part.type) {
						case "text":
							return [{ type: part.type, text: part.text }];
						case "image":
							return [{ type: part.type, data: part.data, mimeType: part.mimeType }];
						case "thinking":
							return [{ type: part.type, thinking: part.thinking }];
						case "toolCall":
							return [{ type: part.type, id: part.id, name: part.name, arguments: part.arguments }];
						// Opaque blocks from other providers are not sent to agy.
						default:
							return [];
					}
				});
	return message.role === "toolResult"
		? {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				content,
			}
		: { role: message.role, content };
}
