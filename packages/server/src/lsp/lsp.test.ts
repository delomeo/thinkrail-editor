import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	closeAllLspSessions,
	closeLspSession,
	type LspSocket,
	openLspSession,
	readLspMessage,
	resolveServerCommand,
} from ".";

interface FakeSocket extends LspSocket {
	readonly sent: string[];
	readonly closed: number[];
	readyState: number;
}

function fakeSocket(): FakeSocket {
	const socket: FakeSocket = {
		readyState: 1,
		sent: [],
		closed: [],
		send: (data) => {
			socket.sent.push(data);
			return data.length;
		},
		close: (code) => {
			socket.readyState = 2;
			socket.closed.push(code ?? 1000);
		},
	};
	return socket;
}

interface RpcFrame {
	id?: number | string;
	result?: { capabilities?: unknown };
}

function frames(socket: FakeSocket): RpcFrame[] {
	return socket.sent.map((sent) => JSON.parse(sent) as RpcFrame);
}

async function responseTo(socket: FakeSocket, id: number, timeoutMs: number): Promise<RpcFrame> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const frame = frames(socket).find((candidate) => candidate.id === id);
		if (frame !== undefined) return frame;
		await Bun.sleep(50);
	}
	throw new Error(`no language-server response to id=${id} within ${timeoutMs}ms`);
}

async function childIsGone(pid: number): Promise<boolean> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
		} catch {
			return true;
		}
		await Bun.sleep(50);
	}
	return false;
}

const tmpDirs: string[] = [];

afterEach(() => {
	closeAllLspSessions();
	while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

test("the language allow-list resolves to installed stdio servers, and nothing else", () => {
	for (const language of ["python", "typescript", "javascript"]) {
		const command = resolveServerCommand(language);
		if (command === undefined) throw new Error(`no language server for ${language}`);
		expect(command.args).toEqual(["--stdio"]);
		expect(existsSync(command.command)).toBe(true);
	}
	expect(resolveServerCommand("cobol")).toBeUndefined();
	expect(resolveServerCommand("")).toBeUndefined();
});

test("an /lsp session pipes LSP frames to the spawned server and back", async () => {
	const root = mkdtempSync(join(tmpdir(), "thinkrail-lsp-"));
	tmpDirs.push(root);
	const socket = fakeSocket();
	const session = openLspSession(socket, "python");
	if (session?.pid === undefined) throw new Error("language server child did not start");

	readLspMessage(
		socket,
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				processId: null,
				clientInfo: { name: "thinkrail-lsp-test" },
				rootUri: `file://${root}`,
				capabilities: {},
			},
		}),
	);

	const initialized = await responseTo(socket, 1, 25_000);
	const capabilities = initialized.result?.capabilities;
	if (typeof capabilities !== "object" || capabilities === null) {
		throw new Error("initialize returned no capabilities");
	}
	expect(capabilities).toHaveProperty("textDocumentSync");

	// A frame the bridge cannot parse never reaches the child as a crash: the socket stays open.
	readLspMessage(socket, "not json-rpc at all");
	expect(socket.closed).toEqual([]);

	closeLspSession(socket);
	expect(await childIsGone(session.pid)).toBe(true);
});

test("a dead child closes its socket instead of leaving the client connected to nothing", async () => {
	const socket = fakeSocket();
	const session = openLspSession(socket, "python");
	if (session?.pid === undefined) throw new Error("language server child did not start");

	process.kill(session.pid, "SIGKILL");
	const closedDeadline = Date.now() + 15_000;
	while (Date.now() < closedDeadline && socket.readyState === 1) await Bun.sleep(50);
	expect(socket.readyState).toBe(2);
	expect(socket.closed).toHaveLength(1);
	expect(await childIsGone(session.pid)).toBe(true);
});
