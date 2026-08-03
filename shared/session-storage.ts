// IndexedDB persistence for partial receiver fountain streams.
// Keyed by sessionId (string). Stores received sequence frame data to allow
// seamless resumption across page reloads, tab switches, or signal drops.

export interface SavedSessionRecord {
  sessionId: number;
  identityKey: string;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
  frames: { seq: number; data: number[] }[];
  updatedAt: number;
}

const DB_NAME = "lumix_resume_db";
const DB_VERSION = 1;
const STORE_NAME = "partial_sessions";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "identityKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function savePartialSession(record: SavedSessionRecord): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(record);
  } catch {
    // Fail silently on quota or storage restriction
  }
}

export async function loadPartialSession(identityKey: string): Promise<SavedSessionRecord | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(identityKey);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function clearPartialSession(identityKey: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(identityKey);
  } catch {
    // Ignore
  }
}
