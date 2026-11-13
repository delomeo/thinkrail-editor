import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

export interface LspServerCommand {
	readonly command: string;
	readonly args: string[];
}

/** Language id → the installed package plus the bin entry that speaks LSP over stdio. */
const SERVERS: Record<string, { package: string; bin: string }> = {
	javascript: { package: "typescript-language-server", bin: "typescript-language-server" },
	python: { package: "pyright", bin: "pyright-langserver" },
	typescript: { package: "typescript-language-server", bin: "typescript-language-server" },
};

/** The language ids this host is willing to serve; anything else is rejected before an upgrade. */
export function resolveServerCommand(languageId: string): LspServerCommand | undefined {
	const server = SERVERS[languageId];
	if (server === undefined) return undefined;
	try {
		const requireFromHere = createRequire(import.meta.url);
		const manifestPath = requireFromHere.resolve(`${server.package}/package.json`);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
			bin?: string | Record<string, string>;
		};
		const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[server.bin];
		if (bin === undefined) return undefined;
		return { command: join(dirname(manifestPath), bin), args: ["--stdio"] };
	} catch {
		return undefined;
	}
}
