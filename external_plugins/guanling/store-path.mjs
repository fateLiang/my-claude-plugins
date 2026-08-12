// Where an agent's store lives — ONE implementation, imported by both the server and
// the sweep. They must never disagree: a sweep looking in a different place than the
// server writes to reports "clean" forever, which is this tool's worst failure mode.
//
// Resolution order:
//   1. GUANLING_FILE, if set (explicit wins, always)
//   2. $HOME/<agent>/.guanling.json   — when the agent has its own folder under HOME
//   3. $HOME/.guanling/<agent>.json   — the ordinary single-user layout
//
// ⭐ Rule 2 exists because of a real deployment (Robert, 2026-08-09): several agents
// share ONE unix user and ONE $HOME, and each one has its own working directory. The
// usual `~/.tool/` habit assumes one machine = one person; there, it put two different
// agents' task files side by side in one folder. The fleet already had a convention for
// per-agent state — `.pangu-id` lives in the agent's own folder — and this follows it.
//
// ⚠️ This buys no security: same unix user, so anyone who could read another agent's
// file before still can. It is about ownership being legible, not about isolation.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ⭐ ebola 2026-08-09: an agent name is an IDENTIFIER, and this function was treating
// it as a PATH COMPONENT. Measured, before the guard:
//   "../.claude/settings" → $HOME/.claude/settings.json    escaped .guanling/
//   "../../outside/pwned" → /home/outside/pwned.json       escaped $HOME entirely
// On the HTTP path he wrote a file outside $HOME through a crafted tokens entry. On the
// stdio path it is worse, because there the name is set by the CALLER (GUANLING_AGENT):
// he pointed it at a real settings file and the server READ it. The only reason it was
// not overwritten is that the target JSON happened to lack a `cycle` field and threw.
// 🔑 What stopped it was the target's shape, not a guard. That is not a defence.
//
// 🩸 And it corrects a claim in my own comments: I wrote that HTTP is safer because the
// caller cannot name itself. Half right — the caller cannot choose the NAME, and I never
// checked what the name is allowed to BECOME.
//
// The check lives here rather than in each entrypoint for the same reason this file
// exists at all: it is the one place both bindings pass through.
const AGENT_RE = /^[A-Za-z0-9_-]{1,64}$/;        // no dots, no slashes, no whitespace
export const isValidAgent = (a) => AGENT_RE.test(String(a ?? ''));

export function resolveStore(agent, env = process.env) {
  const explicit = (env.GUANLING_FILE || '').trim();
  if (explicit) return explicit;
  if (!agent) return null;                       // caller decides how to fail
  if (!isValidAgent(agent))
    throw new Error(
      `guanling: refusing agent name ${JSON.stringify(String(agent).slice(0, 80))} — ` +
      `an identity is an identifier, not a path. Allowed: letters, digits, _ and -, ` +
      `up to 64 characters.`);
  const home = env.HOME || env.USERPROFILE || '';
  const legacy = join(home, '.guanling', `${agent}.json`);
  const own = join(home, agent);
  let preferred = legacy;
  try {
    if (existsSync(own) && statSync(own).isDirectory()) preferred = join(own, '.guanling.json');
  } catch { /* fall through to the ordinary layout */ }

  // 🔴 Migration must not lose anyone's list. If the preferred path has no file yet but
  // the old one does, keep using the old one and SAY SO. Silently pointing at a
  // non-existent file would hand the agent an empty list — and an empty list is exactly
  // what a healthy list looks like from the outside. That is the failure this whole tool
  // exists to prevent, so it must not be the way its own upgrade behaves.
  if (preferred !== legacy && !existsSync(preferred) && existsSync(legacy)) {
    process.stderr.write(
      `guanling: still using ${legacy}. To move it to your own folder:\n` +
      `  mv ${legacy} ${preferred}\n`);
    return legacy;
  }
  return preferred;
}
