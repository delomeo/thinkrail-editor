import { describe, expect, test } from "bun:test";
import { type NativeQuitHint, QUIT_CONFIRMATION } from "@thinkrail/contracts";
import {
	createIdeShortcuts,
	createWebShortcuts,
	hasWebShortcuts,
	IDE_SHORTCUT_COMMANDS,
	type IdeCommandId,
	isNativeIdeCommand,
	matchIdeCommand,
	matchShortcut,
	SHORTCUT_COMMANDS,
	type ShortcutPlatform,
	shortcutPlatform,
} from "./shortcutCommands";
import { globalHotkeyCommand } from "./useGlobalHotkeys";

const { holdMs, pollMs } = QUIT_CONFIRMATION;
const TERMINAL = { terminal: true };

function chord(code: string, overrides: Partial<KeyboardEvent> = {}) {
	return {
		code,
		key: "",
		ctrlKey: true,
		metaKey: false,
		altKey: false,
		shiftKey: false,
		...overrides,
	};
}

function harness(platform: ShortcutPlatform = "linux") {
	let time = 0;
	let poll: (() => void) | null = null;
	const hints: NativeQuitHint[] = [];
	const log: string[] = [];
	const shortcuts = createWebShortcuts({
		platform,
		closeItem: () => log.push("close-item"),
		openSettings: () => log.push("open-settings"),
		quit: () => log.push("quit"),
		onQuitHint: (hint) => hints.push(hint),
		isInTerminal: (target) => target === TERMINAL,
		now: () => time,
		every: (callback) => {
			poll = callback;
			return () => {
				poll = null;
			};
		},
	});
	function keydown(code: string, overrides: Partial<KeyboardEvent> = {}, target: unknown = null) {
		const event = {
			...chord(code, overrides),
			repeat: overrides.repeat ?? false,
			target: target as EventTarget | null,
			prevented: false,
			preventDefault() {
				event.prevented = true;
			},
			stopPropagation() {},
		};
		shortcuts.keydown(event);
		return event.prevented;
	}
	function advance(ms: number) {
		const end = time + ms;
		while (time < end) {
			time = Math.min(end, time + pollMs);
			poll?.();
		}
	}
	return {
		shortcuts,
		hints,
		log,
		keydown,
		keyup: (code: string, key = "") => shortcuts.keyup({ code, key }),
		advance,
	};
}

describe("shortcut platform", () => {
	test("binds web chords only on desktop Windows and Linux", () => {
		expect(shortcutPlatform(false, "Linux x86_64")).toBe("browser");
		expect(shortcutPlatform(true, "MacIntel")).toBe("apple");
		expect(shortcutPlatform(true, "Win32")).toBe("windows");
		expect(shortcutPlatform(true, "Linux x86_64")).toBe("linux");
		expect(shortcutPlatform(true, "")).toBe("browser");
	});
});

