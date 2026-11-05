import type { NativeCommand, NativeQuitHint, NativeShortcutsBridge } from "@thinkrail/contracts";
import { useEffect, useState } from "react";
import { platformShortcutLabel, requestIdeCommand } from "../lib";
import { startTreeCreate } from "../panels/filesTreeState";
import { selectActiveWorkspace, useAppStore } from "../store";
import { requestClose } from "./closeRequestChannel";
import {
	createIdeShortcuts,
	createWebShortcuts,
	hasIdeShortcuts,
	hasWebShortcuts,
	type IdeCommandId,
	isNativeIdeCommand,
	shortcutPlatform,
} from "./shortcutCommands";
import {
	hasDismissibleLayer,
	hasLayer,
	isInTerminal,
	MODAL_LAYER_SELECTOR,
} from "./shortcutLayers";

const NATIVE_SHORTCUTS_GLOBAL = "__THINKRAIL_NATIVE_SHORTCUTS__";

export function getNativeShortcutsBridge(value: unknown): NativeShortcutsBridge | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	try {
		return typeof Reflect.get(value, "subscribeQuitHint") === "function" &&
			typeof Reflect.get(value, "subscribeCommand") === "function" &&
			typeof Reflect.get(value, "quit") === "function"
			? (value as NativeShortcutsBridge)
			: null;
	} catch {
		return null;
	}
}

function readNativeShortcutsBridge() {
	return getNativeShortcutsBridge(Reflect.get(globalThis, NATIVE_SHORTCUTS_GLOBAL));
}

export function readSettingsShortcutLabel(): string | null {
	return shortcutPlatform(readNativeShortcutsBridge() !== null) === "browser"
		? null
		: platformShortcutLabel(",");
}

function dismissTopLayer() {
	const doc = globalThis.document;
	if (!hasDismissibleLayer(doc)) return false;
	(doc.activeElement ?? doc.body ?? doc).dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "Escape",
			code: "Escape",
			bubbles: true,
			cancelable: true,
		}),
	);
	return true;
}

/** The id → handler map the file / project chords run; a surface that can perform one subscribes in `ideCommands.ts`. */
export function ideCommandHandlers(): Record<IdeCommandId, () => boolean> {
	return {
		"file.new": () => requestIdeCommand("file.new"),
		"folder.new": () => requestIdeCommand("folder.new"),
		"file.save": () => requestIdeCommand("file.save"),
		"project.open": () => requestIdeCommand("project.open"),
	};
}

/**
 * The File menu's own items, from the topbar or the host's native menu. A menu click is an explicit request,
 * unlike a chord: where no mounted surface claims it, **New file** / **New folder** open the Files tool and
 * start the same inline name row its header pair starts, so the item never silently does nothing. **Save**
 * has no fallback — with no file pane there is nothing to save — and an unclaimed chord never comes here at
 * all, so an unclaimed `Mod+N` still belongs to `NewWorkspaceDialog`.
 */
export function runFileMenuCommand(command: "file.new" | "folder.new" | "file.save"): void {
	if (requestIdeCommand(command)) return;
	if (command === "file.save") return;
	const state = useAppStore.getState();
	const workspaceId = selectActiveWorkspace(state)?.id;
	if (!workspaceId) return;
	startTreeCreate(workspaceId, command === "file.new" ? "file" : "dir");
	state.requestToolView(workspaceId, "files");
}

function openSettingsUnlessModal() {
	if (!hasLayer(globalThis.document, MODAL_LAYER_SELECTOR)) useAppStore.getState().openSettings();
}

function subscribeToNativeShortcuts(
	bridge: NativeShortcutsBridge,
	onQuitHint: (hint: NativeQuitHint) => void,
	onCommand: (command: NativeCommand) => void,
) {
	let active = true;
	const unsubscribeQuitHint = bridge.subscribeQuitHint((hint) => {
		if (active) onQuitHint(hint);
	});
	const unsubscribeCommand = bridge.subscribeCommand((command) => {
		if (active) onCommand(command);
	});
	return () => {
		active = false;
		unsubscribeQuitHint();
		unsubscribeCommand();
	};
}

function intervalScope() {
	const stops = new Set<() => void>();
	function every(callback: () => void, ms: number) {
		const timer = setInterval(callback, ms);
		function stop() {
			clearInterval(timer);
			stops.delete(stop);
		}
		stops.add(stop);
		return stop;
	}
	function dispose() {
		for (const stop of stops) stop();
	}
	return { every, dispose };
}

export function useAppShortcuts() {
	const [bridge] = useState(readNativeShortcutsBridge);
	const [quitHint, setQuitHint] = useState<NativeQuitHint>("hidden");

	useEffect(() => {
		if (!bridge) return undefined;
		const intervals = intervalScope();
		const platform = shortcutPlatform(true);
		const listensForKeys = hasWebShortcuts(platform);
		const listensForIdeKeys = hasIdeShortcuts(platform);
		const shortcuts = createWebShortcuts({
			platform,
			closeItem: () => {
				if (!dismissTopLayer()) requestClose();
			},
			openSettings: openSettingsUnlessModal,
			quit: () => {
				bridge.quit().catch((error: unknown) => {
					console.error("[shortcuts] quit failed", error);
					shortcuts.resetQuit();
				});
			},
			onQuitHint: setQuitHint,
			isInTerminal,
			now: () => performance.now(),
			every: intervals.every,
		});
		function runNativeCommand(command: NativeCommand) {
			if (command === "file.new" || command === "folder.new" || command === "file.save") {
				// The native File menu's items are menu clicks, the same as the topbar's.
				runFileMenuCommand(command);
				return;
			}
			if (isNativeIdeCommand(command)) requestIdeCommand(command);
			else shortcuts.run(command);
		}
		const unsubscribe = subscribeToNativeShortcuts(bridge, setQuitHint, runNativeCommand);
		const doc = globalThis.document;
		const ide = createIdeShortcuts({
			platform,
			handlers: ideCommandHandlers(),
			modalOpen: () => hasLayer(doc, MODAL_LAYER_SELECTOR),
			isInTerminal,
		});
		function cancelHeld() {
			shortcuts.cancel();
			ide.cancel();
		}
		function onVisibilityChange() {
			if (doc.visibilityState === "hidden") cancelHeld();
		}
		if (listensForKeys) {
			window.addEventListener("keydown", shortcuts.keydown, true);
			window.addEventListener("keyup", shortcuts.keyup, true);
		}
		if (listensForIdeKeys) {
			window.addEventListener("keydown", ide.keydown, true);
			window.addEventListener("keyup", ide.keyup, true);
		}
		window.addEventListener("blur", cancelHeld);
		doc.addEventListener("visibilitychange", onVisibilityChange);
		return () => {
			unsubscribe();
			if (listensForKeys) {
				window.removeEventListener("keydown", shortcuts.keydown, true);
				window.removeEventListener("keyup", shortcuts.keyup, true);
			}
			if (listensForIdeKeys) {
				window.removeEventListener("keydown", ide.keydown, true);
				window.removeEventListener("keyup", ide.keyup, true);
			}
			window.removeEventListener("blur", cancelHeld);
			doc.removeEventListener("visibilitychange", onVisibilityChange);
			intervals.dispose();
		};
	}, [bridge]);

	return bridge ? quitHint : null;
}
