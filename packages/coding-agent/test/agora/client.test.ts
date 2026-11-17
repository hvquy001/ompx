import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgoraApiError, AgoraClient, type AgoraEvent, loadAgoraEnv } from "../../src/agora/client";

const servers: ReturnType<typeof Bun.serve>[] = [];
const dirs: string[] = [];

afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop(true);
	for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompx-agora-client-"));
	dirs.push(dir);
	return dir;
}

function serve(fetch: (req: Request) => Response | Promise<Response>): { url: string } {
	const server = Bun.serve({ port: 0, fetch });
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}` };
}

const sse = (id: number) => `id: ${id}\nevent: chat.message\ndata: ${JSON.stringify({ id, type: "chat.message" })}\n\n`;

describe("loadAgoraEnv", () => {
	test("parses KEY=VALUE with quotes and never writes process.env", async () => {
		const file = path.join(await tmp(), "env");
		await Bun.write(file, "# c\nAGORA_URL=\"http://x.test\"\nexport AGORA_TOKEN='tok'\nAGORA_WORKSPACE=trdo\n");
		await fs.chmod(file, 0o600);
		const before = process.env.AGORA_TOKEN;
		expect(await loadAgoraEnv(file)).toEqual({ url: "http://x.test", token: "tok", workspace: "trdo" });
		expect(process.env.AGORA_TOKEN).toBe(before);
	});

	test("refuses a file readable by group or others", async () => {
		const file = path.join(await tmp(), "env");
		await Bun.write(file, "AGORA_URL=http://x.test\nAGORA_TOKEN=tok\n");
		await fs.chmod(file, 0o644);
		await expect(loadAgoraEnv(file)).rejects.toThrow(/chmod 600/);
	});

	test("requires AGORA_URL and AGORA_TOKEN", async () => {
		const file = path.join(await tmp(), "env");
		await Bun.write(file, "AGORA_URL=http://x.test\n");
		await fs.chmod(file, 0o600);
		await expect(loadAgoraEnv(file)).rejects.toThrow(/AGORA_TOKEN/);
	});
});

describe("AgoraClient REST", () => {
	test("sends bearer + workspace headers and the locked request shapes", async () => {
		const seen: { method: string; path: string; auth: string | null; ws: string | null; body: unknown }[] = [];
		const { url } = serve(async req => {
			const u = new URL(req.url);
			seen.push({
				method: req.method,
				path: u.pathname,
				auth: req.headers.get("authorization"),
				ws: req.headers.get("x-agora-workspace"),
				body: req.method === "GET" ? null : await req.json(),
			});
			if (u.pathname === "/api/v1/me")
				return Response.json({ actor: { id: "a1", username: "ompx", kind: "agent" } });
			if (u.pathname.endsWith("/messages")) return Response.json({ message: { id: "m1" } }, { status: 201 });
			if (u.pathname.endsWith("/status")) return Response.json({ ok: true });
			return Response.json({ conversation: { id: "c2" } }, { status: 201 });
		});
		const client = new AgoraClient({ url, token: "tok", workspace: "trdo" });

		expect(await client.me()).toEqual({ id: "a1", username: "ompx", kind: "agent" });
		expect(await client.postMessage("c1", { body: "hi", turn_id: "t1" })).toEqual({ id: "m1" });
		await client.setStatus("c1", "working", "bash: ls", "bash");
		expect(await client.createConversation({ participants: ["u"], title: "T" })).toEqual({ id: "c2" });

		for (const call of seen) {
			expect(call.auth).toBe("Bearer tok");
			expect(call.ws).toBe("trdo");
		}
		expect(seen[1]).toMatchObject({
			method: "POST",
			path: "/api/v1/chat/conversations/c1/messages",
			body: { body: "hi", turn_id: "t1" },
		});
		expect(seen[2]?.body).toEqual({ state: "working", note: "bash: ls", tool: "bash" });
	});

	test("omits the workspace header when unset and maps error bodies to AgoraApiError", async () => {
		let ws: string | null = "unset";
		const { url } = serve(req => {
			ws = req.headers.get("x-agora-workspace");
			return Response.json({ error: { code: "forbidden", message: "nope" } }, { status: 403 });
		});
		const client = new AgoraClient({ url, token: "tok" });
		const error = await client.me().catch((e: unknown) => e);
		expect(ws).toBeNull();
		expect(error).toBeInstanceOf(AgoraApiError);
		expect(error).toMatchObject({ status: 403, code: "forbidden", message: "nope" });
	});

	test("partial, putActivity and branch return false/null on 404 and succeed otherwise", async () => {
		let missing = true;
		const { url } = serve(req => {
			if (missing) return Response.json({ error: { code: "not_found", message: "no" } }, { status: 404 });
			if (req.url.endsWith("/branch")) return Response.json({ conversation: { id: "b1" } }, { status: 201 });
			return Response.json({ ok: true });
		});
		const client = new AgoraClient({ url, token: "tok" });
		const steps = [{ step_id: "s1", seq: 1, kind: "tool" as const, title: "bash", status: "running" as const }];

		expect(await client.partial("c1", "hi")).toBe(false);
		expect(await client.putActivity("c1", "t1", steps)).toBe(false);
		expect(await client.branch("c1", { from_message: "m1" })).toBeNull();

		missing = false;
		expect(await client.partial("c1", "hi")).toBe(true);
		expect(await client.putActivity("c1", "t1", steps)).toBe(true);
		expect(await client.branch("c1", { from_message: "m1" })).toEqual({ id: "b1" });
	});

	test("a non-404 error on an optional endpoint still throws", async () => {
		const { url } = serve(() => Response.json({ error: { code: "boom", message: "x" } }, { status: 500 }));
		await expect(new AgoraClient({ url, token: "t" }).partial("c1", "x")).rejects.toMatchObject({ status: 500 });
	});

	test("upload sends multipart field 'file' with auth", async () => {
		const dir = await tmp();
		const file = path.join(dir, "note.txt");
		await Bun.write(file, "hello");
		let seen:
			| { auth: string | null; ws: string | null; type: string | null; name: string; content: string }
			| undefined;
		const { url } = serve(async req => {
			const form = await req.formData();
			const part = form.get("file") as File;
			seen = {
				auth: req.headers.get("authorization"),
				ws: req.headers.get("x-agora-workspace"),
				type: req.headers.get("content-type"),
				name: part.name,
				content: await part.text(),
			};
			return Response.json(
				{
					id: "a1",
					url: "u",
					attachment: { id: "a1", url: "u", filename: "note.txt", mime: "text/plain", kind: "file", size: 5 },
				},
				{ status: 201 },
			);
		});
		const attachment = await new AgoraClient({ url, token: "tok", workspace: "trdo" }).upload(file);
		expect(attachment).toEqual({
			id: "a1",
			url: "u",
			filename: "note.txt",
			mime: "text/plain",
			kind: "file",
			size: 5,
		});
		expect(seen).toMatchObject({ auth: "Bearer tok", ws: "trdo", name: "note.txt", content: "hello" });
		expect(seen?.type).toStartWith("multipart/form-data");
	});

	test("download writes the body, refuses another origin and aborts above maxBytes", async () => {
		const dir = await tmp();
		const { url } = serve(req => {
			if (req.headers.get("authorization") !== "Bearer tok") return new Response("no", { status: 401 });
			return new Response("x".repeat(100));
		});
		const client = new AgoraClient({ url, token: "tok" });
		const dest = path.join(dir, "in", "f.bin");
		await client.download(`${url}/api/v1/attachments/a1`, dest, 1000);
		expect((await fs.stat(dest)).size).toBe(100);

		await expect(client.download("http://elsewhere.test/x", path.join(dir, "o"), 1000)).rejects.toThrow(/refusing/);
		// Agora's public URL can name another host than the daemon uses: the attachment is fetched from the configured one.
		const viaPublic = path.join(dir, "pub.bin");
		await client.download("http://agora.public.test/api/v1/attachments/a1", viaPublic, 1000);
		expect((await fs.stat(viaPublic)).size).toBe(100);
		const big = path.join(dir, "big.bin");
		await expect(client.download(`${url}/api/v1/attachments/a1`, big, 10)).rejects.toThrow(/larger than/);
		expect(await Bun.file(big).exists()).toBe(false);
	});
});

describe("AgoraClient.stream", () => {
	test("yields events, resumes with since = last id after the connection drops", async () => {
		const queries: URLSearchParams[] = [];
		const headers: (string | null)[] = [];
		const { url } = serve(req => {
			const u = new URL(req.url);
			queries.push(u.searchParams);
			headers.push(req.headers.get("authorization"));
			if (queries.length === 1) {
				// three events, then the connection ends
				return new Response(`: connected\n\n${sse(1)}${sse(2)}${sse(3)}`, {
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response(`: connected\n\n${sse(4)}`, { headers: { "content-type": "text/event-stream" } });
		});
		const client = new AgoraClient({ url, token: "tok" });
		const controller = new AbortController();
		const got: AgoraEvent[] = [];
		for await (const event of client.stream(null, ["chat.message", "chat.branched"], controller.signal)) {
			got.push(event);
			if (event.id === 4) controller.abort();
		}

		expect(got.map(e => e.id)).toEqual([1, 2, 3, 4]);
		expect(got[0]).toMatchObject({ type: "chat.message", data: { id: 1 } });
		expect(queries[0]?.get("since")).toBeNull();
		expect(queries[0]?.get("scope")).toBe("mine");
		expect(queries[0]?.get("types")).toBe("chat.message,chat.branched");
		expect(queries[1]?.get("since")).toBe("3");
		expect(headers).toEqual(["Bearer tok", "Bearer tok"]);
	}, 10_000);

	test("a 401 is permanent and throws instead of reconnecting", async () => {
		let calls = 0;
		const { url } = serve(() => {
			calls++;
			return Response.json({ error: { code: "unauthorized", message: "bad token" } }, { status: 401 });
		});
		const stream = new AgoraClient({ url, token: "bad" }).stream(7, ["chat.message"], new AbortController().signal);
		await expect(stream.next()).rejects.toMatchObject({ status: 401 });
		expect(calls).toBe(1);
	});
});
