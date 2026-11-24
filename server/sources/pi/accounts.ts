// Contas do Pi coding agent: uma pasta de agente por perfil (~/.pi/agent, PI_CODING_AGENT_DIR...).
// Node puro e sem dependências do servidor.
//
// Descoberta: HABBLAUD_PI_DIRS (lista separada por vírgula) substitui tudo; senão PI_CODING_AGENT_DIR (ou
// ~/.pi/agent) e qualquer `~/.pi*` cuja pasta (ou subpasta `agent/`) tenha cara de pasta do Pi (isPiAgentDir).
// Privacidade: NUNCA lê auth.json nem credenciais (só confere a estrutura de diretórios/arquivos).
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ACCOUNT_COLORS,
  expandHome,
  isPiDir,
  parseAccountOverrides,
  readShellAliases,
  shortcutsByDir,
  type AccountOverride,
  type DetectedAccount,
} from '../../accounts/detect';

function splitList(v: string | undefined): string[] {
  return (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/**
 * A pasta é um diretório do agente Pi (ex.: ~/.pi/agent)?
 * Reutiliza `isPiDir` como fonte única: reconhece `sessions/--...--/`, `models.json` ou `extensions/` (mesmo com
 * `auth.json` presente) sem confundir com Claude Code (`projects/`) nem Codex (`config.toml`, `thread-writer-locks/`).
 */
export function isPiAgentDir(p: string): boolean {
  return isDir(p) && isPiDir(p);
}

/** Pasta padrão do agente Pi: PI_CODING_AGENT_DIR ou $HOME/.pi/agent. */
export function defaultPiAgentDir(env: NodeJS.ProcessEnv, home: string): string {
  const raw = env.PI_CODING_AGENT_DIR?.trim();
  return raw ? expandHome(raw, home) : join(home, '.pi', 'agent');
}

/**
 * Pastas do Pi observadas. HABBLAUD_PI_DIRS (lista separada por vírgula) substitui a detecção e vale como veio
 * (só precisa existir). Senão: PI_CODING_AGENT_DIR (ou ~/.pi/agent) e `$HOME/.pi*` (ou `<dir>/agent`) que passem
 * em isPiAgentDir. Ordem estável: a padrão primeiro, depois alfabética.
 */
export function discoverPiDirs(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  const override = splitList(env.HABBLAUD_PI_DIRS);
  if (override.length) return [...new Set(override.map((p) => expandHome(p, home)))].filter(isDir);

  const found: string[] = [];
  const main = defaultPiAgentDir(env, home);
  if (isPiAgentDir(main)) found.push(main);

  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (!ent.name.startsWith('.pi')) continue;
      if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
      const root = join(home, ent.name);
      const nested = join(root, 'agent');
      if (isPiAgentDir(nested)) found.push(nested);
      else if (isPiAgentDir(root)) found.push(root);
    }
  } catch {
    // $HOME ilegível
  }

  const dirs = [...new Set(found.map((p) => expandHome(p, home)))];
  dirs.sort((a, b) => (a === main ? 0 : 1) - (b === main ? 0 : 1) || a.localeCompare(b));
  return dirs;
}

/** Overrides das contas do Pi em HABBLAUD_ACCOUNTS. */
export function piOverrides(raw: string | undefined): AccountOverride[] {
  return parseAccountOverrides(raw).filter((o) => o.provider === 'pi');
}

function matchOverride(overrides: AccountOverride[], id: string, dir: string, home: string): AccountOverride | undefined {
  const norm = (p: unknown) => (typeof p === 'string' && p.trim() ? expandHome(p, home) : undefined);
  return overrides.find((o) => norm(o.mountDir) === dir) ?? overrides.find((o) => norm(o.configDir) === dir) ?? overrides.find((o) => o.id === id);
}

/**
 * Id legível de uma pasta do Pi: `~/.pi/agent` → `.pi`, `~/.pi-work/agent` → `.pi-work`;
 * fora do padrão `<pai>/agent`, usa o basename (garantindo prefixo legível).
 */
export function piDirId(dir: string): string {
  const abs = resolve(dir);
  const base = basename(abs);
  if (base === 'agent') {
    const parent = basename(dirname(abs));
    if (parent && parent !== '/' && parent !== '.') return parent;
  }
  return base || '.pi';
}

function uniquePiIds(dirs: string[]): string[] {
  const used = new Set<string>();
  return dirs.map((dir) => {
    const base = piDirId(dir);
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}~${n}`;
    used.add(id);
    return id;
  });
}

function letterCandidates(id: string): string[] {
  const suffix = /^\.?pi[-_.]+([A-Za-z])/i.exec(id)?.[1]?.toUpperCase();
  const out = suffix ? [suffix] : [];
  out.push('P', 'I', 'Q', 'R', 'S', 'T');
  for (let i = 0; i < 26; i++) out.push(String.fromCharCode(65 + i));
  return out;
}

export interface PiDetectOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Letras e cores já usadas pelas outras contas. */
  taken?: { shorts?: Iterable<string>; colors?: Iterable<string> };
}

/** Uma conta por pasta do Pi, na mesma ordem de `dirs`. */
export function detectPiAccounts(dirs: string[], opts: PiDetectOptions = {}): DetectedAccount[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? (env.HOME || homedir());
  const overrides = piOverrides(env.HABBLAUD_ACCOUNTS);
  const aliases = shortcutsByDir(readShellAliases(home, 'pi'), home, defaultPiAgentDir(env, home));
  const ids = uniquePiIds(dirs);
  const usedShorts = new Set([...(opts.taken?.shorts ?? [])].map((s) => s.toUpperCase()));
  const usedColors = new Set(opts.taken?.colors ?? []);

  const partial = dirs.map((dir, i) => {
    const abs = resolve(dir);
    const ov = matchOverride(overrides, ids[i], abs, home);
    const candShort = str(ov?.short)?.slice(0, 3) ?? aliases.get(abs)?.slice(0, 3);
    const short = candShort && !usedShorts.has(candShort.toUpperCase()) ? candShort : undefined;
    if (short) usedShorts.add(short.toUpperCase());
    return { dir, id: str(ov?.id) ?? ids[i], ov, short };
  });

  return partial.map((p) => {
    const short = p.short ?? letterCandidates(p.id).find((l) => !usedShorts.has(l)) ?? 'P';
    usedShorts.add(short.toUpperCase());
    let color = str(p.ov?.color);
    if (!color) {
      color = ACCOUNT_COLORS.find((c) => !usedColors.has(c)) ?? ACCOUNT_COLORS[usedColors.size % ACCOUNT_COLORS.length];
    }
    usedColors.add(color);
    const plan = str(p.ov?.plan);
    return {
      id: p.id,
      provider: 'pi',
      configDir: str(p.ov?.configDir) ?? p.dir,
      short,
      name: str(p.ov?.name) ?? (dirs.length > 1 ? `Pi ${short}` : 'Pi'),
      color,
      ...(plan ? { plan } : {}),
    };
  });
}
