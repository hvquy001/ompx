import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import * as oauthUtils from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

const HOUR_MS = 60 * 60 * 1000;

function oauth(accountId: string, email: string) {
	return {
		type: "oauth" as const,
		access: `access-${accountId}`,
		refresh: `refresh-${accountId}`,
		expires: Date.now() + 7 * 24 * HOUR_MS,
		accountId,
		email,
	};
}

function claudeLimit(windowId: "5h" | "7d", usedFraction: number): UsageLimit {
	const durationMs = windowId === "5h" ? 5 * HOUR_MS : 7 * 24 * HOUR_MS;
	return {
		id: `anthropic:${windowId}`,
		label: windowId,
		scope: { provider: "anthropic", windowId, shared: true },
		window: { id: windowId, label: windowId, durationMs, resetsAt: Date.now() + durationMs / 2 },
		amount: {
			unit: "percent",
			used: usedFraction * 100,
			limit: 100,
			remaining: 100 - usedFraction * 100,
			usedFraction,
			remainingFraction: 1 - usedFraction,
		},
		status: "ok",
	};
}

function claudeReport(accountId: string, weeklyUsed: number): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		limits: [claudeLimit("5h", 0.1), claudeLimit("7d", weeklyUsed)],
		metadata: { accountId },
	};
}

describe("auth credential balancing and account pinning", () => {
	let dir = "";
	const usageByAccount = new Map<string, UsageReport>();
	const usageProvider: UsageProvider = {
		id: "anthropic",
		async fetchUsage(params) {
			return usageByAccount.get(params.credential.accountId ?? "") ?? null;
		},
	};

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-account-routing-"));
		usageByAccount.clear();
		vi.spyOn(oauthUtils, "getOAuthApiKey").mockImplementation(async (provider, credentials) => {
			const credential = credentials[provider] as OAuthCredentials | undefined;
			if (!credential?.accountId) return null;
			return { apiKey: `api-${credential.accountId}`, newCredentials: credential };
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		clearCustomApis();
		await fs.rm(dir, { recursive: true, force: true });
	});

	async function pickCounts(balancing: "even" | "drain", weeklyUsed: Record<string, number>) {
		const storage = await AuthStorage.create(path.join(dir, `${balancing}.db`), {
			usageProviderResolver: provider => (provider === "anthropic" ? usageProvider : undefined),
			credentialBalancing: balancing,
		});
		try {
			await storage.credentials.set(
				"anthropic",
				Object.keys(weeklyUsed).map(id => oauth(id, `${id}@example.com`)),
			);
			for (const [id, used] of Object.entries(weeklyUsed)) usageByAccount.set(id, claudeReport(id, used));
			await storage.usage.reports();
			const counts = new Map<string, number>();
			for (let i = 0; i < 120; i++) {
				const key = await storage.keys.get("anthropic", `${balancing}-session-${i}`);
				if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			return counts;
		} finally {
			storage.close();
		}
	}

	test("even balancing splits new sessions across near-equal accounts; drain keeps one pick", async () => {
		const usage = { "acct-a": 0.3, "acct-b": 0.31, "acct-c": 0.32 };
		const even = await pickCounts("even", usage);
		expect([...even.keys()].sort()).toEqual(["api-acct-a", "api-acct-b", "api-acct-c"]);
		for (const count of even.values()) expect(count).toBeGreaterThan(20);

		const drain = await pickCounts("drain", usage);
		expect(drain.size).toBe(1);
	});

	test("even balancing sends new sessions to the clearly less-used account", async () => {
		const counts = await pickCounts("even", { "acct-heavy": 0.7, "acct-light": 0.2 });
		expect(counts.get("api-acct-light")).toBe(120);
	});

	test("pinned account wins over the balancer and never falls back to another credential", async () => {
		const storage = await AuthStorage.create(path.join(dir, "pin.db"));
		try {
			await storage.credentials.set("anthropic", [
				oauth("acct-a", "a@example.com"),
				oauth("acct-b", "B@Example.com"),
			]);
			storage.keys.setRuntime("anthropic", "runtime-key");

			const pinned = await storage.keys.withOrigin("anthropic", "s1", { oauthAccount: "b@example.com" });
			expect(pinned).toMatchObject({ apiKey: "api-acct-b", origin: { kind: "oauth" } });
			expect(await storage.keys.get("anthropic", "s2", { oauthAccount: "acct-a" })).toBe("api-acct-a");
			expect(await storage.keys.get("anthropic", "s3", { oauthAccount: "nobody@example.com" })).toBeUndefined();
			expect(await storage.keys.get("anthropic", "s4")).toBe("runtime-key");
		} finally {
			storage.close();
		}
	});

	test("gateway routes x-omp-account to that account and rejects unknown accounts", async () => {
		registerMockApi();
		const storage = await AuthStorage.create(path.join(dir, "gateway.db"));
		await storage.credentials.set("mock", [oauth("acct-a", "a@example.com"), oauth("acct-b", "b@example.com")]);
		const mock = createMockModel({ provider: "mock", id: "pin-model", handler: () => ({ content: ["ok"] }) });
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["gateway-token"],
			storage,
			resolveModel: () => mock,
			version: "test",
		});
		const send = (account: string) =>
			fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: "Bearer gateway-token",
					"x-omp-account": account,
				},
				body: JSON.stringify({ model: "pin-model", messages: [{ role: "user", content: `hi ${account}` }] }),
			});
		try {
			for (const account of ["a@example.com", "b@example.com", "acct-a"]) {
				const response = await send(account);
				expect(response.status).toBe(200);
				await response.text();
			}
			const servedBy: unknown[] = [];
			for (const call of mock.calls) {
				const resolver = call.options?.apiKey;
				servedBy.push(
					typeof resolver === "function" ? await resolver({ lastChance: false, error: undefined }) : resolver,
				);
			}
			expect(servedBy).toEqual(["api-acct-a", "api-acct-b", "api-acct-a"]);

			const unknown = await send("nobody@example.com");
			expect(unknown.status).toBe(401);
			const body = (await unknown.json()) as { error?: { message?: string } };
			expect(body.error?.message).toBe('No usable mock OAuth account matches x-omp-account "nobody@example.com"');
			expect(mock.calls).toHaveLength(3);
		} finally {
			await handle.close();
			storage.close();
		}
	});
});
