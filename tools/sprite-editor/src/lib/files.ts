// Reading and writing sprite files on the real disk.
//
// The File System Access API, with a download/upload fallback. Picking the
// repo's sprites folder once turns Save into an actual write to the file the
// scene imports — the whole point of the tool is a loop where you draw, save,
// and the visualiser next to you is already showing it. Browsers without the
// API (Firefox, Safari) get a working editor whose Save is a download.
import { fromJson, type SpriteFile, toJson } from "@scene/player/sprite-file";

import { forgetFolder, recallFolder, rememberFolder } from "./persist";

/** Minimal shapes of the File System Access API, which TS's DOM lib omits. */
type FileHandle = {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};
type DirHandle = {
  name: string;
  values(): AsyncIterable<FileHandle & { kind: "file" | "directory" }>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  removeEntry?(name: string): Promise<void>;
  queryPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
};
type Picker = {
  showDirectoryPicker?: (opts?: { mode?: "read" | "readwrite" }) => Promise<DirHandle>;
  showOpenFilePicker?: (opts?: unknown) => Promise<FileHandle[]>;
  showSaveFilePicker?: (opts?: unknown) => Promise<FileHandle>;
};

const picker = (): Picker => window as unknown as Picker;

export const canWriteToDisk = (): boolean => typeof picker().showDirectoryPicker === "function";

export type Folder = { handle: DirHandle; name: string };

/** Ask for a folder — repo/packages/player/src/sprites, normally. Remembered,
 *  so this is asked once and not once per reload. */
export async function pickFolder(): Promise<Folder | null> {
  const show = picker().showDirectoryPicker;
  if (!show) return null;
  const handle = await show({ mode: "readwrite" });
  await rememberFolder(handle);
  return { handle, name: handle.name };
}

/** The folder from a previous session, if the browser kept the handle. */
export async function restoreFolder(): Promise<Folder | null> {
  const handle = await recallFolder<DirHandle>();
  return handle ? { handle, name: handle.name } : null;
}

export const dropFolder = (): Promise<unknown> => forgetFolder();

/** Is the folder already writable, without asking? Chrome can keep the grant
 *  across reloads; when it hasn't, `requestPermission` needs a user gesture,
 *  which is why this is separate from ensureWritable. */
export async function isWritable(folder: Folder): Promise<boolean> {
  return (await folder.handle.queryPermission?.({ mode: "readwrite" })) === "granted";
}

/** Re-ask for write permission. Must be called from a user gesture. */
export async function ensureWritable(folder: Folder): Promise<boolean> {
  if (await isWritable(folder)) return true;
  const r = await folder.handle.requestPermission?.({ mode: "readwrite" });
  return r === "granted";
}

export type Entry = { file: string; sprite: SpriteFile };
export type LoadResult = { entries: Entry[]; problems: { file: string; errors: string[] }[] };

/** Every *.json in the folder that parses as a sprite, plus what didn't. */
export async function listSprites(folder: Folder): Promise<LoadResult> {
  const entries: Entry[] = [];
  const problems: { file: string; errors: string[] }[] = [];
  for await (const handle of folder.handle.values()) {
    if (handle.kind !== "file" || !handle.name.endsWith(".json")) continue;
    const text = await (await handle.getFile()).text();
    const parsed = fromJson(text);
    if ("errors" in parsed) problems.push({ file: handle.name, errors: parsed.errors });
    else entries.push({ file: handle.name, sprite: parsed.sprite });
  }
  entries.sort((a, b) => a.file.localeCompare(b.file));
  return { entries, problems };
}

/** Write straight into the folder, under the name the sprite carries. */
export async function saveToFolder(folder: Folder, sprite: SpriteFile): Promise<string> {
  const file = `${sprite.name}.json`;
  const handle = await folder.handle.getFileHandle(file, { create: true });
  const w = await handle.createWritable();
  await w.write(toJson(sprite));
  await w.close();
  return file;
}

/**
 * Save, and move rather than copy when the sprite has been renamed.
 *
 * A rename that leaves the old file behind is not a rename — you end up with
 * two sprites, the scene still importing the stale one, and no way to tell from
 * the folder which is current. The new file is written FIRST and the old one
 * removed only once that succeeded, so a failure loses nothing.
 */
export async function saveSprite(
  folder: Folder,
  sprite: SpriteFile,
  previousFile: string | null,
): Promise<{ file: string; removed: string | null }> {
  const file = await saveToFolder(folder, sprite);
  if (!previousFile || previousFile === file) return { file, removed: null };
  try {
    await folder.handle.removeEntry?.(previousFile);
    return { file, removed: previousFile };
  } catch {
    // Not fatal: the save landed. The stale file is reported so the status line
    // can say it is still there rather than claiming a clean rename.
    return { file, removed: null };
  }
}

// ---------- fallbacks, for browsers without the API ----------

export function downloadSprite(sprite: SpriteFile): void {
  const blob = new Blob([toJson(sprite)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${sprite.name}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function readDroppedFiles(files: FileList | File[]): Promise<LoadResult> {
  const entries: Entry[] = [];
  const problems: { file: string; errors: string[] }[] = [];
  for (const f of Array.from(files)) {
    if (!f.name.endsWith(".json")) continue;
    const parsed = fromJson(await f.text());
    if ("errors" in parsed) problems.push({ file: f.name, errors: parsed.errors });
    else entries.push({ file: f.name, sprite: parsed.sprite });
  }
  return { entries, problems };
}
