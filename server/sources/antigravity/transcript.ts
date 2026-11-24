// Interpretação dos transcripts do Antigravity CLI (`brain/<id>/.system_generated/logs/transcript.jsonl`): cada linha
// é um passo (`step_index`, `source`, `type`, `status`, `created_at`, `content`, `thinking`, `tool_calls`, `model`,
// `input_tokens`, `cache_read_tokens`, `output_tokens`) que atualiza um AntigravityState e pode gerar atividades e
// sinais (início/fim de turno, progresso, perguntas, tarefas em segundo plano e eventos do GitHub).
//
// Particularidades do Antigravity CLI:
// - em `tool_calls[].args`, cada valor vem serializado como string JSON (ex.: `"Path": "\"/caminho/arquivo.ts\""`) e,
//   quando truncado no transcript compacto, termina com `\n<truncated N bytes>`; nos hooks ao vivo (`PreToolUse`), os
//   argumentos já vêm como valores normais. `unwrapArgs` aceita os dois;
// - em `USER_INPUT`, o prompt vem dentro de `<USER_REQUEST>…</USER_REQUEST>`, acompanhado de `<ADDITIONAL_METADATA>` e
//   `<USER_SETTINGS_CHANGE>`; `cleanPromptText` extrai só o que você escreveu;
// - um mesmo `step_index` pode aparecer primeiro como `RUNNING` e depois como `DONE` (ou o arquivo ser regravado): os
//   tokens e chamadas de ferramenta são contados uma única vez por `step_index`.
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { GitHubEvent } from '../../../shared/github';
import { tr } from '../../../shared/i18n';
import type { Activity, AgentStats, AskQuestion, ShellJob, TaskItem, TaskStatus } from '../../../shared/types';
import { commandText, pathFromUri } from '../parse';
import { detectGitHubResult, githubCallOf } from '../github';
import type { ParsedActivity } from '../transcript';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

const TRUNCATED_SUFFIX = /\n?<truncated \d+ bytes>\s*$/;

/**
 * Desembrulha um valor de `tool_calls[].args` do transcript do Antigravity CLI (onde strings, números, booleanos e
 * objetos vêm codificados como string JSON, às vezes cortados com `<truncated N bytes>`). Valores já normais (hooks)
 * passam como vieram.
 */
