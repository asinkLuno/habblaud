// De qual ferramenta é cada coisa (Claude Code, Codex, Antigravity CLI ou Pi) e os metadados/textos que mudam com
// ela. Puro (sem DOM): testado em ui/provider.test.ts. No protocolo, `provider` ausente quer dizer Claude Code
// (shared/types.ts); aqui tudo cai nisso.
//
// Identidade visual fora do Claude Code (sem logotipo de ninguém): o chip da conta fica "vazado" (fundo escuro, borda
// e letra na cor da conta, cantos em degrau) e, onde há espaço, um selo de texto ao lado do nome.
import { PROVIDER_BADGE, type AccountInfo, type OfficeSnapshot, type Provider } from '../../../shared/types';
import { shortcutHint } from './model';
import { tr } from '../../../shared/i18n';

export interface ProviderDescriptor {
  /** Nome curto da ferramenta nos textos e selos. */
  name: string;
  /** Nome exibido na linha "Ferramenta" do cartão de uso. */
  toolLabel: string;
  /** Selo compacto no canvas do escritório ('' = sem selo). */
  badge: string;
  /** Letra padrão do chip quando não há conta no snapshot nem sufixo no id. */
  defaultShort: string;
  /** Dica (title) do selo da ferramenta. */
  tagTitle: string;
  /** Padrão que evita repetir o selo quando o nome da conta já cita a ferramenta. */
  tagDedupRe: RegExp | null;
  /** Palavras extras para busca (além do nome da conta). */
  searchTerms: string;
  /** A ferramenta grava custo em USD nos transcripts ("Meu dia"). */
  recordsCost: boolean;
  /** Exibe o plano no subtítulo da conta (quando não há e-mail). */
  hasPlanSubtitle: boolean;
}

/** Metadados centralizados por ferramenta: uma única fonte de verdade para toda a UI. */
export const PROVIDER_INFO: Record<Provider, ProviderDescriptor> = {
  claude: {
    name: 'Claude Code',
    toolLabel: 'Claude Code',
    badge: PROVIDER_BADGE.claude,
    defaultShort: '?',
    tagTitle: '',
    tagDedupRe: null,
    searchTerms: '',
    recordsCost: true,
    hasPlanSubtitle: false,
  },
  codex: {
    name: 'Codex',
    toolLabel: 'Codex',
    badge: PROVIDER_BADGE.codex,
    defaultShort: 'X',
    tagTitle: tr('Agente do Codex (OpenAI)'),
    tagDedupRe: /codex/i,
    searchTerms: 'Codex',
    recordsCost: false,
    hasPlanSubtitle: true,
  },
  antigravity: {
    name: 'Antigravity',
    toolLabel: 'Antigravity CLI',
    badge: PROVIDER_BADGE.antigravity,
    defaultShort: 'G',
    tagTitle: tr('Agente do Antigravity CLI (Google)'),
    tagDedupRe: /antigravity|agy/i,
    searchTerms: 'Antigravity agy',
    recordsCost: false,
    hasPlanSubtitle: true,
  },
  pi: {
    name: 'Pi',
    toolLabel: 'Pi',
    badge: PROVIDER_BADGE.pi,
    defaultShort: 'P',
    tagTitle: tr('Agente do Pi'),
    tagDedupRe: /\bpi\b/i,
    searchTerms: 'Pi',
    recordsCost: true,
    hasPlanSubtitle: false,
  },
};

/** Nome de cada ferramenta como aparece nos textos. */
export const PROVIDER_NAME: Record<Provider, string> = {
  claude: PROVIDER_INFO.claude.name,
  codex: PROVIDER_INFO.codex.name,
  antigravity: PROVIDER_INFO.antigravity.name,
  pi: PROVIDER_INFO.pi.name,
};

/** Selo compacto no canvas ("CODEX", "AGY", "PI") ou '' para Claude Code. */
export function providerBadge(provider: Provider): string {
  return PROVIDER_INFO[provider].badge;
}

/** Sufixo acessível para leitores de tela (" (Codex)", " (Antigravity)", " (Pi)" ou ''). */
export function providerSuffix(provider: Provider): string {
  return provider === 'claude' ? '' : ` (${PROVIDER_INFO[provider].name})`;
}

/** Termos extras de busca para a ferramenta. */
export function providerSearchTerms(provider: Provider): string {
  return PROVIDER_INFO[provider].searchTerms;
}

/** A ferramenta grava custo em USD nos transcripts? */
export function providerRecordsCost(provider: Provider): boolean {
  return PROVIDER_INFO[provider].recordsCost;
}

/** Dica do selo de ferramenta. */
export function providerTagTitle(provider: Provider): string {
  return PROVIDER_INFO[provider].tagTitle;
}

