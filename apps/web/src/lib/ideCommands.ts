import type { NativeIdeCommand as IdeCommandId } from "@thinkrail/contracts";

type IdeCommandListener = () => void;

const listeners = new Map<IdeCommandId, Set<IdeCommandListener>>();

export function subscribeIdeCommand(id: IdeCommandId, listener: () => void) {
	let set = listeners.get(id);
	if (!set) {
		set = new Set();
		listeners.set(id, set);
	}
	set.add(listener);
	return () => {
		set.delete(listener);
		if (set.size === 0) listeners.delete(id);
	};
}

export function requestIdeCommand(id: IdeCommandId): boolean {
	const set = listeners.get(id);
	if (!set || set.size === 0) return false;
	for (const listener of set) listener();
	return true;
}
