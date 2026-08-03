// Transfer history module: stores transfer metadata locally in localStorage.
// Transient by design — only file metadata (name, size, type, direction, timestamp, status)
// is stored, never actual file contents.

export interface TransferHistoryEntry {
  id: string;
  name: string;
  size: number;
  type: string;
  direction: "sent" | "received";
  timestamp: number;
  status: "completed" | "failed";
  goodputKbs?: number;
}

const STORAGE_KEY = "lumix_transfer_history";
const MAX_ENTRIES = 50;

export function getTransferHistory(): TransferHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TransferHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordTransferEntry(entry: Omit<TransferHistoryEntry, "id" | "timestamp">): void {
  try {
    const history = getTransferHistory();
    const newEntry: TransferHistoryEntry = {
      ...entry,
      id: Math.random().toString(36).substring(2, 9),
      timestamp: Date.now(),
    };
    // Prepend new item, keep up to MAX_ENTRIES
    const updated = [newEntry, ...history].slice(0, MAX_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // Ignore storage quota errors or disabled localStorage
  }
}

export function clearTransferHistory(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}