export function unwrapValue(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  if (TRUNCATED_SUFFIX.test(trimmed)) {
    const stripped = trimmed.replace(TRUNCATED_SUFFIX, '');
    if (stripped.startsWith('"')) {
      try {
        return JSON.parse(`${stripped}"`);
      } catch {
        return stripped.slice(1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
    return stripped;
  }
  if (/^(?:".*"|true|false|null|-?\d+(?:\.\d+)?|\{[\s\S]*\}|\[[\s\S]*\])$/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      }
    }
  }
  return raw;
}

/** Desembrulha todos os campos de `args` de uma chamada de ferramenta do Antigravity CLI. */
export function unwrapArgs(raw: unknown): Rec {
  const r = rec(raw);
  if (!r) return {};
  const out: Rec = {};
  for (const [k, v] of Object.entries(r)) out[k] = unwrapValue(v);
  return out;
}

/**
 * Extrai o texto do usuário de um `USER_INPUT` do Antigravity CLI: tira `<USER_REQUEST>`, `<ADDITIONAL_METADATA>`,
 * `<USER_SETTINGS_CHANGE>` e `<SYSTEM_MESSAGE>`. Comandos de sistema injetados devolvem `''`.
 */
export function cleanPromptText(raw: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  const body = (m ? m[1] : raw)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .replace(/<SYSTEM_MESSAGE>[\s\S]*?<\/SYSTEM_MESSAGE>/gi, '')
    .replace(/<openbot-developer-instructions>[\s\S]*?<\/openbot-developer-instructions>/gi, '')
    .trim();
  if (!body || /^<(environment_context|user_instructions|system_instruction)\b/i.test(body)) return '';
  return body;
}

/** Modelo trocado pelo usuário num bloco `<USER_SETTINGS_CHANGE>` (ex.: "from None to Gemini 4 Argon (Medium)"). */
export function extractSettingsModel(raw: string): string | undefined {
  const m = /<USER_SETTINGS_CHANGE>[\s\S]*?setting `Model Selection` from .+ to ([^\n.]+?)\.(?:[\s\S]*?)<\/USER_SETTINGS_CHANGE>/i.exec(raw);
  return m?.[1]?.trim() || undefined;
}

/** Converte `questions` do `ask_question` do Antigravity (`{question, options: string[], is_multi_select}`) para o formato do `describeTool('AskUserQuestion')`. */
export function normalizeAskQuestions(raw: unknown): Array<{ question: string; multiSelect?: boolean; options: Array<{ label: string }> }> | undefined {
  const list = Array.isArray(raw) ? raw : Array.isArray(unwrapValue(raw)) ? (unwrapValue(raw) as unknown[]) : undefined;
  if (!list?.length) return undefined;
  const out: Array<{ question: string; multiSelect?: boolean; options: Array<{ label: string }> }> = [];
  for (const item of list) {
    const q = rec(item);
    const question = str(q?.question);
    if (!q || !question) continue;
    const optsRaw = Array.isArray(q.options) ? q.options : [];
    const options = optsRaw
      .map((o) => (typeof o === 'string' ? { label: o } : rec(o) && typeof rec(o)!.label === 'string' ? { label: String(rec(o)!.label) } : undefined))
      .filter((o): o is { label: string } => !!o && !!o.label.trim());
    out.push({
      question,
      ...(q.is_multi_select === true || q.multiSelect === true ? { multiSelect: true } : {}),
      options,
    });
  }
  return out.length ? out : undefined;
}

/** Nome MCP no formato `mcp__<servidor>__<ferramenta>`. */
export function mcpToolName(server: unknown, tool: unknown): string {
  return `mcp__${String(server ?? '?')}__${String(tool ?? '?')}`;
}

export interface NormalizedAntigravityTool {
  tool: string;
  claudeInput: Rec;
  desc: ActivityDescription;
}

/**
 * Normaliza uma ferramenta do Antigravity CLI a partir de argumentos JÁ desembrulhados: fonte única usada pelo
 * transcript (`describeAntigravityTool`) e pelo terminal (`terminal.ts`), evitando duplo `unwrapArgs` e drift.
 */
export function normalizeAntigravityTool(rawName: string, input: Rec): NormalizedAntigravityTool {
  switch (rawName) {
    case 'run_command':
    case 'shell_exec':
    case 'Bash': {
      const command = commandText(input.CommandLine ?? input.command ?? input.cmd);
      const description = str(input.toolSummary) ?? str(input.toolAction) ?? str(input.description);
      const claudeInput = { ...(command ? { command } : {}), ...(description ? { description } : {}) };
      return { tool: 'Bash', claudeInput, desc: describeTool('Bash', claudeInput) };
    }
    case 'manage_task':
    case 'command_status':
    case 'send_command_input': {
      const action = str(input.Action ?? input.action)?.toLowerCase();
      if (action === 'kill') return { tool: 'TaskStop', claudeInput: {}, desc: describeTool('TaskStop', {}) };
      if (action === 'send_input' || rawName === 'send_command_input') {
        return { tool: rawName, claudeInput: input, desc: { kind: 'run', icon: '⌨️', text: tr('Interagindo com um comando') } };
      }
      return { tool: rawName, claudeInput: input, desc: { kind: 'wait', icon: '⏳', text: tr('Verificando tarefa em segundo plano') } };
    }
    case 'read_file':
    case 'view_file':
    case 'view_code_item':
    case 'read_notebook':
    case 'Read': {
      const filePath = str(input.Path) ?? str(input.AbsolutePath) ?? str(input.File) ?? str(input.file_path);
      const claudeInput = filePath ? { file_path: filePath } : {};
      return { tool: 'Read', claudeInput, desc: describeTool('Read', claudeInput) };
    }
    case 'write_file':
    case 'write_to_file':
    case 'Write': {
      const filePath = str(input.Path) ?? str(input.TargetFile) ?? str(input.file_path);
      const content = str(input.Content) ?? str(input.CodeContent) ?? str(input.content);
      const claudeInput = { ...(filePath ? { file_path: filePath } : {}), ...(content !== undefined ? { content } : {}) };
      return { tool: 'Write', claudeInput, desc: describeTool('Write', claudeInput) };
    }
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
    case 'edit_notebook':
    case 'Edit': {
      const filePath = str(input.Path) ?? str(input.TargetFile) ?? str(input.file_path);
      let oldStr = str(input.Target) ?? str(input.TargetContent) ?? str(input.old_string);
      let newStr = str(input.Replacement) ?? str(input.ReplacementContent) ?? str(input.new_string);
      if (oldStr === undefined && newStr === undefined && Array.isArray(input.ReplacementChunks) && input.ReplacementChunks.length > 0) {
        const first = rec(input.ReplacementChunks[0]);
        oldStr = str(first?.TargetContent);
        newStr = str(first?.ReplacementContent);
      }
      const claudeInput = {
        ...(filePath ? { file_path: filePath } : {}),
        ...(oldStr !== undefined ? { old_string: oldStr } : {}),
        ...(newStr !== undefined ? { new_string: newStr } : {}),
      };
      return { tool: 'Edit', claudeInput, desc: describeTool('Edit', claudeInput) };
    }
    case 'list_dir':
    case 'list_directory':
    case 'find_by_name':
    case 'Glob': {
      const path = str(input.DirectoryPath) ?? str(input.SearchDirectory) ?? str(input.Path) ?? str(input.path);
      const pattern = str(input.Pattern) ?? str(input.pattern);
      const claudeInput = { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) };
      return { tool: 'Glob', claudeInput, desc: describeTool('Glob', claudeInput) };
    }
    case 'grep_search':
    case 'code_search':
    case 'Grep': {
      const pattern = str(input.Query) ?? str(input.query) ?? str(input.pattern);
      const path = str(input.SearchPath) ?? str(input.Path) ?? str(input.path);
      const claudeInput = { ...(pattern ? { pattern } : {}), ...(path ? { path } : {}) };
      return { tool: 'Grep', claudeInput, desc: describeTool('Grep', claudeInput) };
    }
    case 'search_web':
    case 'WebSearch': {
      const query = str(input.query) ?? str(input.Query);
      const claudeInput = query ? { query } : {};
      return { tool: 'WebSearch', claudeInput, desc: describeTool('WebSearch', claudeInput) };
    }
    case 'read_url_content':
    case 'WebFetch': {
      const url = str(input.Url) ?? str(input.url);
      const claudeInput = url ? { url } : {};
      return { tool: 'WebFetch', claudeInput, desc: describeTool('WebFetch', claudeInput) };
    }
    case 'invoke_subagent':
    case 'Agent': {
      const role = str(input.Role) ?? str(input.description);
      const typeName = str(input.TypeName) ?? str(input.subagent_type);
      const prompt = str(input.Prompt) ?? str(input.prompt);
      const claudeInput = {
        ...(role ? { description: role } : prompt ? { description: truncate(prompt, 60) } : {}),
        ...(prompt ? { prompt } : {}),
        ...(typeName ? { subagent_type: typeName } : {}),
      };
      return { tool: 'Agent', claudeInput, desc: describeTool('Agent', claudeInput) };
    }
    case 'define_subagent':
      return { tool: rawName, claudeInput: input, desc: { kind: 'delegate', icon: '👥', text: tr('Definindo subagente') } };
    case 'manage_subagents': {
      const action = str(input.Action ?? input.action)?.toLowerCase();
      return {
        tool: rawName,
        claudeInput: input,
        desc: { kind: 'delegate', icon: '👥', text: action === 'kill' || action === 'kill_all' ? tr('Encerrando um subagente') : tr('Gerenciando subagentes') },
      };
    }
    case 'swarm': {
      const action = str(input.action)?.toLowerCase();
      if (action === 'add') {
        const name = str(input.name);
        const brief = str(input.brief);
        const claudeInput = { ...(brief ? { description: truncate(brief, 60) } : name ? { description: name } : {}), ...(name ? { subagent_type: name } : {}) };
        return { tool: 'Agent', claudeInput, desc: describeTool('Agent', claudeInput) };
      }
      if (action === 'kill') return { tool: rawName, claudeInput: input, desc: { kind: 'delegate', icon: '👥', text: tr('Encerrando um subagente') } };
      return { tool: rawName, claudeInput: input, desc: { kind: 'delegate', icon: '👥', text: tr('Coordenando o swarm') } };
    }
    case 'run_workflow':
      return { tool: rawName, claudeInput: input, desc: { kind: 'delegate', icon: '⚙️', text: tr('Executando workflow') } };
    case 'send_message':
    case 'notify_user': {
      const claudeInput = input.Recipient !== undefined ? { to: input.Recipient } : {};
      return { tool: 'SendMessage', claudeInput, desc: describeTool('SendMessage', claudeInput) };
    }
    case 'ask_question':
    case 'AskUserQuestion': {
      const questions = normalizeAskQuestions(input.questions);
      const claudeInput = questions ? { questions } : {};
      return { tool: 'AskUserQuestion', claudeInput, desc: describeTool('AskUserQuestion', claudeInput) };
    }
    case 'task_boundary': {
      const taskName = str(input.TaskName) ?? str(input.TaskStatus);
      return {
        tool: rawName,
        claudeInput: input,
        desc: { kind: 'plan', icon: '🗒️', text: taskName ? truncate(tr('Tarefa: {0}', [maskSecrets(taskName)]), 46) : tr('Atualizando o plano') },
      };
    }
    case 'schedule':
      return { tool: 'ScheduleWakeup', claudeInput: {}, desc: describeTool('ScheduleWakeup', {}) };
    case 'call_mcp_tool': {
      const name = mcpToolName(input.ServerName, input.ToolName);
      const mcpArgs = typeof input.Arguments === 'string' ? unwrapValue(input.Arguments) : input.Arguments;
      const claudeInput = rec(mcpArgs) ?? {};
      return { tool: name, claudeInput, desc: describeTool(name, claudeInput) };
    }
    case 'list_resources':
    case 'read_resource':
      return { tool: rawName, claudeInput: input, desc: { kind: 'mcp', icon: '🔌', text: tr('Lendo recurso MCP') } };
    default: {
      if (rawName.startsWith('browser_')) {
        return { tool: rawName, claudeInput: input, desc: describeTool(`mcp__playwright__${rawName}`, input) };
      }
      return { tool: rawName, claudeInput: input, desc: describeTool(rawName, input) };
    }
  }
}

