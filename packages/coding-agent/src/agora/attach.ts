/** `agora_attach`: the host tool that lets a session attach a workspace file to its next Agora reply. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { defineRpcClientTool, type RpcClientCustomTool } from "../modes/rpc/rpc-client";
import type { AgoraClient } from "./client";

/** Agora's upload limit. */
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

export interface AttachedFile {
	id: string;
	filename: string;
	caption?: string;
}

export interface AttachToolOptions {
	cwd: string;
	/** Root of the downloaded inbound files (`<session_dir>/inbox`). */
	inboxDir: string;
	/** The Agora env file holding the token; never attachable. */
	envFile: string;
	client: Pick<AgoraClient, "upload">;
	queue: { push(file: AttachedFile): void };
	maxBytes?: number;
}

/** realpath, or undefined when the path does not exist. */
async function realpathOrUndefined(file: string): Promise<string | undefined> {
	try {
		return await fs.realpath(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

export function createAttachTool(options: AttachToolOptions): RpcClientCustomTool {
	const { cwd, inboxDir, envFile, client, queue, maxBytes = MAX_ATTACH_BYTES } = options;
	return defineRpcClientTool<{ path: string; caption?: string }>({
		name: "agora_attach",
		description:
			"Attach a file from this workspace (image, log, patch, build output) to your next reply in this Agora chat.",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, caption: { type: "string" } },
			required: ["path"],
		},
		async execute({ path: requested, caption }) {
			if (typeof requested !== "string" || !requested) throw new Error("path is required");
			const real = await realpathOrUndefined(path.resolve(cwd, requested));
			if (!real) throw new Error(`No such file: ${requested}`);
			// Resolve the roots too, so a symlinked cwd or inbox compares like the file does.
			const roots = (await Promise.all([realpathOrUndefined(cwd), realpathOrUndefined(inboxDir)])).filter(
				(root): root is string => root !== undefined,
			);
			if (!roots.some(root => real.startsWith(root + path.sep))) {
				throw new Error("Only files inside the workspace or the chat inbox can be attached");
			}
			const envPath =
				envFile === "~" || envFile.startsWith("~/") ? path.join(os.homedir(), envFile.slice(1)) : envFile;
			if (real === ((await realpathOrUndefined(envPath)) ?? path.resolve(envPath))) {
				throw new Error("This file cannot be attached");
			}
			const stat = await fs.stat(real);
			if (!stat.isFile()) throw new Error(`Not a file: ${requested}`);
			if (stat.size > maxBytes) {
				throw new Error(`File is too large to attach (${stat.size} bytes, limit ${maxBytes})`);
			}
			const attachment = await client.upload(real);
			queue.push({ id: attachment.id, filename: attachment.filename, ...(caption ? { caption } : {}) });
			return `attached ${attachment.filename}`;
		},
	});
}
