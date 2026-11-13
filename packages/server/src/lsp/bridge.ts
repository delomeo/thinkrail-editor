import { type ChildProcess, spawn } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { IConnection, IWebSocket } from "vscode-ws-jsonrpc";
import { createProcessStreamConnection, createWebSocketConnection } from "vscode-ws-jsonrpc/server";
import { logger } from "../log";
import { type PythonEnvironment, resolvePythonEnvironment } from "./pythonEnv";
import { resolveServerCommand } from "./servers";

export const LSP_ROUTE = "/lsp";

const log = logger("lsp");
const SOCKET_OPEN = 1;
const PYTHON = "python";

/** The slice of a server-side WebSocket this module drives: no `host`, no Bun socket type. */
export interface LspSocket {
	readonly readyState: number;
	send(data: string): number;
	close(code?: number, reason?: string): void;
}

/** The JSON-RPC shapes named here, spelled structurally: what this module answers is not the protocol
 * package's business, and its types stay behind the child's stdio. */
interface JsonRpcFrame {
	readonly jsonrpc: string;
	readonly id?: number | string;
	readonly method?: string;
	readonly params?: unknown;
	readonly result?: unknown;
}

type Settings = Record<string, unknown>;

interface LspSession {
	readonly child: ChildProcess;
	deliver(data: string): void;
}

export interface LspSessionHandle {
	readonly pid: number | undefined;
}

/** One language-server child per connected editor session. */
const sessions = new Map<LspSocket, LspSession>();
const utf8 = new TextDecoder();

function closeSocket(socket: LspSocket, code?: number): void {
	if (socket.readyState === SOCKET_OPEN) socket.close(code);
}

function endSession(socket: LspSocket, closeCode?: number): void {
	const session = sessions.get(socket);
	if (session === undefined) return;
	sessions.delete(socket);
	session.child.kill();
	if (closeCode !== undefined) closeSocket(socket, closeCode);
}

/** The environment directory itself, or nothing when only an interpreter was found. */
function environmentDirectory(environment: PythonEnvironment): string | undefined {
	return environment.venvPath === undefined || environment.venvName === undefined
		? undefined
		: join(environment.venvPath, environment.venvName);
}

/** pyright acts on `python.pythonPath` and `python.analysis.extraPaths`. Giving it an `analysis` object
 * switches `autoSearchPaths` off, so it is named; `reportMissingModuleSource` is read only inside
 * `diagnosticSeverityOverrides`. */
function pythonSettings(environment: PythonEnvironment): Settings {
	const envRoot = environmentDirectory(environment);
	return {
		python: {
			pythonPath: environment.pythonPath,
			...(envRoot === undefined ? {} : { venvPath: dirname(envRoot), venv: environment.venvName }),
			analysis: {
				autoSearchPaths: true,
				useLibraryCodeForTypes: true,
				diagnosticMode: "openFilesOnly",
				extraPaths: environment.sitePackagesPaths,
				diagnosticSeverityOverrides: { reportMissingModuleSource: "none" },
			},
		},
	};
}

/** A child inherits an activated environment: that is how the interpreter a server falls back to looking
 * for on its own is the project's, not the one this host happens to run under. */
function childEnvironment(environment: PythonEnvironment): NodeJS.ProcessEnv {
	return {
		...process.env,
		VIRTUAL_ENV: environmentDirectory(environment),
		PATH: `${dirname(environment.pythonPath)}:${process.env.PATH ?? ""}`,
	};
}

/** A section is the dotted path of the settings this host resolved; no settings for one is `null`, which
 * is what the protocol spells that as. */
function sectionSettings(settings: Settings, section: unknown): unknown {
	if (typeof section !== "string") return settings;
	let value: unknown = settings;
	for (const part of section.split(".")) {
		if (typeof value !== "object" || value === null) return null;
		value = (value as Settings)[part];
	}
	return value ?? null;
}

function configurationAnswer(settings: Settings, frame: JsonRpcFrame): JsonRpcFrame | undefined {
	if (frame.method !== "workspace/configuration" || frame.id === undefined) return undefined;
	const items = (frame.params as { items?: { section?: unknown }[] } | undefined)?.items ?? [];
	return {
		jsonrpc: "2.0",
		id: frame.id,
		result: items.map((item) => sectionSettings(settings, item.section)),
	};
}

