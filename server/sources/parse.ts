// Primitivas de parsing compartilhadas entre fontes (Codex, Antigravity, Pi): comandos de shell e URLs `file://`.
import { fileURLToPath } from 'node:url';

const SHELLS = /^(?:.*\/)?(?:ba|z|da|k|fi)?sh$/;

/**
 * O comando legível de uma chamada de shell: `command` pode ser uma lista (`["/bin/zsh", "-lc", "npm test"]`) ou um
 * texto. O invólucro do shell (`-lc`, `-c`) sai; o resto é juntado com espaços (palavras com espaço entre aspas).
 */
export function commandText(cmd: unknown): string {
  if (typeof cmd === 'string') return cmd.trim();
  if (!Array.isArray(cmd)) return '';
  const words = cmd.filter((w): w is string => typeof w === 'string');
  if (words.length >= 3 && SHELLS.test(words[0]) && /^-[a-z]*c$/.test(words[1])) return words.slice(2).join(' ').trim();
  return words
    .map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`))
    .join(' ')
    .trim();
}

/**
 * Caminho de um `file://` (cwd e caminhos de workspaces podem vir como URL). Drive ou host UNC viram caminho
 * Windows: o arquivo pode ter sido gravado em outro sistema.
 */
export function pathFromUri(v: unknown): string | undefined {
  const s = typeof v === 'string' && v.trim() ? v.trim() : undefined;
  if (!s) return undefined;
  if (!s.startsWith('file://')) return s;
  try {
    const url = new URL(s);
    const path = decodeURIComponent(url.pathname);
    // localhost o parser do file:// já esvazia; host que sobra é UNC. Letra de drive também é Windows.
    const windows = (url.hostname !== '' && url.hostname !== 'localhost') || /^\/[A-Za-z]:/.test(path);
    return fileURLToPath(url, { windows });
  } catch {
    try {
      return decodeURIComponent(new URL(s).pathname);
    } catch {
      return s.slice('file://'.length);
    }
  }
}
