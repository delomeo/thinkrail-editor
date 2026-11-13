import { chmodSync, copyFileSync, existsSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LOGIN_ENV_MARKER } from "@thinkrail/shared/shellEnv";

export function resolveBunExecutable(env: NodeJS.ProcessEnv = process.env): string {
	const name = process.platform === "win32" ? "bun.exe" : "bun";
	const executable = (env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((directory) => join(directory, name))
		.find(existsSync);
	if (!executable) throw new Error("bun executable not found for the e2e host");
	return executable;
}

export function hermeticE2ePath(fakeBinDir: string): string {
	return [fakeBinDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter);
}

function resolveNodePath(env: NodeJS.ProcessEnv): string | undefined {
	const name = process.platform === "win32" ? "node.exe" : "node";
	return [
		...(env.PATH ?? "")
			.split(delimiter)
			.filter(Boolean)
			.map((directory) => join(directory, name)),
		join("/usr/bin", name),
	].find(existsSync);
}

/** The host's language-server children (pyright, typescript-language-server) are Node programs reached
 * through their own shebang, so the host's hermetic PATH needs a Node. Point at the one this machine
 * already resolved instead of widening the PATH to whatever else its directory holds. */
export function languageServerNodeAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
	return resolveNodePath(env) !== undefined;
}

export function writeLanguageServerNode(
	fakeBinDir: string,
	env: NodeJS.ProcessEnv = process.env,
): void {
	const executable = resolveNodePath(env);
	if (executable === undefined) return;
	const target = join(fakeBinDir, process.platform === "win32" ? "node.exe" : "node");
	rmSync(target, { force: true });
	if (process.platform === "win32") copyFileSync(executable, target);
	else symlinkSync(executable, target);
}

export function hermeticE2eShell(fakeBinDir: string): string {
	return join(fakeBinDir, "login-shell");
}

export function writeHermeticE2eShell(fakeBinDir: string, realShell: string): void {
	const script = [
		"#!/bin/sh",
		'case "$*" in',
		`\t*${shellQuote(LOGIN_ENV_MARKER)}*) printf '%sPATH=%s\\0' ${shellQuote(LOGIN_ENV_MARKER)} ${shellQuote(hermeticE2ePath(fakeBinDir))}; exit 0 ;;`,
		"esac",
		`exec ${shellQuote(realShell)} "$@"`,
		"",
	].join("\n");
	const target = hermeticE2eShell(fakeBinDir);
	writeFileSync(target, script);
	chmodSync(target, 0o755);
}

export function writeFakeGh(fakeBinDir: string, scenarioPath: string, logPath: string): void {
	const source = fileURLToPath(new URL("./fakeGh.ts", import.meta.url));
	const script = [
		"#!/bin/sh",
		`exec ${[resolveBunExecutable(), source, scenarioPath, logPath].map(shellQuote).join(" ")} "$@"`,
		"",
	].join("\n");
	const target = join(fakeBinDir, "gh");
	writeFileSync(target, script);
	chmodSync(target, 0o755);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}
