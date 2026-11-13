---
id: submodule-server-changes
type: submodule-design
status: active
title: changes — host-owned worktree mutations: reverted hunks and files with undo receipts, and file/folder CRUD
parent: module-server
depends-on: [module-contracts, submodule-server-git, submodule-server-fs]
tags: [review, git, public-surface-checked]
---

## Responsibility

The review surface's write path: **revert one hunk or one file's whole change in the worktree**, and undo
that revert. Git and the worktree are the authority — a mutation names *what the user saw* (the scope, a
line span per side, a sha-256 per side) and this module re-derives the change from its own reads.
The same write path also serves the file tree's plain mutations — create a file or folder, save a whole
file, rename, delete through the trash — because containment, atomic write, and claim-then-trash already
live here; a second worktree write path elsewhere would fork those invariants.
The platform decision behind it is [[architecture]] decision #19; the rules below are this module's own.

## Boundary

- **Owns:** `revertChange(params)` and `undoChange(params)` — load awaits (scope resolution plus the
  bounded historical-byte read) followed by a **synchronous verify→write/claim pass**, like the
  `reviews` module's snapshot passes; the per-workspace **receipt ring**; the whole-file semantics table
  below; and the file/folder CRUD pass below, which is the same resolve→check→write shape without the git
  read.
- **Public surface (barrel):** `revertChange`, `undoChange`, `RevertChangeParams`, `UndoChangeParams`,
  `createWorkspaceFile`, `writeWorkspaceFile`, `createWorkspaceFolder`, `renameWorkspacePath`,
  `deleteWorkspacePath`, `forgetWorkspaceChanges`, `retainReceipts`.
- **Allowed deps:** `contracts` (`ChangeReceipt`/`RevertTarget`/`LineSpan`/`GitDiffScope`,
  `isWorkspaceRelativePath`, the `Workspace*Params` shapes, `ResourceMeta`), `git`
  (`resolveDiffRange`, bounded `readBlobBytesAtAsync` + `readPathModeAtAsync`), `fs` (`resolveWorktreeFile` for containment, `resourceMeta`,
  `classifyBytes`/`hashBytes`/`decodeText` for identity and textness), `persistence` (workspace lookup),
  `trash`, `@thinkrail/shared/codedError`, Node `fs`/`crypto`/`path`.
- **Forbidden:** `host`, `agent`, `reviews`; any write outside `fs`'s contained path; `unlink`.

## What a revert means

- **The scope is resolved once, through `resolveDiffRange`** — the single definition of what "the diff"
  is. Only a range whose modified side *is* the worktree is mutable; a `commit` scope is rejected with
  `SCOPE_IMMUTABLE` (there is nothing in the worktree it describes). The original side is read at the
  range's **`resolvedOriginalOid`**, not its ref, so the two reads of a load→verify→write pass cannot
  straddle a commit that moved `HEAD`.
- **Compare-and-swap on both sides, inside the lock.** `expect.originalHash` and `expect.modifiedHash`
  must equal the sha-256 of the two sides as *this* pass reads them (`null` = the path is absent, which
  is how "added" and "deleted" are expressed). Either mismatch is `STALE_VIEW` and nothing is written:
  the agent is not paused for a mutation, so CAS is the whole protection. An `uncommitted` scope's
  original side is `HEAD`, which a commit moves, so it is checked exactly like the modified one.
- **Hunk identity is engine-neutral.** A `range` target carries line spans on both sides, never a patch,
  because two client diff engines split hunks differently. The revert replaces modified lines
  `[start, start+count)` with original lines `[start, start+count)`; `count: 0` names an insertion point
  before `start`, which is what makes "delete the lines the change added" and "restore the lines it
  removed" the same operation in both directions. Spans are validated against *these* reads
  (`RANGE_INVALID`), never trusted.
- **Range reverts are text-only and never change a file's existence.** A byte-only side, or a worktree
  file that is absent, is `RANGE_INVALID` — the whole-file revert is the operation for those.
- **The line model is jsdiff's:** only `\n` terminates a line, a preceding `\r` remains part of that
  terminated segment, and a lone `\r` is ordinary content. This is the model that produced the client's
  `structuredPatch` spans, so the same span cannot address a different server line.