/**
 * Atividade de uma ferramenta do Antigravity CLI pelo nome bruto que aparece em `tool_calls` ou nos hooks.
 * Passe `{ unwrapped: true }` quando `rawInput` já vier desembrulhado (transcript já desembrulhado ou hooks nativos).
 */
export function describeAntigravityTool(
  rawName: string,
  rawInput: Rec,
  opts?: { unwrapped?: boolean },
): { desc: ActivityDescription; tool: string } {
  const input = opts?.unwrapped ? rawInput : unwrapArgs(rawInput);
  const { desc, tool } = normalizeAntigravityTool(rawName, input);
  return { desc, tool };
}

/** Atividade de um prompt recebido pelo Antigravity CLI: "Recebeu “…”". */
export function describeAntigravityPrompt(text: string): ActivityDescription {
  const shown = truncate(maskSecrets(text.slice(0, 1_000)), 34);
  return { ...describePrompt(text), text: truncate(tr('Recebeu “{0}”', [shown]), 46) };
}

// ------------------------------------------------------------------ estado e parser de linhas

export interface PendingAntigravityCall {
  stepIndex: number;
  tool: string;
  command?: string;
  label?: string;
  input: Rec;
  at: number;
  subagent?: { role?: string; title?: string };
}

export interface AntigravityState {
  model?: string;
  gitBranch?: string;
  title?: string;
  tasks: TaskItem[];
  stats: AgentStats;
  turnOpen?: boolean;
  firstAt?: number;
  lastAt?: number;
  /** Tokens já contabilizados por `step_index` (evita somar duas vezes se o transcript for regravado). */
  stepTokens: Map<number, { in: number; out: number }>;
  /** Passos `PLANNER_RESPONSE` já contados nas estatísticas (guarda contagens por passo para mesclar prefixo sem duplicar). */
  countedSteps: Map<number, { toolCalls: number; subagents: number }>;
  /** Fila FIFO de chamadas de ferramenta pendentes (para ligar cada resultado ao comando/MCP/subagente correspondente). */
  pendingCalls: PendingAntigravityCall[];
  /** Tarefas em segundo plano abertas (`taskId` → ShellJob). */
  shells: Map<string, ShellJob>;
  /** Pergunta (`ask_question`) pendente esperando resposta do usuário. */
  waitingQuestions?: AskQuestion[];
}

