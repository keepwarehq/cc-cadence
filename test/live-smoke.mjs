// 真调本机 claude 跑两轮（Claude 档，haiku），验证：走 Max 订阅、bypass 能执行工具、--resume 能接上。
// 会消耗少量订阅额度，所以不在 npm test 里，手动跑：npm run smoke
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runTurn } = require('../out/runner.js');
const { Transcript, TurnTranslator } = require('../out/transcript.js');
const { buildEnv, expandHome, CLAUDE } = require('../out/profiles.js');

const claudePath = expandHome(process.env.CLAUDE_PATH || '~/.local/bin/claude');
const cwd = mkdtempSync(join(tmpdir(), 'ccprofile-smoke-'));
const t = new Transcript();

async function turn(prompt, sessionId) {
  const info = {};
  const tr = new TurnTranslator(t, { init: e => Object.assign(info, e), result: e => { info.result = e; } });
  const h = runTurn({
    claudePath, cwd, prompt, sessionId, model: 'haiku', permissionMode: 'bypassPermissions',
    env: buildEnv(process.env, CLAUDE), onEvent: e => tr.handle(e),
  });
  const exit = await h.done;
  tr.finish('未完成');
  return { info, exit, sessionId: tr.sessionId };
}

const fail = msg => { console.error('FAIL:', msg); process.exitCode = 1; };

const a = await turn('Use the Bash tool to run exactly: echo smoke-ok > marker.txt && cat marker.txt. Then reply with the single word: done');
console.log('turn 1:', { apiKeySource: a.info.apiKeySource, permissionMode: a.info.permissionMode, exit: a.exit.code, session: a.sessionId });
if (a.info.apiKeySource !== 'none') fail(`apiKeySource=${a.info.apiKeySource}，不是订阅登录`);
const tool = t.items.find(i => i.kind === 'tool');
if (tool?.status !== 'ok' || !String(tool.output).includes('smoke-ok')) fail(`工具没跑成：${JSON.stringify(tool)}`);

const b = await turn('What word did the file marker.txt contain? Answer with just that word.', a.sessionId);
const answer = t.items.filter(i => i.kind === 'assistant').at(-1)?.text ?? '';
console.log('turn 2:', { exit: b.exit.code, sameSession: b.sessionId === a.sessionId, answer });
if (b.sessionId !== a.sessionId) fail('--resume 之后 session id 变了');
if (!answer.includes('smoke-ok')) fail('第二轮没接上第一轮的上下文');

console.log(process.exitCode ? 'smoke: FAILED' : 'smoke: OK');
