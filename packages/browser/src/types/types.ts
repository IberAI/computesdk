export type FileEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  lastModified: Date;
};

/** Subset of the opfs-worker API we consume. */
export type OPFSService = {
  readFile(path: string, encoding?: 'utf8' | 'binary'): string | Uint8Array | Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): void | Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): void | Promise<void>;
  readDir(
    path: string
  ): Array<{ name: string; path: string; isFile?: boolean; isDirectory?: boolean; size?: number; mtime?: number }>
    | Promise<Array<{ name: string; path: string; isFile?: boolean; isDirectory?: boolean; size?: number; mtime?: number }>>;
  stat(
    path: string
  ): { size?: number; mtime?: number; isFile?: boolean; isDirectory?: boolean }
    | Promise<{ size?: number; mtime?: number; isFile?: boolean; isDirectory?: boolean }>;
  remove(path: string, opts?: { recursive?: boolean }): void | Promise<void>;
  watch(path: string, opts?: { recursive?: boolean; include?: string[] }): void | Promise<void>;
};