export function createAntigravityState(): AntigravityState {
  return {
    tasks: [],
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    stepTokens: new Map(),
    countedSteps: new Map(),
    pendingCalls: [],
    shells: new Map(),
  };
}

export type AntigravitySignal =
  | { type: 'turnStart' }
  | { type: 'turnEnd'; aborted: boolean }
  | { type: 'progress' }
  | { type: 'ask'; questions?: AskQuestion[] }
  | { type: 'github'; event: GitHubEvent; key: string }
  | { type: 'subagentSpawn'; conversationId: string; role?: string; title?: string; transcriptPath?: string }
  | { type: 'subagentMessage'; conversationId: string };

export interface AntigravityLineResult {
  activities: ParsedActivity[];
  signals: AntigravitySignal[];
  at: number;
}

export interface AntigravityParseContext {
  idPrefix: string;
  now: number;
  activities?: boolean;
}

const TITLE_MAX = 90;
const BG_TASK_RE = /Tool is running as a background task with task id:\s*([^\s\n]+)/;
export const TASK_DONE_RE = /Task id "([^"]+)" finished with result:\s*([\s\S]*)/;
const EXIT_CODE_RE = /(?:Command|The command) exited with code (-?\d+)/;
const SUBAGENT_CREATED_RE = /Created the following subagent:\s*\{[\s\S]*?"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/i;
const SUBAGENT_LOG_URI_RE = /"logAbsoluteUri"\s*:\s*"([^"]+)"/;
const SUBAGENT_SENDER_RE = /\[Message\][^\n]*\bsender=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;