/**
 * Client frames go to the child and child frames come back — the two directions `forward` would wire —
 * plus the configuration exchange only this host can take part in: `workspace/configuration` is answered
 * here with the settings resolved from the filesystem, and the same settings go to the child as the
 * `workspace/didChangeConfiguration` a server reads when its client offers no way to be asked.
 */
function connectBridge(
	clientConnection: IConnection,
	serverConnection: IConnection,
	settings: Settings | undefined,
): void {
	clientConnection.reader.listen((message) => {
		const frame = message as JsonRpcFrame;
		void serverConnection.writer.write(frame);
		if (settings === undefined || frame.method !== "initialized") return;
		const changed: JsonRpcFrame = {
			jsonrpc: "2.0",
			method: "workspace/didChangeConfiguration",
			params: { settings },
		};
		void serverConnection.writer.write(changed);
	});
	serverConnection.reader.listen((message) => {
		const frame = message as JsonRpcFrame;
		const answer = settings === undefined ? undefined : configurationAnswer(settings, frame);
		if (answer !== undefined) {
			void serverConnection.writer.write(answer);
			return;
		}
		void clientConnection.writer.write(frame);
	});
	clientConnection.onClose(() => serverConnection.dispose());
	serverConnection.onClose(() => clientConnection.dispose());
}

/**
 * Frames arrive as WebSocket messages and leave the child as `Content-Length`-framed stdio: that is the
 * whole translation. Which project a language server analyzes comes from `root` on the upgrade — never
 * this process's cwd — and only its configuration is ever named here.
 */
export function openLspSession(
	socket: LspSocket,
	languageId: string,
	workspaceRoot?: string,
): LspSessionHandle | undefined {
	const server = resolveServerCommand(languageId);
	if (server === undefined) return undefined;
	const root =
		workspaceRoot !== undefined && isAbsolute(workspaceRoot) ? resolve(workspaceRoot) : undefined;
	const environment =
		languageId === PYTHON && root !== undefined ? resolvePythonEnvironment(root) : undefined;
	const settings = environment === undefined ? undefined : pythonSettings(environment);
	const child = spawn(server.command, server.args, {
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
		...(root === undefined ? {} : { cwd: root }),
		...(environment === undefined || environmentDirectory(environment) === undefined
			? {}
			: { env: childEnvironment(environment) }),
	});
	let deliver: ((data: unknown) => void) | undefined;
	const adapter: IWebSocket = {
		$type: "IWebSocket",
		send: (content) => {
			if (socket.readyState === SOCKET_OPEN) socket.send(content);
		},
		onMessage: (callback) => {
			deliver = callback;
		},
		onError: (reason) => log.debug(`language server socket error (${languageId})`, reason),
		// shortcut: closure reaches this module through closeLspSession (the host's close handler);
		// register onClose when a client can half-close this socket.
		onClose: () => undefined,
		dispose: () => closeSocket(socket, 1000),
	};
	const clientConnection = createWebSocketConnection(adapter);
	const serverConnection = createProcessStreamConnection(child);
	if (serverConnection === undefined) {
		log.error(`language server has no stdio pipe (${languageId})`);
		child.kill();
		closeSocket(socket, 1011);
		return undefined;
	}
	connectBridge(clientConnection, serverConnection, settings);
	const session: LspSession = { child, deliver: (data) => deliver?.(data) };
	sessions.set(socket, session);
	log.info(
		`client connected to /lsp (${languageId}) root=${root ?? "none"} pid=${child.pid ?? "none"}`,
	);
	child.on("error", (error) => {
		log.error(`language server failed (${languageId})`, error);
		// A child that never spoke may have no pipe to close, so this path closes the socket itself.
		endSession(socket, 1011);
	});
	child.stderr?.on("data", (data: Buffer) =>
		log.debug(`language server (${languageId}): ${data.toString().trimEnd()}`),
	);
	// A child that dies on its own ends the connection: a client attached to a dead server would wait
	// forever for answers that never come.
	child.on("exit", (code, signal) => {
		log.debug(
			`language server exited (${languageId}): code=${code ?? "null"} signal=${signal ?? "none"}`,
		);
		endSession(socket);
	});
	return { pid: child.pid };
}

export function readLspMessage(socket: LspSocket, raw: string | Uint8Array): void {
	sessions.get(socket)?.deliver(typeof raw === "string" ? raw : utf8.decode(raw));
}

export function closeLspSession(socket: LspSocket): void {
	endSession(socket);
}

export function closeAllLspSessions(): void {
	for (const socket of sessions.keys()) endSession(socket);
}
