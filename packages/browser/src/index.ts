/* eslint-disable @typescript-eslint/no-explicit-any */
// packages/browser/src/index.ts

import { createProvider } from 'computesdk';
import type {
  ExecutionResult,
  SandboxInfo,
  Runtime,
  CreateSandboxOptions,
  FileEntry,
  ProviderConfig,
} from 'computesdk';

import { browserFs } from './filesystem/filesystem';

// -----------------------------------------
// Browser Provider (Pyodide runtime)
// -----------------------------------------

/**
 * Optional config for the Browser provider.
 * You can extend this later (e.g., add Node/WebContainers, WASI, env vars, etc.)
 */
export interface BrowserConfig {
  /** Default runtime (currently only 'python' is supported) */
  runtime?: Extract<Runtime, 'python'>;
  /** Optional Pyodide base URL (ending with /), e.g. 'https://cdn.jsdelivr.net/pyodide/v0.29.0/' */
  pyodideIndexURL?: string;
}

/** We currently only support Python via Pyodide */
type SupportedRuntime = Extract<Runtime, 'python'>;

/** In-memory sandbox handle kept by the provider */
interface BrowserSandbox {
  id: string;
  runtime: SupportedRuntime;
  worker: Worker; // classic worker using importScripts inside
}

/** Registry of active sandboxes (in-memory) */
const registry = new Map<string, BrowserSandbox>();

/** Spawn a Pyodide worker (classic worker so importScripts works) */
function spawnPythonWorker(): Worker {
  return new Worker(new URL('./workers/python.worker.ts', import.meta.url), { type: 'classic' });
}

/** Tiny RPC helper with correlation id */
function callWorker<TReq extends Record<string, any>, TRes = any>(
  worker: Worker,
  msg: TReq
): Promise<TRes> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const onMsg = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      worker.removeEventListener('message', onMsg);
      resolve(e.data as TRes);
    };
    worker.addEventListener('message', onMsg);
    worker.postMessage({ id, ...msg });
  });
}

/** Normalize ExecutionResult from worker response */
function toExecutionResult(res: {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}): ExecutionResult {
  return {
    exitCode: typeof res.exitCode === 'number' ? res.exitCode : res.ok ? 0 : 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? (res.ok ? '' : (res.error ?? '')),
  };
}

/**
 * Create the Browser provider using the factory pattern,
 * matching the style of your Cloudflare provider.
 */
export const browser = createProvider<BrowserSandbox, BrowserConfig>({
  name: 'browser',
  methods: {
    sandbox: {
      // ------------------------------
      // Collection operations
      // ------------------------------
      create: async (config: BrowserConfig = {}, options?: CreateSandboxOptions) => {
        const desired: SupportedRuntime = (options?.runtime as SupportedRuntime) ?? (config.runtime ?? 'python');
        if (desired !== 'python') {
          throw new Error(`Unsupported runtime "${desired}" for browser provider. Only "python" is available.`);
        }

        const worker = spawnPythonWorker();
        const sandboxId = options?.sandboxId ?? `browser-sb-${crypto.randomUUID()}`;

        // Initialize Pyodide (optionally pass a custom indexURL)
        await callWorker(worker, { type: 'init', indexURL: config.pyodideIndexURL });

        const sandbox: BrowserSandbox = { id: sandboxId, runtime: 'python', worker };
        registry.set(sandboxId, sandbox);

        return { sandbox, sandboxId };
      },

      getById: async (_config: BrowserConfig, sandboxId: string) => {
        const sb = registry.get(sandboxId);
        return sb ? { sandbox: sb, sandboxId } : null;
      },

      list: async (_config: BrowserConfig) => {
        const out: Array<{ sandbox: BrowserSandbox; sandboxId: string }> = [];
        for (const [sandboxId, sandbox] of registry.entries()) {
          out.push({ sandbox, sandboxId });
        }
        return out;
      },

      destroy: async (_config: BrowserConfig, sandboxId: string) => {
        const sb = registry.get(sandboxId);
        if (sb) {
          try {
            sb.worker.terminate();
          } finally {
            registry.delete(sandboxId);
          }
        }
      },

      // ------------------------------
      // Instance operations
      // ------------------------------
      runCode: async (sandbox: BrowserSandbox, code: string, _runtime?: Runtime): Promise<ExecutionResult> => {
        if (sandbox.runtime !== 'python') {
          return { exitCode: 127, stdout: '', stderr: `Unsupported runtime "${sandbox.runtime}" in browser provider` };
        }
        const res = await callWorker(sandbox.worker, { type: 'runCode', code }) as {
          ok: boolean; exitCode?: number; stdout?: string; stderr?: string; error?: string;
        };
        return toExecutionResult(res);
      },

      runCommand: async (_sandbox: BrowserSandbox, command: string, _args: string[] = []): Promise<ExecutionResult> => {
        // No shell in the browser — keep a predictable contract
        return { exitCode: 127, stdout: '', stderr: `runCommand("${command}") is not supported in the browser provider` };
      },

      getInfo: async (sandbox: BrowserSandbox): Promise<SandboxInfo> => {
        // Keep minimal, align with your SandboxInfo shape
        const info: Partial<SandboxInfo> = {
          id: sandbox.id as any,
          provider: 'browser' as any,
          runtime: sandbox.runtime as any,
          status: 'running' as any,
        };
        return info as SandboxInfo;
      },

      getUrl: async (_sandbox: BrowserSandbox, _opts: { port: number; protocol?: string }): Promise<string> => {
        // Pyodide doesn't expose a server port by default.
        return '';
      },

      // ------------------------------
      // Filesystem facade (OPFS via opfs-worker)
      // ------------------------------
      filesystem: {
        // All FS calls delegate to your shared OPFS adapter
        readFile: async (_sb: BrowserSandbox, path: string): Promise<string> => {
          return browserFs.readFile(undefined, path);
        },

        writeFile: async (_sb: BrowserSandbox, path: string, content: string): Promise<void> => {
          await browserFs.writeFile(undefined, path, content);
        },

        mkdir: async (_sb: BrowserSandbox, path: string): Promise<void> => {
          await browserFs.mkdir(undefined, path);
        },

        readdir: async (_sb: BrowserSandbox, path: string): Promise<FileEntry[]> => {
          return browserFs.readdir(undefined, path);
        },

        exists: async (_sb: BrowserSandbox, path: string): Promise<boolean> => {
          return browserFs.exists(undefined, path);
        },

        remove: async (_sb: BrowserSandbox, path: string): Promise<void> => {
          await browserFs.remove(undefined, path);
        },
      },
    },
  },
} as ProviderConfig<BrowserSandbox, BrowserConfig>);