/** Extrai `conversationId` e `logAbsoluteUri` do resultado de `invoke_subagent` no transcript do pai. */
export function extractSubagentSpawn(content: string): { conversationId: string; transcriptPath?: string } | undefined {
  const m = SUBAGENT_CREATED_RE.exec(content);
  if (!m) return undefined;
  const conversationId = m[1].toLowerCase();
  const uri = SUBAGENT_LOG_URI_RE.exec(content)?.[1];
  const transcriptPath = uri ? pathFromUri(uri) : undefined;
  return { conversationId, ...(transcriptPath ? { transcriptPath } : {}) };
}

/** Extrai o UUID do subagente remetente em um `SYSTEM_MESSAGE` (`[Message] ... sender=<uuid>`). */
export function extractSubagentSender(content: string): string | undefined {
  return SUBAGENT_SENDER_RE.exec(content)?.[1]?.toLowerCase();
}

function firstLine(s: string, max = 140): string | undefined {
  const line = s.split('\n').find((l) => l.trim());
  return line ? truncate(line, max) : undefined;
}

/** Extrai a saída de um passo de comando (`Command output:\n...` ou `Output:\n...`). */
export function extractCommandOutput(content: string): { output: string; exitCode?: number; backgroundTaskId?: string } {
  const bg = BG_TASK_RE.exec(content)?.[1];
  const exitMatch = EXIT_CODE_RE.exec(content);
  const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
  const outIdx = content.indexOf('Command output:\n');
  const altIdx = outIdx === -1 ? content.indexOf('\nOutput:\n') : -1;
  const output =
    outIdx !== -1
      ? content.slice(outIdx + 'Command output:\n'.length)
      : altIdx !== -1
        ? content.slice(altIdx + '\nOutput:\n'.length)
        : content;
  return { output: output.trim(), ...(exitCode !== undefined ? { exitCode } : {}), ...(bg ? { backgroundTaskId: bg } : {}) };
}

