// Eventos dos hooks do Antigravity CLI (mod/habblaud-antigravity/hook.mjs, instalado em ~/.gemini/config/hooks.json por
// npm run antigravity:install): SessionStart, PreInvocation, PostInvocation, PreToolUse, PostToolUse e Stop chegam aqui
// com a conta e vão para a fonte do Antigravity (AntigravityLive), que atualiza o agente na hora.
//
//   POST /api/antigravity/events   (hook)   {account?, antigravityHome?, event: <stdin do hook>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import type { AccountEntry } from '../accounts/service';
import { accountByDir, dispatchLiveEvent, parseLiveEnvelope, type Rec } from '../http/live-events';
import type { AntigravityLive } from '../sources/antigravity/live';

export interface AntigravityHookEvent {
  account?: string;
  antigravityHome?: string;
  event: Rec;
}

export function parseAntigravityEvent(raw: unknown): AntigravityHookEvent {
  const env = parseLiveEnvelope(raw, {
    dirField: 'antigravityHome',
    validEvent: (e) => typeof (e.hookEventName ?? e.hook_event_name) === 'string',
    errorMessage: 'esperado {account?, antigravityHome?, event: <JSON do hook do Antigravity>}',
  });
  return {
    event: env.event,
    ...(env.account ? { account: env.account } : {}),
    ...(env.dir ? { antigravityHome: env.dir } : {}),
  };
}

export function antigravityAccountOf(entries: readonly AccountEntry[], account: string | undefined, antigravityHome: string | undefined): string | undefined {
  return accountByDir(entries, account, antigravityHome);
}

export async function handleAntigravityEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: AntigravityLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  await dispatchLiveEvent(req, res, {
    parse: parseAntigravityEvent,
    logKey: 'agy-event',
    logMessage: (msg) => tr('Eventos do Antigravity: falha ao aplicar um evento ({0}).', [msg]),
    apply: deps.live ? (body) => deps.live!.applyHookEvent(antigravityAccountOf(deps.entries(), body.account, body.antigravityHome), body.event) : undefined,
  });
}
