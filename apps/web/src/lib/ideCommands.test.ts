import { expect, test } from "bun:test";
import { requestIdeCommand, subscribeIdeCommand } from "./ideCommands";

test("IDE command requests reach only current subscribers", () => {
	let calls = 0;
	expect(requestIdeCommand("file.save")).toBe(false);
	const unsubscribe = subscribeIdeCommand("file.save", () => {
		calls += 1;
	});
	expect(requestIdeCommand("file.save")).toBe(true);
	requestIdeCommand("file.save");
	unsubscribe();
	expect(requestIdeCommand("file.save")).toBe(false);
	expect(calls).toBe(2);
});

test("each command is isolated and multiple surfaces can share one", () => {
	const log: string[] = [];
	const offNew = subscribeIdeCommand("file.new", () => log.push("new"));
	const offSave = subscribeIdeCommand("file.save", () => log.push("save"));
	const offSecondNew = subscribeIdeCommand("file.new", () => log.push("new-2"));
	requestIdeCommand("file.new");
	requestIdeCommand("project.open");
	expect(log).toEqual(["new", "new-2"]);
	offNew();
	offSecondNew();
	offSave();
	expect(requestIdeCommand("file.new")).toBe(false);
	expect(requestIdeCommand("file.save")).toBe(false);
});
