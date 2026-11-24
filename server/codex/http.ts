// Eventos dos hooks do Codex (mod/habblaud-codex/hook.mjs, que npm run codex:install acrescenta em
// <CODEX_HOME>/hooks.json): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop,
// SubagentStart, SubagentStop e SessionEnd chegam aqui com a conta e vão para a fonte do Codex (CodexLive), que
// atualiza o agente na hora, sem esperar a conversa chegar ao arquivo. Os eventos só observam (a resposta nunca volta
// para a sessão), mas só valem vindos do próprio computador: a trava (Host local e, fora do Docker, conexão pelo
// loopback) é conferida em http/app.ts (o hook roda no Mac e fala com 127.0.0.1; no Docker, pela porta publicada). O
// guard (http/guard.ts) já exigiu JSON.
//
//   POST /api/codex/events   (hook)   {account?, codexHome?, event: <stdin do hook, textos cortados>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountEntry } from '../accounts/service';
import { accountByDir, dispatchLiveEvent, parseLiveEnvelope, type Rec } from '../http/live-events';
import type { CodexLive } from '../sources/codex/live';
import { tr } from '../../shared/i18n';

export interface CodexHookEvent {
  /** Conta calculada pelo hook (basename do CODEX_HOME). */
  account?: string;
  /** Pasta CODEX_HOME da sessão, no computador onde o hook roda. */
  codexHome?: string;
  /** O stdin do hook (hook_event_name, session_id...). */
  event: Rec;
}

/** Corpo de POST /api/codex/events. Sem `event` (objeto com hook_event_name): 400. */
export function parseCodexEvent(raw: unknown): CodexHookEvent {
  const env = parseLiveEnvelope(raw, {
    dirField: 'codexHome',
    validEvent: (e) => typeof e.hook_event_name === 'string',
    errorMessage: 'esperado {account?, codexHome?, event: <JSON do hook do Codex>}',
  });
  return {
    event: env.event,
    ...(env.account ? { account: env.account } : {}),
    ...(env.dir ? { codexHome: env.dir } : {}),
  };
}

/**
 * Conta do Codex de um evento do hook: a da pasta CODEX_HOME que ele mandou (pelo caminho do host, AccountInfo.configDir,
 * ou pelo lido por este processo); senão a que ele calculou (o basename não sabe dos ids desambiguados, ex. ".codex~2").
 */
export function codexAccountOf(entries: readonly AccountEntry[], account: string | undefined, codexHome: string | undefined): string | undefined {
  return accountByDir(entries, account, codexHome);
}

/** Trata POST /api/codex/events (método e Host já conferidos). `ok` = a fonte do Codex aproveitou o evento. */
export async function handleCodexEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: CodexLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  await dispatchLiveEvent(req, res, {
    parse: parseCodexEvent,
    logKey: 'codex-event',
    logMessage: (msg) => tr('Eventos do Codex: falha ao aplicar um evento ({0}).', [msg]),
    apply: deps.live ? (body) => deps.live!.applyHookEvent(codexAccountOf(deps.entries(), body.account, body.codexHome), body.event) : undefined,
  });
}
