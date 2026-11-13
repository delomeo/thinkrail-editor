#!/usr/bin/env bun
// Builds the single-file CLI binary for one platform and publishes it with SHA256SUMS as a GitHub
// release, which is exactly what install.sh and install.ps1 download.
//
//   GH_TOKEN=<token> bun run release:binary --version=0.3.1
//   options: --target=bun-{linux,darwin,windows}-{x64,arm64} (default: this machine)
//            --repo owner/name (default: the git origin remote)  --dry-run
//
// Local assets are unsigned and notarization-free: a macOS asset quarantines on first download and a
// Windows asset keeps Bun's icon. The signed public pipeline in .github/SPEC.md stays the home of the
// JetBrains releases; this one is for a fork that serves its own releases.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const distDir = join(repoRoot, "apps", "cli", "dist");
const VERSION_PATTERN = /^\d+\.\d+\.\d+(-nightly\.\d+)?$/;
const TARGET_PATTERN = /^bun-(linux|darwin|windows)-(x64|arm64)$/;

export function releaseTag(version: string): { tag: string; prerelease: boolean } | null {
	if (!VERSION_PATTERN.test(version)) return null;
	return { tag: `v${version}`, prerelease: version.includes("-nightly.") };
}

export function hostTarget(): string {
	const platforms: Record<string, string> = {
		darwin: "bun-darwin",
		linux: "bun-linux",
		win32: "bun-windows",
	};
	const platform = platforms[process.platform];
	if (!platform) return "";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	return `${platform}-${platform === "bun-windows" ? "x64" : arch}`;
}

// The basename build-binary.ts writes for that target and the basename the installers ask for.
export function assetName(target: string): string {
	if (!TARGET_PATTERN.test(target)) return "";
	return `thinkrail-${target.slice("bun-".length)}${target.includes("windows") ? ".exe" : ""}`;
}

// Drop this asset's old line so a per-platform publish keeps the other platforms' entries intact.
export function sumsWithout(text: string, name: string): string[] {
	return text.split("\n").filter((line) => {
		const fields = line.trim().split(/\s+/);
		return fields.length === 2 && fields[1] !== name;
	});
}

function option(name: string): string | undefined {
	return process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(`--${name}=`.length);
}

function fail(message: string): never {
	console.error(`publish-binary: ${message}`);
	process.exit(1);
}

function run(cmd: string[]): void {
	const proc = Bun.spawnSync(cmd, { cwd: repoRoot, stdout: "inherit", stderr: "inherit" });
	if (!proc.success) process.exit(proc.exitCode ?? 1);
}

// The compiled binary self-reports this identity (thinkrail --version, `thinkrail update`), so a release
// asset has to carry the version it is published under.
export function stampedVersionFile(
	current: string,
	version: string,
	channel: string,
	commit: string,
): string {
	const posthogProjectKey = current.match(/posthogProjectKey = "([^"]*)"/)?.[1] ?? "";
	const quote = (value: string) => JSON.stringify(value);
	return `export const version = ${quote(version)};\nexport const channel = ${quote(channel)};\nexport const commit = ${quote(commit)};\nexport const posthogProjectKey = ${quote(posthogProjectKey)};\n`;
}

function originRepo(): string {
	const remote = Bun.spawnSync(["git", "remote", "get-url", "origin"], { cwd: repoRoot });
	if (!remote.success) fail("no git origin remote; pass --repo owner/name");
	const match = String(remote.stdout ?? "")
		.trim()
		.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
	if (!match) fail("could not read a GitHub repo from the origin remote; pass --repo owner/name");
	return `${match[1]}/${match[2]}`;
}