describe("chord matching", () => {
	test("each platform binds its table and only with a bare Ctrl", () => {
		const table = {
			apple: { KeyW: null, F4: null, KeyQ: null, Comma: null },
			browser: { KeyW: null, F4: null, KeyQ: null, Comma: null },
			windows: { KeyW: "close-item", F4: "close-item", KeyQ: null, Comma: "open-settings" },
			linux: { KeyW: "close-item", F4: "close-item", KeyQ: "quit", Comma: "open-settings" },
		} as const;
		for (const [platform, codes] of Object.entries(table)) {
			for (const [code, command] of Object.entries(codes)) {
				expect(matchShortcut(chord(code), platform as ShortcutPlatform, () => false)).toBe(command);
				expect(
					matchShortcut(
						chord(code, { ctrlKey: false, metaKey: true }),
						platform as ShortcutPlatform,
						() => false,
					),
				).toBeNull();
			}
		}
		for (const modifier of ["metaKey", "altKey", "shiftKey"] as const) {
			expect(matchShortcut(chord("KeyW", { [modifier]: true }), "linux", () => false)).toBeNull();
		}
		expect(matchShortcut(chord("KeyW", { ctrlKey: false }), "linux", () => false)).toBeNull();
		const terminalCheckSkipped = () => {
			throw new Error("terminal check must run only after a chord matches");
		};
		expect(
			matchShortcut(chord("KeyQ", { ctrlKey: false }), "linux", terminalCheckSkipped),
		).toBeNull();
		expect(matchShortcut(chord("KeyA"), "linux", terminalCheckSkipped)).toBeNull();
	});

	test("inside a terminal Ctrl+W goes to the shell; Ctrl+F4, Ctrl+Q, Ctrl+, stay app-owned", () => {
		expect(matchShortcut(chord("KeyW"), "linux", () => true)).toBeNull();
		expect(matchShortcut(chord("Comma", { key: "," }), "windows", () => true)).toBe(
			"open-settings",
		);
		expect(matchShortcut(chord("F4"), "windows", () => true)).toBe("close-item");
		expect(matchShortcut(chord("KeyQ"), "linux", () => true)).toBe("quit");
	});

	test("letter chords follow the typed letter; non-Latin layouts fall back to code", () => {
		const azertyUndo = chord("KeyW", { key: "z" });
		const azertySelectAll = chord("KeyQ", { key: "a" });
		expect(matchShortcut(azertyUndo, "windows", () => false)).toBeNull();
		expect(matchShortcut(azertyUndo, "linux", () => false)).toBeNull();
		expect(matchShortcut(azertySelectAll, "linux", () => false)).toBeNull();
		expect(matchShortcut(azertySelectAll, "linux", () => true)).toBeNull();
		expect(matchShortcut(chord("KeyZ", { key: "w" }), "windows", () => false)).toBe("close-item");
		expect(matchShortcut(chord("KeyA", { key: "q" }), "linux", () => true)).toBe("quit");
		expect(matchShortcut(chord("KeyW", { key: "W" }), "linux", () => false)).toBe("close-item");
		expect(matchShortcut(chord("KeyW", { key: "ц" }), "linux", () => false)).toBe("close-item");
		expect(matchShortcut(chord("F4", { key: "F4" }), "windows", () => false)).toBe("close-item");
	});

	test("Ctrl+, follows the typed comma, including a Shift-produced one", () => {
		const match = (code: string, overrides: Partial<KeyboardEvent>) =>
			matchShortcut(chord(code, overrides), "windows", () => false);
		expect(match("Comma", { key: "," })).toBe("open-settings");
		expect(match("KeyM", { key: "," })).toBe("open-settings");
		expect(match("Slash", { key: ",", shiftKey: true })).toBe("open-settings");
		expect(match("Comma", { key: "б" })).toBe("open-settings");
		expect(match("Comma", { key: ";" })).toBeNull();
		expect(match("Comma", { key: "<", shiftKey: true })).toBeNull();
		expect(match("Comma", { key: "Б", shiftKey: true })).toBeNull();
		expect(match("Comma", { key: ",", altKey: true })).toBeNull();
		expect(match("Comma", { key: ",", ctrlKey: false, metaKey: true })).toBeNull();
		expect(match("KeyW", { key: "W", shiftKey: true })).toBeNull();
	});
});

test("only windows and linux bind web chords", () => {
	expect(hasWebShortcuts("apple")).toBe(false);
	expect(hasWebShortcuts("browser")).toBe(false);
	expect(hasWebShortcuts("windows")).toBe(true);
	expect(hasWebShortcuts("linux")).toBe(true);
});

test("no table chord is also a global hotkey", () => {
	const available = { projects: true, workspace: true, bottom: true, newWorkspace: true };
	for (const platform of ["Win32", "Linux x86_64"]) {
		for (const command of SHORTCUT_COMMANDS) {
			for (const { code } of Object.values(command.chords).flat()) {
				expect(globalHotkeyCommand(chord(code), available, false, platform)).toBeNull();
			}
		}
	}
});

test("keydown swallows repeats and leaves terminal Ctrl+W unprevented", () => {
	const h = harness("linux");
	expect(h.keydown("F4", { repeat: true })).toBe(true);
	expect(h.log).toEqual([]);
	expect(h.keydown("KeyW", {}, TERMINAL)).toBe(false);
	expect(h.keydown("F4", {}, TERMINAL)).toBe(true);
	expect(h.log).toEqual(["close-item"]);
});

test("Ctrl+, runs open-settings once per press, inside a terminal too", () => {
	const h = harness("windows");
	expect(h.keydown("Comma", { key: "," }, TERMINAL)).toBe(true);
	expect(h.keydown("Comma", { key: ",", repeat: true })).toBe(true);
	expect(h.log).toEqual(["open-settings"]);
	h.shortcuts.run("open-settings");
	expect(h.log).toEqual(["open-settings", "open-settings"]);
});

