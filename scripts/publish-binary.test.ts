import { describe, expect, test } from "bun:test";
import { assetName, releaseTag, stampedVersionFile, sumsWithout } from "./publish-binary";

describe("releaseTag", () => {
	test("accepts only the grammar the installers accept, and marks nightly as prerelease", () => {
		expect(releaseTag("1.2.3")).toEqual({ tag: "v1.2.3", prerelease: false });
		expect(releaseTag("1.2.3-nightly.7")).toEqual({ tag: "v1.2.3-nightly.7", prerelease: true });
		expect(releaseTag("1.2")).toBeNull();
		expect(releaseTag("1.2.3-beta.1")).toBeNull();
		expect(releaseTag("latest")).toBeNull();
	});
});

describe("assetName", () => {
	test("matches the asset each installer asks the release for", () => {
		expect(assetName("bun-linux-x64")).toBe("thinkrail-linux-x64");
		expect(assetName("bun-linux-arm64")).toBe("thinkrail-linux-arm64");
		expect(assetName("bun-darwin-arm64")).toBe("thinkrail-darwin-arm64");
		expect(assetName("bun-darwin-x64")).toBe("thinkrail-darwin-x64");
		expect(assetName("bun-windows-x64")).toBe("thinkrail-windows-x64.exe");
		expect(assetName("bun-windows-arm64")).toBe("thinkrail-windows-arm64.exe");
		expect(assetName("bun-freebsd-x64")).toBe("");
	});
});

describe("stampedVersionFile", () => {
	const current =
		'export const version = "0.0.0-dev";\nexport const channel = "dev";\nexport const commit = "";\nexport const posthogProjectKey = "phc_example";\n';

	test("bakes the published identity into the binary and keeps the analytics key that is already set", () => {
		const stamped = stampedVersionFile(current, "1.2.3-nightly.7", "nightly", "abc1234");
		expect(stamped).toContain('version = "1.2.3-nightly.7"');
		expect(stamped).toContain('channel = "nightly"');
		expect(stamped).toContain('commit = "abc1234"');
		expect(stamped).toContain('posthogProjectKey = "phc_example"');
		expect(
			stampedVersionFile(current.replace(/phc_example/, ""), "1.2.3", "stable", "abc1234"),
		).toContain('posthogProjectKey = ""');
	});
});

describe("sumsWithout", () => {
	test("replaces only this asset's line, keeps the other platforms, and passes anything unrecognized through", () => {
		const published = [
			"aaa  thinkrail-darwin-arm64",
			"bbb  thinkrail-windows-x64.exe",
			"ccc  thinkrail-linux-x64",
			"",
			"malformed line",
		].join("\n");
		expect(sumsWithout(published, "thinkrail-linux-x64")).toEqual([
			"aaa  thinkrail-darwin-arm64",
			"bbb  thinkrail-windows-x64.exe",
			"malformed line",
		]);
		expect(sumsWithout(published, "thinkrail-windows-x64")).toHaveLength(4);
		expect(sumsWithout(published, "thinkrail-darwin-arm64")).toHaveLength(3);
	});
});
