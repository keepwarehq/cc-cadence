import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { PermissionMode } from './profiles';

export interface TurnOptions {
  claudePath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: string;
  permissionMode: PermissionMode;
  sessionId?: string;
  model?: string;
  onEvent: (e: any) => void;
}

export interface TurnExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  spawnError?: Error;
}

export interface TurnHandle {
  stop(): void;
  done: Promise<TurnExit>;
}

/** Run one `claude -p` round: the message goes to stdin, events are read line-by-line from stdout as stream-json; rounds chain via --resume */
export function runTurn(o: TurnOptions): TurnHandle {
  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
                '--permission-mode', o.permissionMode];
  if (o.sessionId) args.push('--resume', o.sessionId);
  if (o.model) args.push('--model', o.model);

  const child = spawn(o.claudePath, args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  let exited = false;

  const done = new Promise<TurnExit>(resolve => {
    child.on('error', spawnError => { exited = true; resolve({ code: null, signal: null, stderr, spawnError }); });
    child.on('close', (code, signal) => { exited = true; resolve({ code, signal, stderr }); });
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (s: string) => { stderr = (stderr + s).slice(-8000); });
  child.stdin.on('error', () => {}); // writing stdin after an early exit raises EPIPE
  child.stdin.end(o.prompt);

  readline.createInterface({ input: child.stdout }).on('line', line => {
    if (!line.trim()) return;
    let e: unknown;
    try { e = JSON.parse(line); } catch { return; }
    try { o.onEvent(e); } catch (err) { console.error('[ccprofile] event handler failed', err); }
  });

  return {
    done,
    stop() {
      if (exited) return;
      child.kill('SIGINT');
      setTimeout(() => { if (!exited) child.kill('SIGTERM'); }, 3000);
    },
  };
}