/** Ferramenta de um agente, conta, sessão ou pedido (ausente = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

export function isAntigravity(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'antigravity';
}

export function isPi(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'pi';
}

/**
 * O id de conta tem cara de pasta do Codex (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Só para quando a
 * conta já não está no snapshot (ex.: histórico, "Meu dia"): com a conta à mão, vale o `provider` dela.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** O id de conta tem cara de pasta do Antigravity ("antigravity-cli", ".antigravity-cli-work", "agy")? */
export function looksLikeAntigravityId(id: string): boolean {
  return /(?:^|[:/\\])\.?(?:antigravity(?:-cli)?|agy)(?:[-_.~]|$)/i.test(id);
}

/** O id de conta tem cara de pasta do Pi (".pi", ".pi-work", ".pi~2")? */
export function looksLikePiId(id: string): boolean {
  return /(?:^|[:/\\])\.?pi(?:[-_.~]|$)/i.test(id);
}

/** Ferramenta da conta: a do snapshot; sem ela, a dica de quem chamou ou o jeito do id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  if (hint) return hint;
  if (looksLikeCodexId(fallbackId)) return 'codex';
  if (looksLikeAntigravityId(fallbackId)) return 'antigravity';
  if (looksLikePiId(fallbackId)) return 'pi';
  return 'claude';
}

/**
 * Letra do chip de uma conta que não está no snapshot: a primeira letra depois do prefixo da pasta
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T", ".pi-work" -> "W"). A pasta padrão do Codex (".codex") vira
 * "X"; a do Antigravity, "G"; a do Pi (".pi"), "P"; a do Claude Code, "?" (como antes). Nunca devolve "." nem vazio.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex|antigravity-cli|antigravity|agy|pi)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  return PROVIDER_INFO[provider].defaultShort;
}

/** O selo ("Codex", "Antigravity" ou "Pi") ao lado do nome da conta (não repete quando o nome já diz a ferramenta). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  const re = PROVIDER_INFO[provider].tagDedupRe;
  return !!re && !re.test(accountName);
}

/** Rótulo do chip da conta (dica e leitores de tela): "Conta C (dev@x.com)", "Codex · plano Team", "Pi". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) {
    if (!fallbackId) return tr('Conta desconhecida');
    const suffix = provider === 'claude' ? '' : ` · ${PROVIDER_NAME[provider]}`;
    return `${fallbackId}${suffix}`;
  }
  if (provider === 'claude') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ` · ${PROVIDER_NAME[provider]}` : '';
  return `${account.name}${tag}${account.plan ? tr(' · plano {0}', [account.plan]) : ''}`;
}

/**
 * Texto do escritório vazio. Os atalhos ("atalhos c ou d") são só das contas do Claude Code, que vêm de aliases do
 * shell; Codex, Antigravity e Pi entram quando há contas deles.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter((a) => providerOf(a) === 'claude'));
  const hasCodex = accounts.some(isCodex);
  const hasAgy = accounts.some(isAntigravity);
  const hasPi = accounts.some(isPi);
  const hint = keys ? ` (${keys})` : '';
  if (!hasCodex && !hasAgy && !hasPi) return tr('Abra o Claude Code em qualquer projeto{0} e veja seu agente chegar.', [hint]);
  if (!hasAgy) {
    if (hasCodex && hasPi) return tr('Abra o Claude Code{0}, o Codex ou o Pi em qualquer projeto e veja seu agente chegar.', [hint]);
    if (hasPi) return tr('Abra o Claude Code{0} ou o Pi em qualquer projeto e veja seu agente chegar.', [hint]);
    return tr('Abra o Claude Code{0} ou o Codex em qualquer projeto e veja seu agente chegar.', [hint]);
  }
  if (hasCodex && hasPi) return tr('Abra o Claude Code{0}, o Codex, o Antigravity ou o Pi em qualquer projeto e veja seu agente chegar.', [hint]);
  if (hasCodex) return tr('Abra o Claude Code{0}, o Codex ou o Antigravity em qualquer projeto e veja seu agente chegar.', [hint]);
  if (hasPi) return tr('Abra o Claude Code{0}, o Antigravity ou o Pi em qualquer projeto e veja seu agente chegar.', [hint]);
  return tr('Abra o Claude Code{0} ou o Antigravity em qualquer projeto e veja seu agente chegar.', [hint]);
}

/** Algum pedido de permissão do Codex esperando: o prazo é curto e o cartão conta os segundos (relógio de 1 s). */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && isCodex(a.permission) && a.status !== 'offline' && a.status !== 'done');
}

/** Como ver o Codex ao vivo e aprovar pelo escritório (gaveta de um agente do Codex e ajuda). */
export const CODEX_LIVE_HINT = tr('Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.');

/** Políticas de aprovação do Codex (`approval_policy`), quando o servidor as manda no lugar do modo de permissão. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: tr('Pergunta antes de quase tudo'),
  'on-request': tr('Pergunta quando precisa'),
  'on-failure': tr('Pergunta quando um comando falha'),
  never: tr('Nunca pergunta'),
};

/** Aprovação de um agente do Codex em português (valor desconhecido passa como veio). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
