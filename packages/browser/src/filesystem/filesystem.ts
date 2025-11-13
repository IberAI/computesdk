import { createWorker } from 'opfs-worker';
import type { OPFSService, FileEntry } from '../types/types';
/** Minimal entry type used by your provider. */
const ROOT = '/workspace';
const NAMESPACE = 'compute-sdk:fs';

const normalizePath = (p: string): string => (p && p.startsWith('/') ? p : `/${p || ''}`);

const toFileEntry = (d: any): FileEntry => ({
  name: String(d?.name ?? ''),
  path: String(d?.path ?? normalizePath(d?.name ?? '')),
  isDirectory: Boolean(d?.isDirectory ?? (!d?.isFile && d?.kind === 'directory')),
  size: Number(d?.size ?? 0),
  lastModified: new Date(Number(d?.mtime ?? Date.now())),
});

function toUtf8String(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

/** Synchronous singleton (createWorker returns an object, not a Promise). */
let __fs: OPFSService | null = null;
function getFS(): OPFSService {
  if (!__fs) {
    __fs = createWorker({ root: ROOT, namespace: NAMESPACE }) as unknown as OPFSService;
  }
  return __fs;
}

/** Binary helpers for runtimes */
export async function readFileBytes(path: string): Promise<Uint8Array> {
  const fs = getFS();
  const res = await Promise.resolve(fs.readFile(normalizePath(path), 'binary'));
  return res instanceof Uint8Array ? res : new Uint8Array();
}

export async function writeFileBytes(path: string, data: ArrayBufferView | ArrayBuffer): Promise<void> {
  const fs = getFS();
  const u8 =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  await Promise.resolve(fs.writeFile(normalizePath(path), u8));
}

/** Adapter matching SandboxMethods['filesystem'] */
export const browserFs = {
  async readFile(_sb: unknown, path: string): Promise<string> {
    const fs = getFS();
    const out = await Promise.resolve(fs.readFile(normalizePath(path), 'utf8'));
    return toUtf8String(out);
  },

  async writeFile(_sb: unknown, path: string, content: string): Promise<void> {
    const fs = getFS();
    await Promise.resolve(fs.writeFile(normalizePath(path), content));
  },

  async mkdir(_sb: unknown, path: string): Promise<void> {
    const fs = getFS();
    await Promise.resolve(fs.mkdir(normalizePath(path), { recursive: true }));
  },

  async readdir(_sb: unknown, path: string): Promise<FileEntry[]> {
    const fs = getFS();
    const items = await Promise.resolve(fs.readDir(normalizePath(path)));
    return items.map(toFileEntry);
  },

  async exists(_sb: unknown, path: string): Promise<boolean> {
    const fs = getFS();
    try {
      await Promise.resolve(fs.stat(normalizePath(path)));
      return true;
    } catch {
      return false;
    }
  },

  async remove(_sb: unknown, path: string): Promise<void> {
    const fs = getFS();
    await Promise.resolve(fs.remove(normalizePath(path), { recursive: true }));
  },
};

/** Optional: watch for changes; returns an unsubscribe function. */
export async function watchFS(
  path = '/',
  onChange?: (evt: { event: 'create' | 'modify' | 'remove' | 'rename'; path?: string; from?: string; to?: string }) => void
): Promise<() => void> {
  const fs = getFS();
  const maybe = fs.watch(normalizePath(path), { recursive: true });
  if (maybe && typeof (maybe as Promise<void>).then === 'function') {
    await (maybe as Promise<void>);
  }

  const bc = new BroadcastChannel(NAMESPACE);
  const handler = (e: MessageEvent) => {
    const msg = e.data;
    if (!msg || !onChange) return;

    if (msg.type === 'rename' && msg.from && msg.to) {
      onChange({ event: 'rename', from: msg.from, to: msg.to });
    } else if ((msg.type === 'create' || msg.type === 'modify') && msg.path) {
      onChange({ event: msg.type, path: msg.path });
    } else if (msg.type === 'remove' && msg.path) {
      onChange({ event: 'remove', path: msg.path });
    }
  };
  bc.addEventListener('message', handler);

  return () => {
    bc.removeEventListener('message', handler);
    bc.close();
  };
}
