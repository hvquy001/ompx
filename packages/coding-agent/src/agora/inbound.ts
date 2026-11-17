import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { loadImageAttachmentInput } from "../utils/image-loading";
import type { AgoraAttachment, AgoraChatMessage } from "./client";

export interface InboundDeps {
	download(url: string, dest: string, maxBytes: number): Promise<void>;
	inboxDir: string;
	maxBytes: number;
	isAllowed(actorId: string): boolean;
}

export interface ChatHistoryItem {
	id: string;
	author: string;
	author_id?: string;
	kind: "human" | "agent";
	excerpt: string;
}

export interface InboundTurn {
	text: string;
	images: ImageContent[];
}

const EXCERPT_MAX = 300;
const OMITTED_REPLY = "[earlier message from someone else omitted]";

/** Wrap text from outside the trust boundary; the closing tag inside the text is defused so it cannot end the block early. */
function quoted(text: string): string {
	return `<quoted untrusted>\n${text.replaceAll("</quoted", "<\\/quoted")}\n</quoted>`;
}

function sanitizeName(filename: string): string {
	const base = filename.split(/[\\/]/).pop() ?? "";
	return base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "") || "file";
}

/** `name` unchanged when free, else `stem-2.ext`, `stem-3.ext`, ... */
function uniqueName(name: string, used: Set<string>): string {
	let candidate = name;
	if (used.has(candidate)) {
		const ext = path.extname(name);
		const stem = name.slice(0, name.length - ext.length);
		for (let n = 2; used.has(candidate); n++) candidate = `${stem}-${n}${ext}`;
	}
	used.add(candidate);
	return candidate;
}

function replyLine(msg: AgoraChatMessage, history: ChatHistoryItem[], deps: InboundDeps): string | undefined {
	if (!msg.reply_to_id) return undefined;
	const item = history.find(h => h.id === msg.reply_to_id);
	const sender = msg.author;
	const allowed =
		item !== undefined &&
		(item.kind === "agent" ||
			(sender !== null &&
				item.author === sender.username &&
				(item.author_id === undefined || item.author_id === sender.id) &&
				deps.isAllowed(sender.id)));
	if (!item || !allowed) return OMITTED_REPLY;
	return `In reply to @${item.author}:\n${quoted(item.excerpt.slice(0, EXCERPT_MAX))}`;
}

async function loadImage(att: AgoraAttachment, dest: string): Promise<ImageContent | null> {
	const bytes = await fs.readFile(dest);
	const loaded = await loadImageAttachmentInput({
		image: { type: "image", data: bytes.toString("base64"), mimeType: att.mime },
		label: path.basename(dest),
		uri: dest,
		autoResize: true,
	});
	return loaded ? { type: "image", data: loaded.data, mimeType: loaded.mimeType } : null;
}

export async function toInboundTurn(
	msg: AgoraChatMessage,
	history: ChatHistoryItem[],
	deps: InboundDeps,
): Promise<InboundTurn> {
	const sections: string[] = [`From @${msg.author?.username ?? "unknown"}:`];
	const reply = replyLine(msg, history, deps);
	if (reply) sections.push(reply);
	sections.push(msg.body);
	if (msg.context?.text) sections.push(`Page context:\n${quoted(msg.context.text)}`);

	const images: ImageContent[] = [];
	const files: string[] = [];
	const used = new Set<string>();
	if (msg.attachments.length > 0) await fs.mkdir(deps.inboxDir, { recursive: true });
	for (const att of msg.attachments) {
		const name = uniqueName(sanitizeName(att.filename), used);
		if (att.size > deps.maxBytes) {
			files.push(`${name} skipped: larger than ${Math.round((deps.maxBytes / 1024 / 1024) * 10) / 10} MB`);
			continue;
		}
		const dest = path.resolve(deps.inboxDir, name);
		try {
			await deps.download(att.url, dest, deps.maxBytes);
		} catch {
			files.push(`${name} skipped: download failed`);
			continue;
		}
		if (att.kind === "image") {
			try {
				const image = await loadImage(att, dest);
				if (image) {
					images.push(image);
					continue;
				}
			} catch {
				// undecodable image: fall through and list it like a file
			}
		}
		files.push(dest);
	}
	if (files.length > 0) sections.push(`Files:\n${files.join("\n")}`);

	return { text: sections.join("\n\n"), images };
}