async function main(): Promise<void> {
	const version = option("version") ?? "";
	const release = releaseTag(version);
	if (!release)
		fail(
			"--version X.Y.Z or --version X.Y.Z-nightly.N is required (the installers reject any other tag)",
		);

	const target = option("target") ?? hostTarget();
	if (!TARGET_PATTERN.test(target))
		fail(`unsupported target "${target}" (the installers only ask for these six)`);
	const name = assetName(target);

	const dryRun = process.argv.includes("--dry-run");
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (!token && !dryRun) fail("GH_TOKEN or GITHUB_TOKEN is required to publish");

	const repo = option("repo") ?? originRepo();
	async function api(path: string, init: RequestInit = {}): Promise<Response> {
		return await fetch(`https://api.github.com${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				// GitHub rejects requests without one.
				"user-agent": "thinkrail-publish-binary",
				...init.headers,
			},
		});
	}

	const versionFile = join(repoRoot, "packages", "shared", "src", "version.ts");
	const development = readFileSync(versionFile, "utf8");
	const commit = String(
		Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repoRoot }).stdout ?? "",
	).trim();
	writeFileSync(
		versionFile,
		stampedVersionFile(development, version, release.prerelease ? "nightly" : "stable", commit),
	);
	try {
		run(["bun", "run", "build:web"]);
		run(["bun", "apps/cli/scripts/build-binary.ts", `--target=${target}`]);
	} finally {
		// A local build never leaves a release version in a development tree.
		writeFileSync(versionFile, development);
	}

	const binaryPath = join(distDir, name);
	if (!existsSync(binaryPath)) fail(`expected the binary at ${binaryPath}`);
	const binary = readFileSync(binaryPath);
	const entry = `${createHash("sha256").update(binary).digest("hex")}  ${name}`;
	console.log(`\nbuilt ${name} (${binary.byteLength} bytes) for ${repo} ${release.tag}`);

	const sumsPath = join(distDir, "SHA256SUMS");
	if (dryRun) {
		// shortcut: a dry run merges with the local SHA256SUMS, not the published one; a real publish reads the published asset.
		const local = existsSync(sumsPath) ? readFileSync(sumsPath, "utf8") : "";
		writeFileSync(sumsPath, `${[...sumsWithout(local, name), entry].join("\n")}\n`);
		console.log(`dry run: ${binaryPath} and ${sumsPath} are ready`);
		return;
	}

	let published = await (await api(`/repos/${repo}/releases/tags/${release.tag}`)).json();
	if (!published.id) {
		const head = String(
			Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoRoot }).stdout ?? "",
		).trim();
		const created = await api(`/repos/${repo}/releases`, {
			method: "POST",
			body: JSON.stringify({
				tag_name: release.tag,
				target_commitish: head,
				name: `ThinkRail ${version}`,
				prerelease: release.prerelease,
			}),
		});
		published = await created.json();
		if (!published.id)
			fail(`could not create the release: ${created.status} ${JSON.stringify(published)}`);
	}

	const assets: { name: string; id: number; url: string }[] = await (
		await api(`/repos/${repo}/releases/${published.id}/assets?per_page=100`)
	).json();
	const byName = new Map(assets.map((asset) => [asset.name, asset]));

	const previous = byName.get("SHA256SUMS");
	const publishedSums = previous
		? await (
				await api(previous.url.slice("https://api.github.com".length), {
					headers: { Accept: "application/octet-stream" },
				})
			).text()
		: "";

	async function upload(name: string, body: string | Buffer): Promise<void> {
		// shortcut: one plain POST; if GitHub refuses a large asset, `gh release upload --clobber` reaches the same release through its resumable protocol.
		const stale = byName.get(name);
		if (stale) await api(`/repos/${repo}/releases/assets/${stale.id}`, { method: "DELETE" });
		const res = await fetch(`${published.upload_url as string}?name=${encodeURIComponent(name)}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
			body: body as BodyInit,
		});
		if (!res.ok) fail(`could not upload ${name}: ${res.status} ${await res.text()}`);
	}

	await upload(name, binary);
	writeFileSync(sumsPath, `${[...sumsWithout(publishedSums, name), entry].join("\n")}\n`);
	await upload("SHA256SUMS", readFileSync(sumsPath));

	console.log(`https://github.com/${repo}/releases/tag/${release.tag}`);
	console.log(
		`install it with:  curl -fsSL https://raw.githubusercontent.com/${repo}/main/install.sh | bash`,
	);
}

if (import.meta.main) await main();
