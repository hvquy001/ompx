import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const mcpTool: CustomTool = {
	name: "mcp__fixture_probe",
	label: "Fixture probe",
	description: "Probe the fixture server.",
	parameters: type({ query: "string" }),
	mcpServerName: "fixture",
	mcpToolName: "probe",
	async execute() {
		return { content: [{ type: "text", text: "fixture" }] };
	},
};

const FORK_ONLY_TOOLS = new Set(["loop", "consult"]);

describe("/tan prompt-cache tool presentation", () => {
	for (const xdev of [true, false]) {
		it(`preserves the parent's request tools with xd:// ${xdev ? "enabled" : "disabled"}`, async () => {
			using dir = TempDir.createSync("@omp-tan-tools-");
			const cwd = dir.path();
			const settings = Settings.isolated({
				"tools.xdev": xdev,
				"marketplace.autoUpdate": "off",
				// The fork keeps BM25 tool discovery, which defers the discoverable `ask` tool; this test pins the eager surface.
				"tools.discoveryMode": "off",
			});
			const auth = createInMemoryAuthStorage();
			auth.keys.setRuntime("openai", "test-key");
			const base = {
				cwd,
				agentDir: cwd,
				model: getBundledModel("openai", "gpt-4o-mini"),
				modelRegistry: new ModelRegistry(auth),
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableLsp: false,
				enableMCP: false,
				disableExtensionDiscovery: true,
				skipPythonPreflight: true,
				mcpTools: [mcpTool],
			};
			const { session: parent } = await createAgentSession({
				...base,
				settings,
				hasUI: true,
				sessionManager: SessionManager.inMemory(cwd),
			});
			try {
				const { session: child } = await createAgentSession({
					...base,
					settings: createSubagentSettings(settings),
					hasUI: false,
					systemPrompt: [...parent.systemPrompt],
					toolNames: parent.getEnabledToolNames(),
					mountedToolNames: parent.getMountedXdevToolNames(),
					advertiseHeadlessAsk: parent.getActiveToolNames().includes("ask"),
					parentTaskPrefix: "Tan-fixture",
					sessionManager: SessionManager.inMemory(cwd),
				});
				await child.setActiveToolPresentation(parent.getEnabledToolNames(), parent.getMountedXdevToolNames());
				try {
					// Fork-only `loop` (needs a session loop scheduler) and `consult` (needs the advisor) are not hosted by a headless clone.
					const advertised = (session: typeof parent) =>
						session.agent.state.tools
							.filter(tool => !FORK_ONLY_TOOLS.has(tool.name))
							.map(tool => ({
								name: tool.name,
								// The eval tool lists the session's tool names; the clone does not host the fork-only ones.
								description: tool.description.replace(/\b(?:loop|consult), /g, ""),
								parameters: tool.parameters,
							}));
					if (xdev) expect(parent.getMountedXdevToolNames()).toContain(mcpTool.name);
					else expect(parent.getMountedXdevToolNames()).toEqual([]);
					expect(parent.getActiveToolNames()).toContain("ask");
					expect(child.getMountedXdevToolNames()).toEqual(
						parent.getMountedXdevToolNames().filter(name => !FORK_ONLY_TOOLS.has(name)),
					);
					expect(child.systemPrompt).toEqual(parent.systemPrompt);
					expect(advertised(child)).toEqual(advertised(parent));
					// Run a real turn: the model calls the inherited ask with a schema-valid payload, so the
					// call goes through argument validation and tool execution in the agent loop.
					const mock = createMockModel({
						responses: [
							{
								content: [
									{
										type: "toolCall",
										id: "ask-fixture",
										name: "ask",
										arguments: {
											html: '<form><p>Which scope?</p><label><input type="radio" name="scope" value="narrow" checked> Narrow</label><label><input type="radio" name="scope" value="wide"> Wide</label></form>',
										},
									},
								],
							},
							{ content: ["Open question: which scope?"] },
						],
					});
					child.agent.streamFn = mock.stream;
					await child.prompt("Pick a scope.");
					const messages = child.agent.state.messages;
					const result = messages.find(
						message => message.role === "toolResult" && message.toolCallId === "ask-fixture",
					);
					if (result?.role !== "toolResult") throw new Error("The ask call produced no tool result");
					// The model gets a recoverable error instead of an aborted run, so the clone reaches its final answer.
					expect(result.isError).toBe(true);
					expect(mock.calls).toHaveLength(2);
					expect(messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
				} finally {
					await child.dispose();
				}
			} finally {
				await parent.dispose();
				auth.close();
			}
		}, 30_000);
	}
});
