// Instala (ou remove) a extensão ao vivo do Habblaud no Pi coding agent (~/.pi/agent/extensions/habblaud.ts).
// Roda no HOST, com tsx:
//
//   npm run pi:install     # cria link simbólico (ou cópia) da extensão e grava ~/.habblaud/pi-extension.json
//   npm run pi:uninstall   # remove a extensão do Habblaud (outras extensões ficam intactas)
//   npm run pi:status      # verifica se a extensão está instalada e se o Habblaud está respondendo
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultPiAgentDir, discoverPiDirs } from '../server/sources/pi/accounts';
import { tildify } from './statusline-install';
import { tr } from '../shared/i18n';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PI_EXTENSION_SRC = join(ROOT, 'mod', 'habblaud-pi', 'habblaud.ts');
export const PI_EXTENSION_FILE = 'habblaud.ts';
export const PI_CONFIG_NAME = 'pi-extension.json';
export const DEFAULT_PORT = 4747;

const USAGE = tr(
  'Uso: npm run pi:<install|uninstall|status> [-- opções]\n\n  install     instala a extensão do Habblaud em <piDir>/extensions/habblaud.ts\n  uninstall   remove a extensão do Habblaud de cada pasta do Pi\n  status      mostra se a extensão está instalada e se o Habblaud está respondendo\n\nOpções:\n  --dry-run        mostra o que mudaria, sem gravar nada\n  --dir <caminho>  usa esta pasta do Pi (padrão: PI_CODING_AGENT_DIR ou ~/.pi/agent)\n  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou {0})\n  -h, --help       mostra esta ajuda',
  [DEFAULT_PORT],
);

export interface CliArgs {
  cmd: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  dir?: string;
  port: number;
  portExplicit?: boolean;
  help?: boolean;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const cmdRaw = argv[0];
  if (cmdRaw === '-h' || cmdRaw === '--help') return { cmd: 'status', dryRun: false, port: DEFAULT_PORT, help: true };
  if (cmdRaw !== 'install' && cmdRaw !== 'uninstall' && cmdRaw !== 'status') {
    throw new Error(USAGE);
  }
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isFinite(envPort) && envPort > 0 && envPort < 65536 ? envPort : DEFAULT_PORT;
  let portExplicit = false;
  let dryRun = false;
  let dir: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return { cmd: cmdRaw, dryRun, dir, port, portExplicit, help: true };
    if (a === '--dry-run') dryRun = true;
    else if (a === '--dir') {
      dir = argv[++i];
      if (!dir) throw new Error(tr('--dir precisa de um caminho.'));
    } else if (a === '--port') {
      const p = Number.parseInt(argv[++i] ?? '', 10);
      if (!Number.isFinite(p) || p <= 0 || p >= 65536) throw new Error(tr('--port precisa de um número entre 1 e 65535.'));
      port = p;
      portExplicit = true;
    } else {
      throw new Error(tr('Opção desconhecida: {0}', [a]));
    }
  }
  return { cmd: cmdRaw, dryRun, dir, port, portExplicit };
}

function expandHome(p: string, home: string): string {
  return resolve(p.trim().replace(/^~(?=[\\/]|$)/, home));
}

function readConfiguredPort(cfgPath: string): number | undefined {
  try {
    const j = JSON.parse(readFileSync(cfgPath, 'utf8')) as { port?: unknown };
    const p = Number(j?.port);
    return Number.isInteger(p) && p > 0 && p < 65536 ? p : undefined;
  } catch {
    return undefined;
  }
}

export function targetDirs(explicitDir: string | undefined, env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string[] {
  if (explicitDir) return [expandHome(explicitDir, home)];
  const discovered = discoverPiDirs(env, home);
  return discovered.length ? discovered : [defaultPiAgentDir(env, home)];
}

export function inspectTarget(dest: string, src: string = PI_EXTENSION_SRC): 'linked' | 'copied' | 'other' | 'missing' {
  try {
    const st = lstatSync(dest);
    if (st.isSymbolicLink()) {
      return resolve(dirname(dest), readlinkSync(dest)) === resolve(src) ? 'linked' : 'other';
    }
    if (st.isFile()) {
      return readFileSync(dest, 'utf8') === readFileSync(src, 'utf8') ? 'copied' : 'other';
    }
    return 'other';
  } catch {
    return 'missing';
  }
}

export interface PiInstallContext {
  env: NodeJS.ProcessEnv;
  home: string;
  src?: string;
  out: (line: string) => void;
  checkHealth?: (port: number) => Promise<{ ok: boolean; status?: number; piEvents?: boolean } | null>;
}

async function defaultCheckHealth(port: number): Promise<{ ok: boolean; status?: number; piEvents?: boolean } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return { ok: false, status: res.status };
    const j = (await res.json()) as { piEvents?: boolean };
    return { ok: true, piEvents: !!j.piEvents };
  } catch {
    return null;
  }
}