type PushFn = (desc: ActivityDescription, opts?: { key?: string; tool?: string; current?: boolean; durationMs?: number; callId?: string }) => void;

function parseUserInput(state: AntigravityState, content: string, keyBase: string, out: AntigravityLineResult, push: PushFn): void {
  const settingsModel = extractSettingsModel(content);
  if (settingsModel && settingsModel !== state.model) state.model = settingsModel;
  const text = cleanPromptText(content);
  if (!text) return;
  if (state.title === undefined) state.title = truncate(maskSecrets(text.slice(0, 1_000)), TITLE_MAX);
  state.turnOpen = true;
  delete state.waitingQuestions;
  out.signals.push({ type: 'turnStart' });
  push(describeAntigravityPrompt(text), { key: `${keyBase}:u` });
}

function parseSystemMessage(state: AntigravityState, content: string, keyBase: string, out: AntigravityLineResult, push: PushFn): void {
  const doneMatch = TASK_DONE_RE.exec(content);
  if (doneMatch) {
    const taskId = doneMatch[1];
    const body = doneMatch[2];
    const job = state.shells.get(taskId);
    state.shells.delete(taskId);
    const { exitCode } = extractCommandOutput(body);
    const failed = exitCode !== undefined && exitCode !== 0;
    push(
      {
        kind: failed ? 'error' : 'run',
        icon: failed ? '❌' : '✅',
        text: truncate(tr(failed ? 'Shell falhou: {0}' : 'Shell concluiu: {0}', [job?.label ?? taskId]), 46),
      },
      { key: `${keyBase}:bg`, tool: 'ShellDone', current: false },
    );
    return;
  }
  const sender = extractSubagentSender(content);
  if (sender) out.signals.push({ type: 'subagentMessage', conversationId: sender });
}

