import { createHash } from "node:crypto";
import path from "node:path";
import type { SavedConversationOccurrence, SavedConversations, SavedConversationSave, SubagentRunView } from "./types.js";

const MAX_OCCURRENCES = 1_024;
const MAX_STRING_BYTES = 4 * 1_024;

interface NestedDeclaration {
  items: SavedConversationOccurrence[];
  coverage: SavedConversations["coverage"];
}

interface NestedSource extends NestedDeclaration {
  conflicted: boolean;
  conflictIds: Map<string, string>;
  nextConflictId: number;
}

export interface SavedConversationCollection {
  root: string;
  direct: SavedConversationOccurrence;
  sources: Map<number, NestedSource>;
  activeSources: Map<string, number>;
  nextSlot: number;
  order: Map<string, number>;
  nextOrder: number;
  scope: string;
  overflow: boolean;
}

export function createSavedConversationCollection(root: string, direct: SavedConversationOccurrence): SavedConversationCollection {
  return {
    root, direct: structuredClone(direct), sources: new Map(), activeSources: new Map(), nextSlot: 0,
    order: new Map([[direct.id, 0]]), nextOrder: 1,
    scope: createHash("sha256").update(direct.id).digest("hex"), overflow: false,
  };
}

export function startSavedConversationSource(collection: SavedConversationCollection, toolCallId: string): number | undefined {
  const active = collection.activeSources.get(toolCallId);
  if (active !== undefined) return active;
  if (collection.sources.size >= MAX_OCCURRENCES) {
    collection.overflow = true;
    return undefined;
  }
  const slot = collection.nextSlot++;
  collection.sources.set(slot, { items: [], coverage: "observed", conflicted: false, conflictIds: new Map(), nextConflictId: 0 });
  collection.activeSources.set(toolCallId, slot);
  return slot;
}

export function replaceSavedConversationSource(
  collection: SavedConversationCollection,
  toolCallId: string,
  result: unknown,
  terminal: boolean,
): boolean {
  const wasOverflow = collection.overflow;
  const slot = startSavedConversationSource(collection, toolCallId);
  if (slot === undefined) return !wasOverflow;
  const details = isObject(result) && isObject(result.details) ? result.details : undefined;
  if (!terminal && (!details || !Object.hasOwn(details, "savedConversations"))) return false;
  const previous = collection.sources.get(slot)!;
  const declaration = parseSource(collection, slot, details?.savedConversations);
  const occupied = new Set([collection.direct.id]);
  for (const [otherSlot, source] of collection.sources) {
    if (otherSlot !== slot) for (const item of source.items) occupied.add(item.id);
  }
  const conflicted = previous.conflicted || declaration.items.some((item) => occupied.has(item.id));
  const conflictIds = new Map<string, string>();
  let nextConflictId = previous.nextConflictId;
  if (conflicted) {
    for (const item of declaration.items) {
      let id = previous.conflictIds.get(item.id);
      while (id === undefined || occupied.has(id)) id = `conflict:${collection.scope}:${slot}:${nextConflictId++}`;
      conflictIds.set(item.id, id);
      occupied.add(id);
    }
  }
  const previousIds = new Set(previous.items.map((item) => item.id));
  const items = declaration.items.map((item) => {
    const id = conflictIds.get(item.id) ?? item.id;
    const previousId = previous.conflictIds.get(item.id) ?? item.id;
    const order = previousIds.has(previousId) ? collection.order.get(previousId) : undefined;
    collection.order.set(id, order ?? collection.nextOrder++);
    return {
      ...item,
      id,
      parentId: item.parentId === null ? collection.direct.id : conflictIds.get(item.parentId) ?? item.parentId,
    };
  });
  collection.sources.set(slot, {
    items, coverage: conflicted ? "partial" : declaration.coverage, conflicted, conflictIds, nextConflictId,
  });
  if (terminal) collection.activeSources.delete(toolCallId);
  const currentIds = new Set([collection.direct.id, ...[...collection.sources.values()].flatMap((source) => source.items.map((item) => item.id))]);
  for (const id of collection.order.keys()) if (!currentIds.has(id)) collection.order.delete(id);
  return true;
}

export function savedConversationSnapshot(collection: SavedConversationCollection, terminal: boolean, run?: SubagentRunView): SavedConversations {
  const sources = [...collection.sources.values()];
  const direct = { ...collection.direct };
  if (run) {
    if (safeReferenceText(run.title)) direct.title = run.title;
    else delete direct.title;
    const stats = { turns: run.turnCount, contextPercent: run.contextUsage?.percent ?? null };
    direct.stats = { turns: run.turnCount, contextPercent: isStats(stats) ? stats.contextPercent : null };
  }
  const items = [direct, ...sources.flatMap((source) => source.items)]
    .sort((a, b) => collection.order.get(a.id)! - collection.order.get(b.id)!);
  const partial = collection.overflow || items.length > MAX_OCCURRENCES || sources.some((source) => source.coverage === "partial"
    || (terminal && source.coverage !== "complete"));
  return {
    version: 2,
    root: collection.root,
    coverage: partial ? "partial" : terminal ? "complete" : "observed",
    items: structuredClone(selectOccurrences(items, collection.direct.id)),
  };
}