- **Line endings and the final newline follow the side the lines come from.** Restored original lines
  carry their own EOLs (a CRLF base stays CRLF); a line that stopped being the file's last line is
  re-terminated with the file's dominant ending, so an unterminated base tail spliced into the middle
  cannot glue two lines together. The pre-splice worktree's final-newline state is preserved unless
  **both** spans reach their respective tails; only then does the original's state win, because that tail
  is the base the user was shown.
- **Whole-file revert, by the file's status in the scope** (read from the two sides, not from a status
  word): present in both → write the original bytes (bytes, so binary files are covered); **absent in
  the original** (added or untracked) → rename the CAS-verified worktree file to a hidden same-directory
  claim, then move that claim to the OS trash; **absent in the worktree** (deleted) → restore the original
  bytes, creating missing parent directories. Undo uses the same claim before an inverse removes a file.
  The rename occurs in the synchronous verify pass, so a later agent write recreates the real path and
  cannot become the object an awaited trash helper removes. If trash fails, the claim is restored only
  while the destination is absent; a concurrent recreation wins, and the original claim is preserved as
  `.thinkrail-recovery-<ulid>` beside it with that absolute recovery path in the thrown error.
  `receipt.trashed` is the helper's absolute input path, so the file appears in the OS trash under its
  `.thinkrail-revert-<ulid>` temporary name. Absent on both sides is not a change and is refused. A
  *renamed* file reverts as its two halves — the new path trashes, the old path restores — because that
  is what the two sides of each path actually say.
- **Symlinks and mode-only changes are refused as `UNSUPPORTED_CHANGE`.** Worktree identity is read with
  `lstat`, and the original tree mode comes from `git ls-tree`; a symlink on either side is never followed.
  Equal bytes with a different mode are not a content revert and are refused. A whole-file restore
  applies the original Git mode (`100755` maps to executable permissions); a range keeps the worktree mode.
- **Writes are atomic**: a temp file in the same directory, the selected mode applied, then `rename`.
  A crash mid-write leaves either the old file or the new one, never a truncated one.

## File and folder operations

- **Containment is re-checked host-side, never trusted from the wire.** The client's own validator,
  `isWorkspaceRelativePath`, runs again here: no leading `/`, no empty segment, no `.` or `..` segment, no
  NUL. Then `fs.resolveWorktreeFile(…, { followLeaf: false })` resolves the name inside the worktree root,
  refuses `.git`, and realpaths **every existing ancestor**, so a symlinked directory cannot redirect the
  write outside the worktree. The leaf is never followed: a symlink at the target is refused as
  `UNSUPPORTED_CHANGE` rather than written through, renamed through, or trashed. A parent that exists as a
  regular file is refused, so `a.ts/b.md` never half-applies.
- **Missing parents are created recursively**, the same `mkdir -p` a whole-file restore of a reverted
  deletion uses. Content writes go through the same `writeAtomic` (temp in the same directory, then
  `rename`), so a create or a save is never a half-written file.
- **`create` refuses an occupied name; `write` replaces the whole content.** A save carries the complete
  buffer, never a patch, and keeps an existing file's mode — an executable script stays executable —
  defaulting to `0644` for a file that did not exist. A `write` onto a directory is refused.
- **Rename moves the path, not the content**, in one `renameSync`, after refusing a missing source, an
  occupied destination, and a directory moved inside itself (which the OS reports only as an opaque
  `EINVAL`). It applies to files and directories alike.
- **Delete is a trash move, never an `unlink`.** The target is claimed under a hidden
  `.thinkrail-delete-<ulid>` name in its own directory first, exactly as a whole-file revert claims what it
  trashes, so a file the agent writes into the real path during the awaited trash call cannot become the
  object that call removes. If the trash helper fails, the claim is restored to the real path when that path
  is free, and otherwise preserved as `.thinkrail-recovery-<ulid>` with its absolute path in the thrown
  error — and because `linkSync` cannot re-link a directory, a failed *directory* trash always takes that
  recovery path rather than losing the tree.
