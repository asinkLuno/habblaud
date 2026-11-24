// Base compartilhada para endpoints HTTP de eventos ao vivo (Codex, Antigravity CLI, Pi):
// parse do envelope `{account?, <homeKey>?, event}`, resolução de conta por caminho e tratamento seguro de erros.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from './app';
import { errMsg, log } from '../log';

export type Rec = Record<string, unknown>;

export function asRecord(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

export function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Resolve o id da conta pelo caminho absoluto informado (`configDir` ou `dir`), caindo para `account`. */
export function accountByDir(entries: readonly AccountEntry[], account: string | undefined, dir: string | undefined): string | undefined {
  if (dir && isAbsolute(dir)) {
    const abs = resolve(dir);
    const e = entries.find((x) => resolve(x.detected.configDir) === abs || resolve(x.dir) === abs);
    if (e) return e.id;
  }
  return account;
}

export interface ParsedLiveEnvelope {
  account?: string;
  dir?: string;
  event: Rec;
}

export function parseLiveEnvelope(
  raw: unknown,
  opts: { dirField: string; validEvent: (event: Rec) => boolean; errorMessage: string },
): ParsedLiveEnvelope {
  const r = asRecord(raw);
  const event = asRecord(r?.event);
  if (!r || !event || !opts.validEvent(event)) throw new HttpError(400, opts.errorMessage);
  const out: ParsedLiveEnvelope = { event };
  const account = shortStr(r.account, 200);
  const dir = shortStr(r[opts.dirField], 4_096);
  if (account) out.account = account;
  if (dir) out.dir = dir;
  return out;
}

export async function dispatchLiveEvent<T>(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    parse: (raw: unknown) => T;
    logKey: string;
    logMessage: (err: string) => string;
    apply?: (body: T) => boolean;
  },
): Promise<void> {
  const body = opts.parse(await readJson(req));
  let ok = false;
  if (opts.apply) {
    try {
      ok = opts.apply(body) === true;
    } catch (err) {
      const msg = errMsg(err);
      log.warnOnce(`${opts.logKey}:${msg}`, opts.logMessage(msg));
    }
  }
  sendJson(res, 200, { ok });
}
