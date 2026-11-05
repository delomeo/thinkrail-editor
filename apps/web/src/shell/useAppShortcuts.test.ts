import { expect, test } from "bun:test";
import type { NativeShortcutsBridge, Workspace } from "@thinkrail/contracts";
import { subscribeIdeCommand } from "../lib";
import { endTreeEdit, selectTreeEdit } from "../panels/filesTreeState";
import { useAppStore } from "../store";
import { IDE_SHORTCUT_COMMANDS } from "./shortcutCommands";
import {
	getNativeShortcutsBridge,
	ideCommandHandlers,
	runFileMenuCommand,
} from "./useAppShortcuts";

test("getNativeShortcutsBridge accepts only the full bridge shape", () => {
	expect(getNativeShortcutsBridge(undefined)).toBeNull();
	expect(getNativeShortcutsBridge([])).toBeNull();
	expect(getNativeShortcutsBridge({ subscribeQuitHint: () => {} })).toBeNull();
	expect(
		getNativeShortcutsBridge({ subscribeQuitHint: () => {}, subscribeCommand: () => {} }),
	).toBeNull();
	const bridge: NativeShortcutsBridge = {
		subscribeQuitHint: () => () => {},
		subscribeCommand: () => () => {},
		quit: async () => {},
	};
	expect(getNativeShortcutsBridge(bridge)).toBe(bridge);
});

test("IDE command handlers cover the command table and dispatch through the shell channel", () => {
	const handlers = ideCommandHandlers();
	expect(Object.keys(handlers).sort()).toEqual(IDE_SHORTCUT_COMMANDS.map((c) => c.id).sort());
	for (const id of IDE_SHORTCUT_COMMANDS.map((c) => c.id)) {
		expect(handlers[id]()).toBe(false);
	}
	const log: string[] = [];
	const unsubscribe = subscribeIdeCommand("project.open", () => log.push("picker"));
	expect(handlers["project.open"]()).toBe(true);
	expect(log).toEqual(["picker"]);
	unsubscribe();
	expect(handlers["project.open"]()).toBe(false);
});

test("a File menu item runs a claimed command, and otherwise starts the Files name row and reveals that tool", () => {
	const workspace: Workspace = {
		id: "w1",
		projectId: "p1",
		name: "workspace-1",
		branch: "workspace-1",
		worktreePath: "/wt/w1",
		baseBranch: "main",
	};
	useAppStore.setState({
		workspaces: { p1: [workspace] },
		activeWorkspaceId: "w1",
		removedWorkspaceIds: {},
		filesMode: "changed",
		layoutIntents: [],
	});

	const log: string[] = [];
	const unsubscribe = subscribeIdeCommand("file.new", () => log.push("claimed"));
	runFileMenuCommand("file.new");
	unsubscribe();
	expect(log).toEqual(["claimed"]);
	expect(selectTreeEdit("w1").create).toBeNull();
	expect(useAppStore.getState().layoutIntents).toEqual([]);

	runFileMenuCommand("folder.new");
	expect(selectTreeEdit("w1").create).toEqual({ parentDir: "", kind: "dir" });
	expect(useAppStore.getState().filesMode).toBe("all");
	const intents = useAppStore.getState().layoutIntents;
	expect(intents).toHaveLength(1);
	expect(intents[0]).toMatchObject({ kind: "reveal-tool", workspaceId: "w1", tool: "files" });
	endTreeEdit("w1");
});