export async function run(args: CliArgs, ctx: PiInstallContext): Promise<number> {
  const { home, env, out } = ctx;
  const src = ctx.src ?? PI_EXTENSION_SRC;
  const dirs = targetDirs(args.dir, env, home);
  const cfgPath = join(home, '.habblaud', PI_CONFIG_NAME);
  const effectivePort = args.portExplicit ? args.port : (readConfiguredPort(cfgPath) ?? args.port);

  if (args.cmd === 'status') {
    for (const d of dirs) {
      const dest = join(d, 'extensions', PI_EXTENSION_FILE);
      const state = inspectTarget(dest, src);
      if (state === 'linked' || state === 'copied') {
        out(tr('✓ {0}: extensão instalada ({1})', [tildify(d, home), state === 'linked' ? tr('link simbólico') : tr('cópia')]));
      } else if (state === 'other') {
        out(tr('! {0}: arquivo diferente em {1}', [tildify(d, home), tildify(dest, home)]));
      } else {
        out(tr('✗ {0}: extensão não instalada (rode npm run pi:install)', [tildify(d, home)]));
      }
    }
    const health = await (ctx.checkHealth ?? defaultCheckHealth)(effectivePort);
    if (!health) {
      out(tr('· Habblaud não está rodando em http://127.0.0.1:{0}.', [effectivePort]));
    } else if (health.ok) {
      out(
        health.piEvents
          ? tr('✓ Habblaud respondendo em http://127.0.0.1:{0} com eventos do Pi ativos.', [effectivePort])
          : tr('! Habblaud respondendo em http://127.0.0.1:{0}, mas a fonte do Pi está desligada.', [effectivePort]),
      );
    } else {
      out(tr('! Habblaud respondeu HTTP {0} em http://127.0.0.1:{1}.', [health.status ?? 0, effectivePort]));
    }
    return 0;
  }

  if (args.cmd === 'install') {
    if (!existsSync(src)) {
      throw new Error(tr('Arquivo da extensão não encontrado: {0}', [src]));
    }
    let code = 0;
    for (const d of dirs) {
      const extDir = join(d, 'extensions');
      const dest = join(extDir, PI_EXTENSION_FILE);
      const state = inspectTarget(dest, src);
      if (state === 'other') {
        out(tr('! {0}: arquivo diferente em {1}', [tildify(d, home), tildify(dest, home)]));
        code = 1;
        continue;
      }
      if (state === 'linked') {
        out(tr('✓ {0}: extensão instalada ({1})', [tildify(d, home), tr('link simbólico')]));
        continue;
      }
      if (args.dryRun) {
        out(tr('[dry-run] instalaria {0} → {1}', [tildify(src, home), tildify(dest, home)]));
        continue;
      }
      mkdirSync(extDir, { recursive: true });
      if (state === 'copied') unlinkSync(dest);
      try {
        symlinkSync(src, dest);
      } catch {
        copyFileSync(src, dest);
      }
      out(tr('✓ Extensão instalada em {0}', [tildify(dest, home)]));
    }
    if (args.dryRun) {
      out(tr('[dry-run] gravaria porta {0} em {1}', [args.port, tildify(cfgPath, home)]));
    } else {
      mkdirSync(dirname(cfgPath), { recursive: true });
      writeFileSync(cfgPath, `${JSON.stringify({ port: args.port }, null, 2)}\n`, 'utf8');
      out(tr('✓ Configuração gravada em {0} (porta {1}).', [tildify(cfgPath, home), args.port]));
      out(tr('No Pi aberto, rode /reload (ou abra uma sessão nova) para ativar.'));
    }
    return code;
  }

  // uninstall
  let code = 0;
  for (const d of dirs) {
    const dest = join(d, 'extensions', PI_EXTENSION_FILE);
    const state = inspectTarget(dest, src);
    if (state === 'missing') {
      out(tr('· {0}: extensão não estava instalada.', [tildify(d, home)]));
      continue;
    }
    if (state === 'other') {
      out(tr('! {0}: arquivo diferente em {1}', [tildify(d, home), tildify(dest, home)]));
      code = 1;
      continue;
    }
    if (args.dryRun) {
      out(tr('[dry-run] removeria {0}', [tildify(dest, home)]));
      continue;
    }
    unlinkSync(dest);
    out(tr('✓ Extensão removida de {0}', [tildify(dest, home)]));
  }
  return code;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const code = await run(args, {
    env: process.env,
    home: process.env.HOME || homedir(),
    out: (line) => console.log(line),
  });
  if (code !== 0) process.exitCode = code;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
