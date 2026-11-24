// Eventos ao vivo da extensão do Pi (mod/habblaud-pi/habblaud.ts):
//   POST /api/pi/events   {account?, piDir?, event: {type, sessionId, ...}}: 200 {ok}
// Mesma trava local de POST /api/codex/events (Host local + loopback fora do Docker).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountEntry } from '../accounts/service';
import { accountByDir, dispatchLiveEvent, parseLiveEnvelope, type Rec } from '../http/live-events';
import type { PiLive } from '../sources/pi/live';
import { tr } from '../../shared/i18n';

export interface PiHookEvent {
  account?: string;
  piDir?: string;
  event: Rec;
}

/** Corpo de POST /api/pi/events. Sem `event` (objeto com type e sessionId): 400. */
export function parsePiEvent(raw: unknown): PiHookEvent {
  const env = parseLiveEnvelope(raw, {
    dirField: 'piDir',
    validEvent: (e) => typeof e.type === 'string' && typeof e.sessionId === 'string',
    errorMessage: 'esperado {account?, piDir?, event: {type, sessionId, ...}}',
  });
  return {
    event: env.event,
    ...(env.account ? { account: env.account } : {}),
    ...(env.dir ? { piDir: env.dir } : {}),
  };
}

/** Conta do Pi a partir do `piDir` informado (ou do `account`). */
export function piAccountOf(entries: readonly AccountEntry[], account: string | undefined, piDir: string | undefined): string | undefined {
  return accountByDir(entries, account, piDir);
}

/** Trata POST /api/pi/events (método e Host já conferidos). */
export async function handlePiEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: PiLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  await dispatchLiveEvent(req, res, {
    parse: parsePiEvent,
    logKey: 'pi-event',
    logMessage: (msg) => tr('Eventos do Pi: falha ao aplicar um evento ({0}).', [msg]),
    apply: deps.live
      ? (body) => {
          const payload = body.piDir && body.event.piDir === undefined ? { ...body.event, piDir: body.piDir } : body.event;
          return deps.live!.applyLiveEvent(piAccountOf(deps.entries(), body.account, body.piDir), payload);
        }
      : undefined,
  });
}
