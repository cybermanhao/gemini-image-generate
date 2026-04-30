/**
 * Runtime test runner for eval generated code.
 * Usage: npx tsx runner.ts '<json-options>'
 *
 * Options:
 *   codePath: string       // path to generated index.ts
 *   function: string       // exported function name to call
 *   args: any[]            // arguments to pass
 *   errorsToQueue?: any[]  // errors to inject into mock SDK
 *   timeout?: number       // max ms to wait (default 30000)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

interface RunnerOptions {
  codePath: string;
  function: string;
  args: any[];
  errorsToQueue?: any[];
  timeout?: number;
}

async function main(): Promise<void> {
  let rawArg = process.argv[2];

  // If no arg or arg looks like a file path, try reading from file
  if (!rawArg) {
    console.error('Usage: npx tsx runner.ts "<json-options>"');
    process.exit(1);
  }

  // PowerShell strips quotes from JSON — try to reconstruct from all args
  if (!rawArg.startsWith('{')) {
    rawArg = process.argv.slice(2).join(' ');
  }

  // Still not JSON? Try reading from file
  if (!rawArg.startsWith('{') && fs.existsSync(rawArg)) {
    rawArg = fs.readFileSync(rawArg, 'utf-8');
  }

  const opts: RunnerOptions = JSON.parse(rawArg);

  // Validate generated file exists
  if (!fs.existsSync(opts.codePath)) {
    output({ ok: false, error: `File not found: ${opts.codePath}` });
    return;
  }

  // Create temp directory
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-runtime-'));

  try {
    // Copy mock SDK into temp dir so imports resolve
    const mockSrc = path.resolve(__dirname, 'mock-genai.ts');
    const mockDst = path.join(tmpDir, 'mock-genai.ts');
    fs.copyFileSync(mockSrc, mockDst);

    // Read and rewrite generated code
    const originalCode = fs.readFileSync(opts.codePath, 'utf-8');

    // Replace @google/genai imports with relative path to mock
    const mockPath = './mock-genai';
    const rewrittenCode = originalCode
      .replace(/from\s+['"]@google\/genai['"];?/g, `from '${mockPath}';`)
      .replace(/require\(['"]@google\/genai['"]\)/g, `require('${mockPath}')`);

    // Write the generated module
    const genPath = path.join(tmpDir, 'generated.ts');
    fs.writeFileSync(genPath, rewrittenCode);

    // Build test script that imports the generated module and calls the function
    const testScript = `
import { getCalls, clearCalls } from './mock-genai';
import { ${opts.function} } from './generated';

async function run() {
  clearCalls();
  const startTime = Date.now();
  
  try {
    const result = await ${opts.function}(...${JSON.stringify(opts.args)});
    const elapsed = Date.now() - startTime;
    const calls = getCalls();
    
    console.log(JSON.stringify({
      ok: true,
      result: typeof result === 'string' ? result.slice(0, 200) : result,
      calls,
      elapsed,
    }));
  } catch (err: any) {
    const elapsed = Date.now() - startTime;
    const calls = getCalls();
    
    console.log(JSON.stringify({
      ok: false,
      error: err.message,
      code: err.status ?? err.code,
      calls,
      elapsed,
    }));
  }
}

run();
`;

    const testPath = path.join(tmpDir, 'test.ts');
    fs.writeFileSync(testPath, testScript);

    // Run test in subprocess via tsx
    const tsxPath = await findTsx();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      __EVAL_ERRORS__: JSON.stringify(opts.errorsToQueue ?? []),
    };

    const outputChunks: string[] = [];
    const errChunks: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const proc = spawn('node', [tsxPath, testPath], {
        cwd: tmpDir,
        env,
        timeout: opts.timeout ?? 30000,
      });

      proc.stdout.on('data', (chunk) => outputChunks.push(chunk.toString()));
      proc.stderr.on('data', (chunk) => errChunks.push(chunk.toString()));

      proc.on('close', (code) => {
        if (code !== 0 && code !== null) {
          reject(new Error(`Process exited with code ${code}. stderr: ${errChunks.join('')}`));
        } else {
          resolve();
        }
      });

      proc.on('error', (err) => reject(err));
    });

    // Parse last JSON line from stdout
    const stdout = outputChunks.join('');
    const lines = stdout.trim().split('\n').filter(l => l.trim());
    const jsonLine = lines.reverse().find(l => l.trim().startsWith('{'));

    if (jsonLine) {
      try {
        const result = JSON.parse(jsonLine);
        output(result);
      } catch {
        output({ ok: false, error: 'Failed to parse runner output', raw: stdout.slice(0, 500) });
      }
    } else {
      output({ ok: false, error: 'No JSON output from runner', raw: stdout.slice(0, 500) });
    }
  } catch (err: any) {
    output({ ok: false, error: err.message, stack: err.stack });
  } finally {
    // Cleanup temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function output(result: any): void {
  console.log(JSON.stringify(result));
}

/** Find tsx executable in node_modules */
async function findTsx(): Promise<string> {
  // Check project root
  const candidates = [
    path.resolve(__dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.resolve(__dirname, '..', '..', 'web-ui', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.resolve(__dirname, '..', '..', 'node_modules', '.bin', 'tsx'),
    path.resolve(__dirname, '..', '..', 'web-ui', 'node_modules', '.bin', 'tsx'),
  ];

  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  // Fallback: try npx which
  return 'tsx';
}

main().catch((err) => {
  output({ ok: false, error: err.message });
  process.exit(1);
});