- **A name conflict or a missing target is a plain error, not a `CodedError` code.** They are the file
  tree's own "that name is taken" / "it is gone" message for the client to render, and `WsErrorCode` has no
  code for them; minting one is a contracts decision, not this module's. What this module does classify
  keeps its codes: an escaped path or `.git` reach comes from `fs`, a symbolic link is
  `UNSUPPORTED_CHANGE`.
- **These mutations take no receipt**, so they are not undoable through `change.undo`: a delete is
  recoverable from the OS trash, a create or a rename shows up in the tree the watcher reports, and the
  pane re-reads after each call. If the file tree ever wants an Undo toast here, the ring's `before` bytes
  already model a rename and a delete; extending it is a further decision, not an implied one.

## Receipts

- Every revert and undo answers with a **`ChangeReceipt`** whose id is also the undo token. The host keeps a
  per-workspace ring in memory, each entry holding the path's **`before` bytes and mode** — restoring
  what the path held *is* the inverse of every revert and undo here, so there is no separate inverse payload to keep in
  step. A trashed file is therefore undone by **writing its bytes back**, not by reaching into the
  trash, which no OS offers portably.
- **The ring is bounded twice** (`retainReceipts`): at most **20 receipts** and at most **64 MiB of held
  bytes** per workspace, evicting oldest-first, and the **newest receipt is always kept** even when it
  alone exceeds the byte budget — the Undo toast just shown must work. Twenty is more than a toast's
  8-second life can stack; 64 MiB caps what one workspace can pin in host memory at the size of the
  largest blob `/blob` will serve. `workspace.remove` calls `forgetWorkspaceChanges`, so a removed
  workspace pins nothing — and because removal is not serialized behind the change lock, `record`
  itself refuses to hold a receipt for a workspace the host no longer lists, so a revert that was
  awaiting the trash helper when its workspace disappeared cannot resurrect the ring. `retainReceipts`
  is exported as the pure policy so its bounds are tested without a 64 MiB fixture.
- `undoChange` CAS-checks the current worktree file against the client's `expect.modifiedHash` **and**,
  when both the receipt's `after` and the current file have a mode, against the receipt's `after.mode` —
  the inverse rewrites the mode too, and identical bytes under a newer executable bit are still a change
  the user did not see; a file re-created after a whole-file trash has no `after.mode` to compare, so there
  the client's hash alone decides, as before — then applies the inverse,
  then **consumes** the receipt and emits an `undo` receipt that is itself undoable once — so redo is the
  same operation, not a second mechanism. A refused undo (`STALE_VIEW`) or failed inverse leaves the
  receipt usable; every attempt re-runs `resolveWorktreeFile`, so a symlink introduced after the revert
  cannot redirect the inverse outside the worktree.
- **Receipts are host memory only**, lost on restart: the worktree is git-tracked and a trashed file is
  recoverable from the OS trash, so persisting them would add a data-dir format for a convenience those
  two already back. An id the host no longer holds — evicted, forgotten with its workspace, or lost to a
  restart behind a still-visible toast — is `RECEIPT_UNKNOWN`, never a silent no-op; the client treats
  it as information (reload, "can no longer be undone"), not as a failure.
- Receipt ids are ULIDs generated from Node crypto; ring order remains insertion order rather than being
  re-derived from the token.

## Get right

- **A revert never carries content.** Its params carry a scope, spans and hashes; every byte written comes
  from this module's own reads. That is what keeps a stale tab from clobbering the agent's work, and it
  is why the expectation hashes are mandatory rather than advisory. A whole-file save is the exception in
  the other direction, and the smaller promise: the pane owns its unsaved buffer, so it sends the complete
  content and last writer wins.
- **A failed original read is never absence.** `git.readBlobBytesAtAsync` returns `null` only for Git's
  explicit path-absent diagnostic and throws every other failure, matching `git.diffFile`. That
  distinction is load-bearing because an absent original is exactly the input that makes a whole-file
  revert trash the worktree file.
- **Serialization is the host's job** (`withChangeLock`, a chain per workspace, separate from the review
  lock — see [[submodule-server-host]]), and every worktree mutation this module exports — revert, undo, and
  the file/folder passes — is routed through it, so a save cannot slip between a revert's verify and its
  trash call. This module assumes it is not re-entered for one workspace; it
  does not assume the agent is idle.