function parsePlannerResponse(
  state: AntigravityState,
  j: Rec,
  status: string | undefined,
  content: string,
  stepIdx: number | undefined,
  keyBase: string,
  at: number,
  out: AntigravityLineResult,
  push: PushFn,
): void {
  const model = str(j.model);
  if (model && model !== state.model) state.model = model;
  const tin = (num(j.input_tokens) ?? 0) + (num(j.cache_read_tokens) ?? 0);
  const tout = num(j.output_tokens) ?? 0;
  if (stepIdx !== undefined && (tin > 0 || tout > 0)) {
    const prev = state.stepTokens.get(stepIdx);
    state.stepTokens.set(stepIdx, { in: tin, out: tout });
    state.stats.tokensIn += tin - (prev?.in ?? 0);
    state.stats.tokensOut += tout - (prev?.out ?? 0);
  }
  const thinking = str(j.thinking);
  if (thinking) push(SPECIAL.think(), { key: `${keyBase}:th` });

  const calls = Array.isArray(j.tool_calls) ? j.tool_calls : [];
  if (calls.length > 0) {
    const firstTime = stepIdx === undefined || !state.countedSteps.has(stepIdx);
    let stepToolCalls = 0;
    let stepSubagents = 0;
    if (firstTime) state.turnOpen = true;
    calls.forEach((rawCall, idx) => {
      const c = rec(rawCall);
      const rawName = str(c?.name) ?? 'ferramenta';
      const args = unwrapArgs(c?.args);
      const { desc, tool } = describeAntigravityTool(rawName, args, { unwrapped: true });
      const callKey = calls.length > 1 ? `${keyBase}:c${idx}` : `${keyBase}:c`;
      if (firstTime) {
        stepToolCalls++;
        state.stats.toolCalls++;
        if (tool === 'Agent') {
          stepSubagents++;
          state.stats.subagents++;
        }
        const command = tool === 'Bash' ? commandText(args.CommandLine ?? args.command ?? args.cmd) : undefined;
        const subagent =
          rawName === 'invoke_subagent' || rawName === 'Agent'
            ? {
                role: str(args.Role) ?? str(args.TypeName) ?? str(args.subagent_type),
                title: str(args.Prompt) ? truncate(maskSecrets(str(args.Prompt)!.slice(0, 1_000)), TITLE_MAX) : undefined,
              }
            : undefined;
        state.pendingCalls.push({ stepIndex: stepIdx ?? -1, tool, command, label: desc.text, input: args, at, ...(subagent ? { subagent } : {}) });
        if (state.pendingCalls.length > 64) state.pendingCalls.shift();
      }
      if (rawName === 'task_boundary') {
        const taskName = str(args.TaskName);
        const taskStatus = str(args.TaskStatus)?.toLowerCase();
        if (taskName) {
          const st: TaskStatus = taskStatus === 'completed' || taskStatus === 'done' ? 'completed' : 'in_progress';
          const existing = state.tasks.find((t) => t.title === taskName);
          if (existing) existing.status = st;
          else state.tasks.push({ id: String(state.tasks.length + 1), title: truncate(maskSecrets(taskName), 120), status: st });
        }
      }
      push(desc, { key: callKey, tool, callId: callKey });
      if (tool === 'AskUserQuestion') {
        state.waitingQuestions = desc.questions;
        out.signals.push({ type: 'ask', questions: desc.questions });
      } else {
        out.signals.push({ type: 'progress' });
      }
    });
    if (firstTime && stepIdx !== undefined) state.countedSteps.set(stepIdx, { toolCalls: stepToolCalls, subagents: stepSubagents });
    return;
  }

  if (status === 'RUNNING') return;
  if (content.trim()) {
    push(SPECIAL.respond(content.trim()), { key: `${keyBase}:r` });
    push(SPECIAL.turnDone(), { key: `${keyBase}:done` });
    state.turnOpen = false;
    delete state.waitingQuestions;
    out.signals.push({ type: 'turnEnd', aborted: false });
  } else if (status === 'ERROR' || status === 'CANCELED') {
    state.turnOpen = false;
    delete state.waitingQuestions;
    out.signals.push({ type: 'turnEnd', aborted: status === 'CANCELED' });
  }
}