describe("linux quit confirmation", () => {
	test("a second press inside the window quits on KeyQ release, once", () => {
		const h = harness();
		h.keydown("KeyQ");
		h.keyup("KeyQ");
		h.advance(120);
		h.keydown("KeyQ");
		expect(h.hints).toEqual(["armed", "release"]);
		h.keydown("KeyQ", { repeat: true });
		h.keyup("KeyQ");
		h.keydown("KeyQ");
		h.keyup("KeyQ");
		expect(h.hints).toEqual(["armed", "release", "quitting"]);
		expect(h.log).toEqual(["quit"]);
	});

	test("a hold ignores unrelated keyups and quits on Control release", () => {
		const h = harness();
		h.keydown("KeyQ");
		h.keyup("KeyA", "a");
		for (let elapsed = 0; elapsed < holdMs + pollMs; elapsed += pollMs) {
			h.keydown("KeyQ", { repeat: true });
			h.advance(pollMs);
		}
		expect(h.hints).toEqual(["armed", "release"]);
		expect(h.log).toEqual([]);
		h.keyup("ControlLeft", "Control");
		expect(h.hints).toEqual(["armed", "release", "quitting"]);
		expect(h.log).toEqual(["quit"]);
	});

	test("an AZERTY hold releases only on the key it started with", () => {
		const h = harness();
		h.keydown("KeyA", { key: "q" });
		h.keyup("KeyQ", "a");
		h.advance(holdMs + pollMs);
		expect(h.hints).toEqual(["armed", "release"]);
		h.keyup("KeyA", "q");
		expect(h.hints).toEqual(["armed", "release", "quitting"]);
		expect(h.log).toEqual(["quit"]);
	});
});

const IDE_IDS = IDE_SHORTCUT_COMMANDS.map((command) => command.id);

function modChord(
	platform: ShortcutPlatform,
	code: string,
	overrides: Partial<KeyboardEvent> = {},
) {
	const apple = platform === "apple";
	return chord(code, { ctrlKey: !apple, metaKey: apple, ...overrides });
}

function ideRunner(
	platform: ShortcutPlatform,
	handles: readonly IdeCommandId[],
	options: { modal?: boolean; terminal?: boolean } = {},
) {
	const log: string[] = [];
	const handlers = Object.fromEntries(
		IDE_SHORTCUT_COMMANDS.map(({ id }) => [
			id,
			() => {
				if (!handles.includes(id)) return false;
				log.push(id);
				return true;
			},
		]),
	) as Record<IdeCommandId, () => boolean>;
	const runner = createIdeShortcuts({
		platform,
		handlers,
		modalOpen: () => options.modal ?? false,
		isInTerminal: () => options.terminal ?? false,
	});
	function keydown(code: string, overrides: Partial<KeyboardEvent> = {}) {
		const event = {
			...modChord(platform, code, overrides),
			repeat: overrides.repeat ?? false,
			target: null as EventTarget | null,
			prevented: false,
			stoppedImmediate: false,
			preventDefault() {
				event.prevented = true;
			},
			stopPropagation() {},
			stopImmediatePropagation() {
				event.stoppedImmediate = true;
			},
		};
		runner.keydown(event);
		return { prevented: event.prevented, stoppedImmediate: event.stoppedImmediate };
	}
	return {
		log,
		keydown,
		keyup: (code: string, shiftKey = false) => runner.keyup({ code, shiftKey }),
		cancel: runner.cancel,
	};
}

