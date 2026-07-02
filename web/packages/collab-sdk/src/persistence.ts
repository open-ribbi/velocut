// persistence.ts — local-first storage primitives.
//
// Media bytes go to OPFS (Origin Private File System): real disk-backed
// files with random access, no quota anxiety for editing-sized assets, and
// File handles that plug straight into the media worker's lazy byte-range
// reader. Documents (Yjs updates) go to IndexedDB.

/** Save an imported media file into OPFS; returns the `opfs://` src. */
export async function saveMedia(file: File): Promise<string> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('media', { create: true });
  const handle = await dir.getFileHandle(file.name, { create: true });
  const writable = await handle.createWritable();
  await file.stream().pipeTo(writable);
  return `opfs://${file.name}`;
}

/** Resolve an `opfs://` src back to a File (disk handle, zero RAM). */
export async function loadMedia(src: string): Promise<File | null> {
  if (!src.startsWith('opfs://')) return null;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('media');
    const handle = await dir.getFileHandle(src.slice('opfs://'.length));
    return await handle.getFile();
  } catch {
    return null;
  }
}

// ------------------------------------------------------------- fonts

export interface FontRecord {
  family: string;
  file: string;
}

/** Persist a font file to OPFS and record family→file in the kv index. */
export async function saveFont(family: string, file: File): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle('fonts', { create: true });
  const handle = await dir.getFileHandle(file.name, { create: true });
  const writable = await handle.createWritable();
  await file.stream().pipeTo(writable);
  const list = await listFonts();
  if (!list.some((r) => r.family === family)) {
    list.push({ family, file: file.name });
    await kvPut('fonts', new TextEncoder().encode(JSON.stringify(list)));
  }
}

export async function listFonts(): Promise<FontRecord[]> {
  const raw = await kvGet('fonts');
  if (!raw) return [];
  try {
    return JSON.parse(new TextDecoder().decode(raw)) as FontRecord[];
  } catch {
    return [];
  }
}

export async function loadFontData(fileName: string): Promise<ArrayBuffer | null> {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('fonts');
    const handle = await dir.getFileHandle(fileName);
    return await (await handle.getFile()).arrayBuffer();
  } catch {
    return null;
  }
}

// ------------------------------------------------------- IndexedDB (kv)

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('velocut', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function kvGet(key: string): Promise<Uint8Array | null> {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('kv').objectStore('kv').get(key);
      req.onsuccess = () => resolve((req.result as Uint8Array | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function kvPut(key: string, value: Uint8Array): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
