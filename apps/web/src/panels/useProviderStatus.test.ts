import { expect, test } from "bun:test";
import type { ProviderStatus, ProviderStatusReport } from "@thinkrail/contracts";
import { reportHasModelSource } from "./useProviderStatus";

const report = (providers: ProviderStatus[]): ProviderStatusReport => ({ providers });

const provider = (id: string, configured: boolean): ProviderStatus => ({
	id,
	name: id,
	configured,
});

test("a configured standard provider is a model source", () => {
	expect(reportHasModelSource(report([provider("anthropic", true)]))).toBe(true);
});

test("no configured provider is not a model source", () => {
	expect(reportHasModelSource(report([provider("anthropic", false)]))).toBe(false);
	expect(reportHasModelSource(report([]))).toBe(false);
});
