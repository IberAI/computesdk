/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pyodide runtime worker (runCode only)
 *
 * - No top-level await (lazy init via ensurePyodide)
 * - Loads Pyodide with importScripts (no TS module resolution errors)
 * - Captures stdout/stderr deterministically
 *
 * Messages in:
 *   { id: string, type: 'init', indexURL?: string }
 *   { id: string, type: 'runCode', code: string }
 *
 * Messages out:
 *   { id, ok: boolean, exitCode: number, stdout?: string, stderr?: string, error?: string }
 */

// -----------------------------
// Minimal ambient declarations (no global augmentation)
// -----------------------------
declare function importScripts(...urls: string[]): void;
// Provided by pyodide.js after importScripts:
declare var loadPyodide: (opts?: { indexURL?: string }) => Promise<Pyodide>;

type Pyodide = {
  runPythonAsync(code: string): Promise<any>;
  setStdout?: (fn: (s: string) => void) => void;
  setStderr?: (fn: (s: string) => void) => void;
};

// -----------------------------
// Message shapes
// -----------------------------
type InitMsg = { id: string; type: 'init'; indexURL?: string };
type RunCodeMsg = { id: string; type: 'runCode'; code: string };
type Msg = InitMsg | RunCodeMsg;

type ExecResult = {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
};

// -----------------------------
// Pyodide loader (lazy, no TLA)
// -----------------------------
let pyPromise: Promise<Pyodide> | null = null;
// Pin a reasonable default; can be overridden by init.indexURL
let PYODIDE_INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v0.29.0/';

function ensurePyodide(indexURL?: string): Promise<Pyodide> {
  if (!pyPromise) {
    if (indexURL) {
      PYODIDE_INDEX_URL = indexURL.endsWith('/') ? indexURL : `${indexURL}/`;
    }
    // Prefer <indexURL>/pyodide.js; fall back to <indexURL>/full/pyodide.js
    try {
      importScripts(`${PYODIDE_INDEX_URL}pyodide.js`);
    } catch {
      importScripts(`${PYODIDE_INDEX_URL}full/pyodide.js`);
    }
    pyPromise = loadPyodide({ indexURL: PYODIDE_INDEX_URL });
  }
  return pyPromise!;
}

// -----------------------------
// Helpers
// -----------------------------
async function execWithCapture(py: Pyodide, code: string): Promise<ExecResult> {
  const wrapped = `
import sys, io, traceback
_out, _err = io.StringIO(), io.StringIO()
__old_out, __old_err = sys.stdout, sys.stderr
sys.stdout, sys.stderr = _out, _err
_exit_code = 0
try:
    exec(compile(${JSON.stringify(code)}, "<stdin>", "exec"), globals(), globals())
except SystemExit as _se:
    try:
        _exit_code = int(getattr(_se, 'code', 1))
    except Exception:
        _exit_code = 1
except Exception:
    traceback.print_exc(file=_err)
    _exit_code = 1
finally:
    sys.stdout, sys.stderr = __old_out, __old_err
(_exit_code, _out.getvalue(), _err.getvalue())
  `.trim();

  try {
    const [exitCode, stdout, stderr] = (await py.runPythonAsync(wrapped)) as [number, string, string];
    return { ok: exitCode === 0, exitCode, stdout, stderr };
  } catch (e: any) {
    return { ok: false, exitCode: 1, stderr: String(e?.message ?? e), error: String(e) };
  }
}

// -----------------------------
// RPC dispatcher
// -----------------------------
(self as any).onmessage = async (ev: MessageEvent<Msg | any>) => {
  const msg = ev.data as Msg;
  const id = (msg as any)?.id ?? '';

  try {
    if (msg.type === 'init') {
      const py = await ensurePyodide(msg.indexURL);
      const probe = await execWithCapture(py, 'print("pyodide ready")');
      // Avoid duplicate "ok" property by forwarding probe as-is
      (self as any).postMessage({ id, ...probe });
      return;
    }

    if (msg.type === 'runCode') {
      const py = await ensurePyodide();
      const result = await execWithCapture(py, msg.code);
      (self as any).postMessage({ id, ...result });
      return;
    }

    (self as any).postMessage({ id, ok: false, exitCode: 1, error: `Unknown message type: ${(msg as any)?.type}` });
  } catch (e: any) {
    (self as any).postMessage({ id, ok: false, exitCode: 1, error: String(e?.message ?? e), stderr: String(e) });
  }
};
