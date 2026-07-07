// services/projects.ts — the multi-project registry and per-project storage
// scoping. A "project" is one document world: its Yjs persistence, branching
// history, OPFS media files, pcm/proxy caches, and motion specs.
//
// Scoping rule: the pre-multi-project data keeps its legacy unscoped keys and
// becomes the reserved project id "default" — adoption costs zero data moves.
// Every other project prefixes/suffixes its id into keys and directory names.
//
// Switching projects is a localStorage write + full reload: the app is a
// stateful singleton graph (WASM engine, decode worker, WebGPU device), and a
// reload is the one transition that rebuilds all of it consistently.

import { kvGet, kvPut, kvDelete, kvKeys, removeOpfsDir } from '@velocut/collab-sdk';

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

const REGISTRY_KEY = 'projects';
const ACTIVE_KEY = 'velocut.project';
const DEFAULT_ID = 'default';

export interface ProjectStorage {
  ydoc: string;
  history: string;
  motionPrefix: string;
  mediaDir: string;
  /** MediaLibrary's pcm/proxy cache scope; undefined = legacy unscoped dirs. */
  mediaScope: string | undefined;
  room: string;
}

export function storageKeys(id: string): ProjectStorage {
  const scoped = id !== DEFAULT_ID;
  return {
    ydoc: scoped ? `ydoc:${id}` : 'ydoc',
    history: scoped ? `history:${id}` : 'history',
    motionPrefix: scoped ? `motion:${id}:` : 'motion:',
    mediaDir: scoped ? `media-${id}` : 'media',
    mediaScope: scoped ? id : undefined,
    room: `velocut-${id}`,
  };
}

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (raw: Uint8Array) => JSON.parse(new TextDecoder().decode(raw)) as unknown;

async function readRegistry(): Promise<ProjectMeta[]> {
  try {
    const raw = await kvGet(REGISTRY_KEY);
    if (!raw) return [];
    const list = dec(raw);
    return Array.isArray(list) ? (list as ProjectMeta[]) : [];
  } catch {
    return [];
  }
}

const writeRegistry = (list: ProjectMeta[]) => kvPut(REGISTRY_KEY, enc(list));

let active: ProjectMeta | null = null;

/** Resolve (and if needed seed) the registry, pick the active project. Called
 *  once at bootstrap, before any storage key is derived. */
export async function ensureActiveProject(): Promise<ProjectMeta> {
  let list = await readRegistry();
  if (list.length === 0) {
    // First run under multi-project: adopt whatever data exists under the
    // legacy unscoped keys as the "default" project (even a blank slate —
    // the empty document that bootstraps IS that project's document).
    const now = Date.now();
    list = [{ id: DEFAULT_ID, name: 'My Project', createdAt: now, updatedAt: now }];
    await writeRegistry(list);
  }
  const wanted = localStorage.getItem(ACTIVE_KEY);
  active = list.find((p) => p.id === wanted) ?? list[0];
  localStorage.setItem(ACTIVE_KEY, active.id);
  return active;
}

/** The project this session runs in (set by ensureActiveProject at bootstrap). */
export function activeProject(): ProjectMeta {
  if (!active) throw new Error('projects: ensureActiveProject() has not run yet');
  return active;
}

export function activeStorage(): ProjectStorage {
  return storageKeys(activeProject().id);
}

/** kv key for a motion spec in the ACTIVE project. */
export function motionKey(assetId: string): string {
  return activeStorage().motionPrefix + assetId;
}

export const listProjects = readRegistry;

export async function createProject(name: string): Promise<ProjectMeta> {
  const list = await readRegistry();
  const now = Date.now();
  const id = 'p' + now.toString(36) + Math.random().toString(36).slice(2, 6);
  const meta: ProjectMeta = { id, name: name.trim() || 'Untitled', createdAt: now, updatedAt: now };
  list.push(meta);
  await writeRegistry(list);
  return meta;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const list = await readRegistry();
  const p = list.find((x) => x.id === id);
  if (!p) return;
  p.name = name.trim() || p.name;
  p.updatedAt = Date.now();
  await writeRegistry(list);
  if (active?.id === id) active = p;
}

let flushBeforeSwitch: (() => Promise<void>) | null = null;

/** Bootstrap registers the persistence flush here so switching projects can
 *  deterministically land pending debounced writes before the reload. */
export function registerFlushBeforeSwitch(fn: () => Promise<void>): void {
  flushBeforeSwitch = fn;
}

/** Switch the active project and rebuild the app around it. */
export async function openProject(id: string): Promise<void> {
  try {
    await flushBeforeSwitch?.();
  } catch {
    /* a failed flush must not strand the user in the old project */
  }
  localStorage.setItem(ACTIVE_KEY, id);
  location.reload();
}

/** Delete a project and all of its storage. Deleting the active project
 *  re-targets the ACTIVE pointer at a survivor; the caller reloads. */
export async function deleteProject(id: string): Promise<void> {
  const keys = storageKeys(id);
  await kvDelete(keys.ydoc);
  await kvDelete(keys.history);
  for (const k of await kvKeys(keys.motionPrefix)) {
    // The legacy prefix "motion:" also matches scoped keys "motion:<pid>:…" —
    // a default-project wipe must only take the two-segment legacy keys.
    if (id === DEFAULT_ID && k.split(':').length !== 2) continue;
    await kvDelete(k);
  }
  await removeOpfsDir(keys.mediaDir);
  await removeOpfsDir(keys.mediaScope ? `pcm-${keys.mediaScope}` : 'pcm');
  await removeOpfsDir(keys.mediaScope ? `proxy-${keys.mediaScope}` : 'proxy');

  const list = (await readRegistry()).filter((p) => p.id !== id);
  await writeRegistry(list);
  if (localStorage.getItem(ACTIVE_KEY) === id) {
    if (list[0]) localStorage.setItem(ACTIVE_KEY, list[0].id);
    else localStorage.removeItem(ACTIVE_KEY);
  }
}
