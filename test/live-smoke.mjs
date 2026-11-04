// Calls the real local claude for two rounds (Claude profile, haiku), verifying: Max subscription, bypass runs tools, --resume chains;
// then names the session with the fast model and checks the ai-title lands in the session file.
// Consumes a little subscription quota, so it is not part of npm test; run manually: npm run smoke
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { runTurn } = require('../out/runner.js');
const { Transcript, TurnTranslator } = require('../out/transcript.js');
const { buildEnv, expandHome, CLAUDE } = require('../out/profiles.js');
const { generateTitle } = require('../out/title.js');
const { appendAiTitle, readSessionTitle } = require('../out/sessions.js');

const claudePath = expandHome(process.env.CLAUDE_PATH || '~/.local/bin/claude');
const cwd = mkdtempSync(join(tmpdir(), 'ccprofile-smoke-'));
const t = new Transcript();

async function turn(prompt, sessionId) {
  const info = {};
  const tr = new TurnTranslator(t, { init: e => Object.assign(info, e), result: e => { info.result = e; } });
  const h = runTurn({
    claudePath, cwd, message: { text: prompt, blocks: [] }, sessionId, model: 'haiku', permissionMode: 'bypassPermissions',
    env: buildEnv(process.env, CLAUDE), onEvent: e => tr.handle(e),
  });
  const exit = await h.done;
  tr.finish('Incomplete');
  return { info, exit, sessionId: tr.sessionId };
}

const fail = msg => { console.error('FAIL:', msg); process.exitCode = 1; };

const a = await turn('Use the Bash tool to run exactly: echo smoke-ok > marker.txt && cat marker.txt. Then reply with the single word: done');
console.log('turn 1:', { apiKeySource: a.info.apiKeySource, permissionMode: a.info.permissionMode, exit: a.exit.code, session: a.sessionId });
if (a.info.apiKeySource !== 'none') fail(`apiKeySource=${a.info.apiKeySource}, not a subscription login`);
const tool = t.items.find(i => i.kind === 'tool');
if (tool?.status !== 'ok' || !String(tool.output).includes('smoke-ok')) fail(`tool did not run: ${JSON.stringify(tool)}`);

const b = await turn('What word did the file marker.txt contain? Answer with just that word.', a.sessionId);
const answer = t.items.filter(i => i.kind === 'assistant').at(-1)?.text ?? '';
console.log('turn 2:', { exit: b.exit.code, sameSession: b.sessionId === a.sessionId, answer });
if (b.sessionId !== a.sessionId) fail('session id changed after --resume');
if (!answer.includes('smoke-ok')) fail('the second turn lost the first turn context');

const started = Date.now();
const title = await generateTitle({ claudePath, env: buildEnv(process.env, CLAUDE), firstMessage: 'Use the Bash tool to write smoke-ok into marker.txt and read it back' });
console.log('title:', { title, ms: Date.now() - started });
if (!title) fail('the fast model returned no title');
else if (!(await appendAiTitle(a.sessionId, cwd, title))) fail('could not append the ai-title record');
else if ((await readSessionTitle(a.sessionId, cwd)).aiTitle !== title) fail('the ai-title did not read back');

console.log(process.exitCode ? 'smoke: FAILED' : 'smoke: OK');
