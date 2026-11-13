import { expect, test } from "bun:test";
import { catalogProviderAuth, describeProviderAuth } from "./providerAuth";

test("describeProviderAuth ranks OAuth over a stored credential over ambient source", () => {
	expect(describeProviderAuth({ oauth: true, source: "stored" })).toEqual({ kind: "oauth" });
	expect(describeProviderAuth({ oauth: false, source: "environment", label: "X_KEY" })).toEqual({
		kind: "env",
		detail: "X_KEY",
	});
	expect(describeProviderAuth({ oauth: false, source: "stored" })).toEqual({ kind: "api-key" });
	expect(describeProviderAuth({ oauth: false, source: "models_json_key" })).toEqual({
		kind: "api-key",
		detail: "models.json",
	});
	expect(describeProviderAuth({ oauth: false, source: "fallback" })).toEqual({ kind: "other" });
	expect(
		describeProviderAuth({ oauth: false, apiKeyCredential: true, source: "fallback" }),
	).toEqual({
		kind: "api-key",
	});
	expect(describeProviderAuth({ oauth: false })).toEqual({ kind: "other" });
});

test("catalogProviderAuth reads pi's synchronous auth facts for a provider", () => {
	const runtime = {
		isUsingOAuth: (id: string) => id === "anthropic",
		getProviderAuthStatus: (id: string) =>
			id === "google"
				? { configured: true, source: "environment" as const, label: "GEMINI_API_KEY" }
				: { configured: true, source: "stored" as const },
	} as unknown as Parameters<typeof catalogProviderAuth>[0];
	expect(catalogProviderAuth(runtime, "anthropic")).toEqual({ kind: "oauth" });
	expect(catalogProviderAuth(runtime, "google")).toEqual({ kind: "env", detail: "GEMINI_API_KEY" });
	expect(catalogProviderAuth(runtime, "openai")).toEqual({ kind: "api-key" });
});
