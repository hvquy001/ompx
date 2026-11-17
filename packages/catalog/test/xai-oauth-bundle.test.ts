import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import {
	buildXaiOAuthStaticSeed,
	xaiOAuthModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { Api, FetchImpl, ModelSpec, OpenAICompat } from "@oh-my-pi/pi-catalog/types";

/** xai-oauth models all route through OpenAI-compatible APIs. */
const openAICompat = (model: ModelSpec<Api> | undefined): OpenAICompat | undefined =>
	model?.compat as OpenAICompat | undefined;

// Pins the invariant: the bundled catalog carries every entry the runtime
// xai-oauth KDL seed (surfaced via buildXaiOAuthStaticSeed) emits. Without
// this, editing the seed without regenerating the catalog silently regresses
// the boot-time default-model resolver — the registry sees the runtime seed
// only after `refresh()`, but interactive boot resolves the persisted default
// synchronously from `#loadModels()`, which reads only the bundled catalog.
//
// Failure here means: run `bun run gen:models` and commit the diff.
describe("xai-oauth bundled catalog (regression)", () => {
	const bundled = Object.fromEntries(getBundledModels("xai-oauth").map(model => [model.id, model]));
	const seed = buildXaiOAuthStaticSeed();

	it("curates a dynamically discovered grok-4.6 ahead of uncurated models", async () => {
		const fetchMock: FetchImpl = async () =>
			new Response(
				JSON.stringify({
					data: [
						{ id: "grok-future-unlisted", object: "model" },
						{ id: "grok-4.6", object: "model" },
					],
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);

		const discovered = await xaiOAuthModelManagerOptions({
			apiKey: "xai-oauth-test-token",
			fetch: fetchMock,
		}).fetchDynamicModels?.();

		expect(discovered?.[0]).toMatchObject({
			id: "grok-4.6",
			name: "Grok 4.6",
			contextWindow: 500_000,
			maxTokens: 500_000,
			reasoning: true,
			input: ["text", "image"],
			compat: {
				supportsReasoningEffort: true,
				omitReasoningEffort: false,
				includeEncryptedReasoning: true,
				filterReasoningHistory: false,
			},
		});
		expect(openAICompat(discovered?.find(model => model.id === "grok-future-unlisted"))?.omitReasoningEffort).toBe(
			true,
		);
	});

	it("defaults SuperGrok selection to grok-4.6", () => {
		const entry = providerEntry("xai-oauth");
		expect(entry?.defaultModel).toBe("grok-4.6");
		expect(DEFAULT_MODEL_PER_PROVIDER["xai-oauth"]).toBe("grok-4.6");
		expect(bundled["grok-4.6"], "xai-oauth/grok-4.6 must be bundled for the default").toBeDefined();
	});

	it("bundles every curated id", () => {
		const seededIds = seed.map(model => model.id).sort();
		const bundledIds = Object.keys(bundled).sort();
		expect(bundledIds).toEqual(seededIds);
	});

	for (const seededModel of seed.filter(model => model.api === "openai-responses")) {
		it(`matches contract for ${seededModel.id}`, () => {
			const bundledEntry = bundled[seededModel.id];
			expect(bundledEntry, `xai-oauth/${seededModel.id} missing from bundled catalog`).toBeDefined();
			expect(bundledEntry.id).toBe(seededModel.id);
			expect(bundledEntry.name).toBe(seededModel.name);
			expect(bundledEntry.provider).toBe("xai-oauth");
			expect(bundledEntry.api).toBe(seededModel.api);
			expect(bundledEntry.contextWindow).toBe(seededModel.contextWindow);
			const reasoning = seededModel.reasoning;
			if (typeof reasoning !== "boolean") {
				throw new Error(`Curated seed ${seededModel.id} must declare its reasoning capability`);
			}
			expect(bundledEntry.reasoning).toBe(reasoning);
			// Input modality must survive both the curated seed and the bundle.
			// Without this the static fallback used on offline boot strips
			// vision capability silently (Codex PR #1127 review).
			expect(bundledEntry.input).toEqual(seededModel.input);
			expect(openAICompat(bundledEntry)?.supportsReasoningEffort).toBe(
				openAICompat(seededModel)?.supportsReasoningEffort,
			);
			expect(openAICompat(bundledEntry)?.includeEncryptedReasoning).toBe(
				openAICompat(seededModel)?.includeEncryptedReasoning,
			);
			expect(openAICompat(bundledEntry)?.filterReasoningHistory).toBe(
				openAICompat(seededModel)?.filterReasoningHistory,
			);
		});
	}

	it("pins Grok 4.5 and 4.6 OAuth metadata and reasoning contracts", () => {
		const grok45 = seed.find(model => model.id === "grok-4.5");
		const grok46 = seed.find(model => model.id === "grok-4.6");
		if (!grok45 || !grok46) {
			throw new Error("Grok 4.5 and 4.6 must be in the xAI OAuth curated seed");
		}

		expect(seed[0]?.id).toBe("grok-4.6");
		expect(grok46).toMatchObject({
			name: "Grok 4.6",
			contextWindow: 500_000,
			maxTokens: 500_000,
			reasoning: true,
			input: ["text", "image"],
			compat: {
				includeEncryptedReasoning: true,
				filterReasoningHistory: false,
			},
		});

		const built45 = buildModel(grok45);
		const built46 = buildModel(grok46);
		expect(built45.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			defaultLevel: Effort.High,
			requiresEffort: true,
			effortMap: { [Effort.Minimal]: "low" },
		});
		expect(built46.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			defaultLevel: Effort.High,
			requiresEffort: true,
			effortMap: { [Effort.Minimal]: "low" },
		});
		expect(bundled["grok-4.5"]?.thinking).toEqual(built45.thinking);
		expect(bundled["grok-4.6"]?.thinking).toEqual(built46.thinking);
	});

	it("preserves dedicated runner transports and kinds without chat compatibility projection", () => {
		expect(seed.find(model => model.id === "grok-tts")).toMatchObject({ api: "xai-tts" });
		expect(seed.find(model => model.id === "grok-tts")?.compat).toBeUndefined();
		expect(bundled["grok-tts"]).toMatchObject({ api: "xai-tts", kind: "tts" });
		expect(seed.find(model => model.id === "grok-imagine-image")).toMatchObject({ api: "openai-images" });
		expect(seed.find(model => model.id === "grok-imagine-image")?.compat).toBeUndefined();
		expect(bundled["grok-imagine-image"]).toMatchObject({ api: "openai-images", kind: "image" });
	});
	// SuperGrok's `grok-4.20-multi-agent-0309` mirrors the paid catalog's
	// `grok-4.20-multi-agent-beta-latest` under a different ID; the price
	// fallback must bridge the alias so the bundle carries its public rate card
	// (the 4.20-0309 generation's $1.25 / $0.20 / $2.50, doubled over the
	// inclusive 200K tier) instead of the subscription zero.
	it("prices the multi-agent SuperGrok alias from its public xAI equivalent", () => {
		expect(bundled["grok-4.20-multi-agent-0309"]?.cost).toEqual({
			input: 1.25,
			output: 2.5,
			cacheRead: 0.2,
			cacheWrite: 0,
			longContext: {
				inputThreshold: 200_000,
				inputThresholdInclusive: true,
				input: 2.5,
				output: 5,
				cacheRead: 0.4,
				cacheWrite: 0,
			},
		});
	});

	// The OAuth surface's /v1/models reports no per-request output limit, so the
	// curated catalog owns maxTokens — set to mirror each model's contextWindow
	// (the openai-responses wire still clamps the actual request to
	// OPENAI_MAX_OUTPUT_TOKENS). Pin maxTokens === contextWindow on both the
	// static-seed and bundled paths so a null placeholder can
	// never silently leak back into the bundle.
	it("sets maxTokens equal to contextWindow for every xai-oauth Responses model", () => {
		for (const model of seed) {
			if (model.api !== "openai-responses") continue;
			expect(model.maxTokens, `seed ${model.id} maxTokens`).toBe(model.contextWindow);
			expect(bundled[model.id]?.maxTokens, `bundled ${model.id} maxTokens`).toBe(model.contextWindow);
		}
	});
});
