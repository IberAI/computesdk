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
// Browser Provider (Python via Pyodide)
// -----------------------------------------

export interface BrowserConfig {
  runtime?: Extract<Runtime, 'python'>;
  pyodideIndexURL?: string;
}

type SupportedRuntime = Extract<Runtime, 'python'>;

interface BrowserSandbox {
  id: string;
  runtime: SupportedRuntime;
  worker: Worker;
}

const registry = new Map<string, BrowserSandbox>();

/**
 * Spawn Python worker WITHOUT using import.meta.url
 * Works in tsup, webpack, vite without tsconfig changes.
 */
function spawnPythonWorker(): Worker {
  return new Worker('./workers/python.worker.js', {
    type: 'classic',
  });
}

/** RPC helper */
function callWorker(worker: Worker, msg: any): Promise<any> {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();

    const listener = (e: MessageEvent) => {
      if (e.data?.id !== id) return;
      worker.removeEventListener('message', listener);
      resolve(e.data);
    };

    worker.addEventListener('message', listener);
    worker.postMessage({ id, ...msg });
  });
}

/** Build a correct ExecutionResult */
function makeExecutionResult(
  sandboxId: string,
  response: {
    ok: boolean;
    exitCode?: number;
    stdout?: string;
    stderr?: string;
    error?: string;
  }
): ExecutionResult {
  return {
    exitCode:
      typeof response.exitCode === 'number'
        ? response.exitCode
        : response.ok
          ? 0
          : 1,
    stdout: response.stdout ?? '',
    stderr: response.stderr ?? (response.ok ? '' : response.error ?? ''),
    sandboxId,
    provider: '@computesdk/browser',
    executionTime: 0,
  };
}

// ========================================================
// Internal provider using createProvider
// ========================================================
const internalProvider = createProvider<BrowserSandbox, BrowserConfig>({
  name: 'browser',

  methods: {
    sandbox: {
      /** Create Pyodide sandbox */
      create: async (
        config: BrowserConfig = {},
        options?: CreateSandboxOptions
      ) => {
        const runtime: SupportedRuntime =
          (options?.runtime as SupportedRuntime) ?? config.runtime ?? 'python';

        if (runtime !== 'python') {
          throw new Error(
            `Unsupported runtime "${runtime}". Only "python" is supported.`
          );
        }

        const worker = spawnPythonWorker();
        const sandboxId =
          options?.sandboxId ?? `browser-sb-${crypto.randomUUID()}`;

        await callWorker(worker, {
          type: 'init',
          indexURL: config.pyodideIndexURL,
        });

        const sandbox: BrowserSandbox = {
          id: sandboxId,
          runtime: 'python',
          worker,
        };

        registry.set(sandboxId, sandbox);
        return { sandbox, sandboxId };
      },

      /** lookup by id */
      getById: async (_config, sandboxId) => {
        const sb = registry.get(sandboxId);
        return sb ? { sandbox: sb, sandboxId } : null;
      },

      /** list sandboxes */
      list: async () => {
        return [...registry.entries()].map(([sandboxId, sandbox]) => ({
          sandbox,
          sandboxId,
        }));
      },

      /** destroy */
      destroy: async (_config, sandboxId) => {
        const sb = registry.get(sandboxId);
        if (sb) {
          try {
            sb.worker.terminate();
          } finally {
            registry.delete(sandboxId);
          }
        }
      },

      /** run Python code */
      runCode: async (
        sandbox: BrowserSandbox,
        code: string,
        _runtime?: Runtime
      ): Promise<ExecutionResult> => {
        if (sandbox.runtime !== 'python') {
          return makeExecutionResult(sandbox.id, {
            ok: false,
            exitCode: 127,
            stderr: `Unsupported runtime "${sandbox.runtime}"`,
          });
        }

        const res = await callWorker(sandbox.worker, {
          type: 'runCode',
          code,
        });

        return makeExecutionResult(sandbox.id, res);
      },

      /** browser has no shell */
      runCommand: async (sandbox, command) => {
        return makeExecutionResult(sandbox.id, {
          ok: false,
          exitCode: 127,
          stderr: `runCommand("${command}") not supported in browser`,
        });
      },

      /** required SandboxInfo fields */
      getInfo: async (sandbox): Promise<SandboxInfo> => ({
        id: sandbox.id,
        provider: '@computesdk/browser',
        runtime: sandbox.runtime,
        status: 'running',
        createdAt: new Date(), // must be Date
        timeout: 0, // must be number
      }),

      getUrl: async () => '',

      /** OPFS filesystem wrapper */
      filesystem: {
        readFile: async (_sb, path) => browserFs.readFile(undefined, path),
        writeFile: async (_sb, path, c) =>
          browserFs.writeFile(undefined, path, c),
        mkdir: async (_sb, path) => browserFs.mkdir(undefined, path),
        readdir: async (_sb, path): Promise<FileEntry[]> =>
          browserFs.readdir(undefined, path),
        exists: async (_sb, path) => browserFs.exists(undefined, path),
        remove: async (_sb, path) => browserFs.remove(undefined, path),
      },
    },
  },
} as ProviderConfig<BrowserSandbox, BrowserConfig>);

// ========================================================
// Public provider API (required by ComputeSDK test-suite)
// ========================================================
export const browser = {
  providerName: '@computesdk/browser',

  getSupportedRuntimes() {
    return ['python'];
  },

  getCapabilities() {
    return {
      filesystem: true,
      commandExecution: false,
      terminal: false,
    };
  },

  ...internalProvider,
};