describe("IDE command chords", () => {
	test("the table registers the four commands with their default Mod chords", () => {
		expect(IDE_IDS).toEqual(["file.new", "folder.new", "file.save", "project.open"]);
		const table = {
			apple: { KeyN: "file.new", KeyS: "file.save", KeyO: "project.open" },
			windows: { KeyN: "file.new", KeyS: "file.save", KeyO: "project.open" },
			linux: { KeyN: "file.new", KeyS: "file.save", KeyO: "project.open" },
			browser: { KeyN: null, KeyS: null, KeyO: null },
		} as const;
		for (const [platform, codes] of Object.entries(table)) {
			for (const [code, command] of Object.entries(codes)) {
				expect(
					matchIdeCommand(
						modChord(platform as ShortcutPlatform, code),
						platform as ShortcutPlatform,
						() => false,
					),
				).toBe(command);
			}
		}
	});

	test("a command matches only its own modifier set, never inside a terminal", () => {
		const match = (code: string, overrides: Partial<KeyboardEvent> = {}) =>
			matchIdeCommand(modChord("linux", code, overrides), "linux", () => false);
		expect(match("KeyN", { key: "n" })).toBe("file.new");
		expect(match("KeyN", { key: "N", shiftKey: true })).toBe("folder.new");
		expect(match("KeyN", { key: "ц", shiftKey: true })).toBe("folder.new");
		expect(match("KeyN", { shiftKey: true })).toBe("folder.new");
		expect(match("KeyO", { shiftKey: true })).toBeNull();
		expect(match("KeyS", { altKey: true })).toBeNull();
		expect(match("KeyS", { ctrlKey: false, metaKey: true })).toBeNull();
		expect(match("KeyS", { ctrlKey: false })).toBeNull();
		expect(match("KeyA")).toBeNull();
		const inTerminal = (code: string) =>
			matchIdeCommand(modChord("linux", code), "linux", () => true);
		expect(inTerminal("KeyN")).toBeNull();
		expect(inTerminal("KeyS")).toBeNull();
		expect(inTerminal("KeyO")).toBeNull();
		expect(matchIdeCommand(modChord("apple", "KeyO"), "apple", () => false)).toBe("project.open");
		expect(
			matchIdeCommand(
				modChord("apple", "KeyO", { ctrlKey: true, metaKey: false }),
				"apple",
				() => false,
			),
		).toBeNull();
	});

	test("no IDE chord shadows a destructive table chord, and the reverse", () => {
		for (const platform of ["apple", "windows", "linux", "browser"] as const) {
			for (const code of ["KeyW", "F4", "KeyQ", "Comma"]) {
				expect(matchIdeCommand(modChord(platform, code), platform, () => false)).toBeNull();
			}
			for (const code of ["KeyN", "KeyS", "KeyO"]) {
				expect(matchShortcut(modChord(platform, code), platform, () => false)).toBeNull();
			}
		}
	});

	test("the host's File menu commands name IDE actions, the destructive chords do not", () => {
		for (const id of IDE_SHORTCUT_COMMANDS.map((command) => command.id)) {
			expect(isNativeIdeCommand(id)).toBe(true);
		}
		expect(isNativeIdeCommand("close-item")).toBe(false);
		expect(isNativeIdeCommand("open-settings")).toBe(false);
	});

	test("a claimed chord runs its handler once per physical press, then swallows the repeats", () => {
		const h = ideRunner("windows", ["file.save"]);
		expect(h.keydown("KeyS")).toEqual({ prevented: true, stoppedImmediate: true });
		expect(h.log).toEqual(["file.save"]);
		expect(h.keydown("KeyS", { repeat: true })).toEqual({
			prevented: true,
			stoppedImmediate: true,
		});
		expect(h.log).toEqual(["file.save"]);
		h.keyup("KeyS");
		expect(h.keydown("KeyS")).toEqual({ prevented: true, stoppedImmediate: true });
		expect(h.log).toEqual(["file.save", "file.save"]);
		h.keydown("KeyS", { repeat: true });
		h.cancel();
		expect(h.keydown("KeyS")).toEqual({ prevented: true, stoppedImmediate: true });
		expect(h.log).toEqual(["file.save", "file.save", "file.save"]);
	});

	test("Shift selects folder.new and leaves file.new on the unshifted press", () => {
		const h = ideRunner("apple", ["file.new", "folder.new"]);
		expect(h.keydown("KeyN")).toEqual({ prevented: true, stoppedImmediate: true });
		expect(h.log).toEqual(["file.new"]);
		h.keyup("KeyN");
		expect(h.keydown("KeyN", { shiftKey: true })).toEqual({
			prevented: true,
			stoppedImmediate: true,
		});
		expect(h.log).toEqual(["file.new", "folder.new"]);
	});

	test("an unclaimed chord is neither swallowed nor stopped, so its other owner still runs", () => {
		const h = ideRunner("linux", []);
		expect(h.keydown("KeyN")).toEqual({ prevented: false, stoppedImmediate: false });
		expect(h.keydown("KeyO")).toEqual({ prevented: false, stoppedImmediate: false });
		expect(h.log).toEqual([]);
		const available = { projects: true, workspace: true, bottom: true, newWorkspace: true };
		expect(globalHotkeyCommand(chord("KeyN"), available, false, "Linux x86_64")).toBe(
			"new-workspace",
		);
	});

	test("a modal layer or xterm keeps the keyboard", () => {
		const modal = ideRunner("windows", ["project.open"], { modal: true });
		expect(modal.keydown("KeyO")).toEqual({ prevented: false, stoppedImmediate: false });
		expect(modal.log).toEqual([]);
		const terminal = ideRunner("windows", ["file.save"], { terminal: true });
		expect(terminal.keydown("KeyS")).toEqual({ prevented: false, stoppedImmediate: false });
		expect(terminal.log).toEqual([]);
	});
});
