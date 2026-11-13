import { describe, expect, test } from "bun:test";
import { buildProviderReport, type ProviderStatusSources } from "./providerStatus";

function sources(overrides: Partial<ProviderStatusSources> = {}): ProviderStatusSources {
	return {
		modelProviderIds: new Set(),
		availableProviders: new Set(),
		credentialProviders: [],
		oauthProviders: [],
		credentialType: () => undefined,
		providerAuth: () => ({}),
		apiKeyLogin: () => true,
		displayName: (id) => id,
		hasAuth: () => false,
		...overrides,
	};
}

describe("buildProviderReport", () => {
	test("an empty runtime carries no providers", () => {
		expect(buildProviderReport(sources())).toEqual({ providers: [] });
	});

	test("stored credentials map to oauth/api-key kinds and remain removable", () => {
		const report = buildProviderReport(
			sources({
				modelProviderIds: new Set(["anthropic", "openai"]),
				availableProviders: new Set(["anthropic", "openai"]),
				credentialProviders: ["anthropic", "openai"],
				credentialType: (id) => (id === "anthropic" ? "oauth" : "api_key"),
				providerAuth: () => ({ source: "stored" }),
				hasAuth: () => true,
			}),
		);
		expect(
			report.providers.map((provider) => [provider.id, provider.kind, provider.canLogout]),
		).toEqual([
			["anthropic", "oauth", true],
			["openai", "api-key", true],
		]);
	});

	test("ambient auth describes its source without changing ordinary rows", () => {
		const report = buildProviderReport(
			sources({
				modelProviderIds: new Set(["anthropic", "fallback"]),
				availableProviders: new Set(["anthropic", "fallback"]),
				credentialProviders: ["fallback"],
				credentialType: (id) => (id === "fallback" ? "api_key" : undefined),
				providerAuth: (id) =>
					id === "anthropic"
						? { source: "environment", label: "ANTHROPIC_API_KEY" }
						: { source: "fallback" },
			}),
		);
		expect(report.providers).toEqual([
			{
				id: "anthropic",
				name: "anthropic",
				configured: true,
				kind: "env",
				detail: "ANTHROPIC_API_KEY",
				canApiKey: true,
			},
			{
				id: "fallback",
				name: "fallback",
				configured: true,
				kind: "api-key",
				canApiKey: true,
				canLogout: true,
			},
		]);
	});

	test("an unconfigured id remains unconfigured", () => {
		const report = buildProviderReport(
			sources({
				modelProviderIds: new Set(["quiet-provider"]),
			}),
		);
		expect(report.providers).toEqual([
			{ id: "quiet-provider", name: "quiet-provider", configured: false, canApiKey: true },
		]);
	});

	test("environment and models.json sources remain generic provider auth", () => {
		const report = buildProviderReport(
			sources({
				modelProviderIds: new Set(["custom", "groq"]),
				availableProviders: new Set(["custom", "groq"]),
				providerAuth: (id) =>
					id === "groq"
						? { source: "environment", label: "GROQ_API_KEY" }
						: { source: "models_json_key" },
			}),
		);
		expect(report.providers).toEqual([
			{
				id: "custom",
				name: "custom",
				configured: true,
				kind: "api-key",
				detail: "models.json",
				canApiKey: true,
			},
			{
				id: "groq",
				name: "groq",
				configured: true,
				kind: "env",
				detail: "GROQ_API_KEY",
				canApiKey: true,
			},
		]);
	});

	test("a model-less stored credential remains visible without inventing login support", () => {
		const report = buildProviderReport(
			sources({
				credentialProviders: ["mystery"],
				credentialType: () => "api_key",
				providerAuth: () => ({ source: "stored" }),
				hasAuth: (id) => id === "mystery",
				apiKeyLogin: () => false,
			}),
		);
		expect(report.providers).toEqual([
			{ id: "mystery", name: "mystery", configured: true, kind: "api-key", canLogout: true },
		]);
	});

	test("OAuth-only providers appear under their own login ids and labels", () => {
		const report = buildProviderReport(
			sources({
				oauthProviders: [
					{ id: "openai-codex", name: "ChatGPT Subscription" },
					{ id: "github-copilot", name: "GitHub Copilot" },
				],
				apiKeyLogin: () => false,
			}),
		);
		expect(report.providers).toEqual([
			{
				id: "openai-codex",
				name: "ChatGPT Subscription",
				configured: false,
				canOAuth: true,
			},
			{
				id: "github-copilot",
				name: "GitHub Copilot",
				configured: false,
				canOAuth: true,
			},
		]);
	});

	test("pi-owned API-key capability supports multi-prompt providers", () => {
		const report = buildProviderReport(
			sources({
				modelProviderIds: new Set(["amazon-bedrock", "google-vertex", "azure-openai-responses"]),
			}),
		);
		expect(
			Object.fromEntries(report.providers.map((provider) => [provider.id, provider.canApiKey])),
		).toEqual({
			"amazon-bedrock": true,
			"azure-openai-responses": true,
			"google-vertex": true,
		});
	});

	test("configured providers sort first and alphabetically within each group", () => {
		const report = buildProviderReport(
			sources({
				modelProviderIds: new Set(["zai", "anthropic", "google", "openai"]),
				availableProviders: new Set(["zai", "openai"]),
				providerAuth: () => ({ source: "models_json_key" }),
			}),
		);
		expect(report.providers.map((provider) => provider.id)).toEqual([
			"openai",
			"zai",
			"anthropic",
			"google",
		]);
	});
});