function selectOccurrences(items: SavedConversationOccurrence[], directId: string): SavedConversationOccurrence[] {
  if (items.length <= MAX_OCCURRENCES) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const selected = new Set([directId]);
  for (const item of items) {
    const ancestors: string[] = [];
    let ancestor: SavedConversationOccurrence | undefined = item;
    while (ancestor && !selected.has(ancestor.id)) {
      ancestors.push(ancestor.id);
      ancestor = ancestor.parentId === null ? undefined : byId.get(ancestor.parentId);
    }
    if (ancestor && selected.size + ancestors.length <= MAX_OCCURRENCES) {
      for (const id of ancestors) selected.add(id);
    }
  }
  return items.filter((item) => selected.has(item.id));
}

function parseSource(collection: SavedConversationCollection, slot: number, value: unknown): NestedDeclaration {
  const invalid: NestedDeclaration = { items: [], coverage: "partial" };
  if (!isObject(value) || !safeReferenceText(value.root) || value.root !== collection.root || !Array.isArray(value.items)
    || value.items.length === 0 || value.items.length > MAX_OCCURRENCES) return invalid;
  const items: unknown[] = Array.from(value.items);
  if (value.version === 1) {
    if (!items.every(isLegacyItem)) return invalid;
    return {
      coverage: "partial",
      items: items.map((item, index) => ({
        id: `legacy:${collection.scope}:${slot}:${index}`,
        parentId: null,
        kind: "unknown",
        sessionId: item.sessionId,
        ...(item.label === undefined ? {} : { label: item.label }),
        save: { kind: "pi-v3", file: item.file, readiness: "planned" },
      })),
    };
  }
  if (value.version !== 2 || (value.coverage !== "observed" && value.coverage !== "complete" && value.coverage !== "partial")
    || !items.every(isOccurrence) || !validAncestry(items)) return invalid;
  return {
    coverage: value.coverage,
    items: items.map((item) => ({
      id: item.id,
      parentId: item.parentId,
      kind: item.kind,
      sessionId: item.sessionId,
      ...(item.label === undefined ? {} : { label: item.label }),
      ...(item.title === undefined ? {} : { title: item.title }),
      ...(item.stats === undefined ? {} : { stats: { turns: item.stats.turns, contextPercent: item.stats.contextPercent } }),
      save: item.save.kind === "pi-v3"
        ? { kind: "pi-v3", file: item.save.file, readiness: item.save.readiness }
        : { kind: "unavailable", reason: item.save.reason },
    })),
  };
}

function validAncestry(items: SavedConversationOccurrence[]): boolean {
  const byId = new Map(items.map((item) => [item.id, item]));
  if (byId.size !== items.length || items.filter((item) => item.parentId === null).length !== 1) return false;
  for (const item of items) {
    const seen = new Set([item.id]);
    let parent = item.parentId;
    while (parent !== null) {
      if (seen.has(parent)) return false;
      seen.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) return false;
      parent = ancestor.parentId;
    }
  }
  return true;
}

function isOccurrence(value: unknown): value is SavedConversationOccurrence {
  return isObject(value) && safeReferenceText(value.id)
    && (value.parentId === null || safeReferenceText(value.parentId))
    && (value.kind === "start" || value.kind === "resume" || value.kind === "unknown")
    && safeReferenceText(value.sessionId) && (value.label === undefined || safeReferenceText(value.label))
    && (value.title === undefined || safeReferenceText(value.title))
    && (value.stats === undefined || isStats(value.stats))
    && isSave(value.save);
}

function isStats(value: unknown): value is NonNullable<SavedConversationOccurrence["stats"]> {
  return isObject(value) && typeof value.turns === "number" && Number.isInteger(value.turns) && value.turns >= 0 && value.turns <= 1_000_000
    && (value.contextPercent === null || (typeof value.contextPercent === "number" && value.contextPercent >= 0 && value.contextPercent <= 100));
}

function isSave(value: unknown): value is SavedConversationSave {
  return isObject(value) && (value.kind === "unavailable" ? safeReferenceText(value.reason)
    : value.kind === "pi-v3" && safeRelativeFile(value.file) && (value.readiness === "planned" || value.readiness === "checked"));
}

function isLegacyItem(value: unknown): value is { sessionId: string; file: string; label?: string } {
  return isObject(value) && safeReferenceText(value.sessionId) && safeRelativeFile(value.file)
    && (value.label === undefined || safeReferenceText(value.label));
}

function safeRelativeFile(value: unknown): value is string {
  return safeReferenceText(value) && !path.isAbsolute(value) && !value.startsWith("~") && !value.includes("\\")
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function safeReferenceText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= MAX_STRING_BYTES
    && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
