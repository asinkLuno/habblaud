import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectTarget, parseArgs, PI_CONFIG_NAME, PI_EXTENSION_FILE, run } from '../../scripts/pi-install';

const dirsToClean: string[] = [];
afterEach(() => {
  while (dirsToClean.length) rmSync(dirsToClean.pop()!, { recursive: true, force: true });
});

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-pi-inst-'));
  dirsToClean.push(d);
  return d;
}

describe('scripts/pi-install.ts', () => {
  it('install/status/uninstall funcionam de forma idempotente e lêem a porta gravada no status', async () => {
    const home = makeTempDir();
    const piDir = join(home, '.pi', 'agent');
    mkdirSync(join(piDir, 'sessions'), { recursive: true });
    const lines: string[] = [];
    const checkedPorts: number[] = [];

    const inst = parseArgs(['install', '--port', '4949', '--dir', '~/.pi/agent'], { HOME: home });
    const ctx = {
      env: { HOME: home },
      home,
      out: (l: string) => lines.push(l),
      checkHealth: async (port: number) => {
        checkedPorts.push(port);
        return { ok: true, piEvents: true };
      },
    };
    expect(await run(inst, ctx)).toBe(0);
    const dest = join(piDir, 'extensions', PI_EXTENSION_FILE);
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    expect(inspectTarget(dest)).toBe('linked');
    const cfg = JSON.parse(readFileSync(join(home, '.habblaud', PI_CONFIG_NAME), 'utf8')) as { port: number };
    expect(cfg.port).toBe(4949);

    // Re-instalar é no-op e continua OK
    expect(await run(inst, ctx)).toBe(0);
    expect(inspectTarget(dest)).toBe('linked');

    // status sem --port usa a porta salva em pi-extension.json
    const st = parseArgs(['status'], { HOME: home });
    expect(await run(st, ctx)).toBe(0);
    expect(checkedPorts).toEqual([4949]);
    // tildify recebeu `home` e abreviou para ~
    expect(lines.some((l) => l.includes('~/.pi/agent'))).toBe(true);

    // uninstall remove o link simbólico do Habblaud
    const un = parseArgs(['uninstall'], { HOME: home });
    expect(await run(un, ctx)).toBe(0);
    expect(existsSync(dest)).toBe(false);
  });

  it('não sobrescreve nem apaga arquivo de usuário diferente (state === other)', async () => {
    const home = makeTempDir();
    const piDir = join(home, '.pi', 'agent');
    const extDir = join(piDir, 'extensions');
    mkdirSync(extDir, { recursive: true });
    const dest = join(extDir, PI_EXTENSION_FILE);
    writeFileSync(dest, '// extensao do usuario\n');

    const lines: string[] = [];
    const ctx = { env: { HOME: home }, home, out: (l: string) => lines.push(l) };

    expect(await run(parseArgs(['install', '--dir', piDir], ctx.env), ctx)).toBe(1);
    expect(readFileSync(dest, 'utf8')).toBe('// extensao do usuario\n');

    expect(await run(parseArgs(['uninstall', '--dir', piDir], ctx.env), ctx)).toBe(1);
    expect(readFileSync(dest, 'utf8')).toBe('// extensao do usuario\n');
  });
});