function parseToolResult(
  state: AntigravityState,
  type: string | undefined,
  status: string | undefined,
  content: string,
  keyBase: string,
  at: number,
  out: AntigravityLineResult,
  push: PushFn,
): void {
  if (status === 'RUNNING' || type === 'CHECKPOINT') return;
  const pending = state.pendingCalls.shift();
  const spawn = extractSubagentSpawn(content);
  if (spawn) {
    out.signals.push({
      type: 'subagentSpawn',
      conversationId: spawn.conversationId,
      ...(pending?.subagent?.role ? { role: pending.subagent.role } : {}),
      ...(pending?.subagent?.title ? { title: pending.subagent.title } : {}),
      ...(spawn.transcriptPath ? { transcriptPath: spawn.transcriptPath } : {}),
    });
  }
  const { output, exitCode, backgroundTaskId } = extractCommandOutput(content);
  if (backgroundTaskId) {
    const label = pending?.label ?? (pending?.command ? describeTool('Bash', { command: pending.command }).text : backgroundTaskId);
    state.shells.set(backgroundTaskId, {
      id: backgroundTaskId,
      label,
      ...(pending?.command ? { command: truncate(maskSecrets(pending.command), 300) } : {}),
      startedAt: at,
      background: true,
      kind: 'shell',
    });
  }
  const failed = status === 'ERROR' || type === 'ERROR_MESSAGE' || (exitCode !== undefined && exitCode !== 0);
  const toolName = pending?.tool ?? (type === 'RUN_COMMAND' ? 'Bash' : type === 'VIEW_FILE' ? 'Read' : type === 'CODE_ACTION' ? 'Edit' : undefined);
  if (failed) {
    push(SPECIAL.error(toolName, firstLine(output) ?? (exitCode !== undefined ? tr('Código de saída {0}', [exitCode]) : undefined)), {
      key: `${keyBase}:err`,
      tool: toolName,
    });
  }
  if (pending && (pending.tool === 'Bash' || pending.tool.startsWith('mcp__'))) {
    const gh = githubCallOf(pending.tool, pending.tool === 'Bash' ? { command: pending.command } : pending.input);
    if (gh) {
      const ghContent = failed ? `Exit code ${exitCode ?? 1}\n${output}` : output;
      const event = detectGitHubResult(gh, { content: ghContent, tur: {}, isError: failed, branch: state.gitBranch });
      if (event) out.signals.push({ type: 'github', event, key: keyBase });
    }
  }
}

export function parseAntigravityLine(state: AntigravityState, raw: string, ctx: AntigravityParseContext): AntigravityLineResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { activities: [], signals: [], at: ctx.now };
  }
  const j = rec(parsed);
  if (!j) return { activities: [], signals: [], at: ctx.now };
  const parsedAt = toMs(j.created_at);
  const at = parsedAt ?? ctx.now;
  if (parsedAt !== undefined) {
    if (state.firstAt === undefined || at < state.firstAt) state.firstAt = at;
    if (state.lastAt === undefined || at > state.lastAt) state.lastAt = at;
  }
  const stepIdx = num(j.step_index);
  const keyBase = stepIdx !== undefined ? `s${stepIdx}` : `t${at.toString(36)}`;
  const withActivities = ctx.activities !== false;
  const out: AntigravityLineResult = { activities: [], signals: [], at };

  const push: PushFn = (desc, opts = {}) => {
    if (!withActivities) return;
    const key = opts.key ?? keyBase;
    const activity: Activity = { id: `${ctx.idPrefix}#${key}`, at, ...desc };
    if (opts.tool) activity.tool = opts.tool;
    if (opts.durationMs !== undefined) activity.durationMs = opts.durationMs;
    if (desc.kind === 'error') activity.error = true;
    const current = opts.current ?? true;
    out.activities.push(opts.callId ? { activity, current, toolUseId: opts.callId } : { activity, current });
  };

  const source = str(j.source);
  const type = str(j.type);
  const status = str(j.status);
  const content = typeof j.content === 'string' ? j.content : '';

  if (source === 'USER_EXPLICIT' && type === 'USER_INPUT') {
    parseUserInput(state, content, keyBase, out, push);
  } else if (source === 'SYSTEM' && type === 'SYSTEM_MESSAGE') {
    parseSystemMessage(state, content, keyBase, out, push);
  } else if (source === 'MODEL' && type === 'PLANNER_RESPONSE') {
    parsePlannerResponse(state, j, status, content, stepIdx, keyBase, at, out, push);
  } else if (source === 'MODEL' || source === 'SYSTEM') {
    parseToolResult(state, type, status, content, keyBase, at, out, push);
  }
  return out;
}
