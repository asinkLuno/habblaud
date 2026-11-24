import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { detectAntigravityAccounts, discoverAntigravityDirs } from './accounts';
import { parseAnnotationPbtxt, parseSummariesProto } from './files';
import { AntigravityHistory } from './history';
import { AntigravitySource } from './source';
import { createAntigravityTerminalParser } from './terminal';
import { cleanPromptText, createAntigravityState, describeAntigravityTool, parseAntigravityLine, unwrapArgs } from './transcript';

const CONV_MAIN = '083423ec-018b-4b39-bc54-bc0d6da230b3';
const CONV_SUB = '8c3038dd-d256-43eb-bb8d-06eb652fabf0';

const dirsToClean: string[] = [];
afterEach(() => {
  while (dirsToClean.length) {
    const d = dirsToClean.pop()!;
    rmSync(d, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'habblaud-agy-'));
  dirsToClean.push(d);
  return d;
}

describe('Antigravity CLI — contas, transcript, terminal, histórico e fonte', () => {
  it('descobre ~/.gemini/antigravity-cli e atribui a letra G sem colidir com outras contas', () => {
    const home = makeTempDir();
    const agyDir = join(home, '.gemini', 'antigravity-cli');
    mkdirSync(join(agyDir, 'brain'), { recursive: true });
    mkdirSync(join(agyDir, 'conversations'), { recursive: true });

    const found = discoverAntigravityDirs({ HOME: home }, home);
    expect(found).toEqual([agyDir]);

    const accs = detectAntigravityAccounts(found, { home, env: { HOME: home }, taken: { shorts: ['C', 'X'], colors: ['#f08a3c'] } });
    expect(accs).toEqual([
      {
        id: 'antigravity-cli',
        provider: 'antigravity',
        configDir: agyDir,
        short: 'G',
        name: 'Antigravity',
        color: '#4aa8e8',
      },
    ]);
  });

  it('unwrapArgs e cleanPromptText desembrulham argumentos JSON-stringified e limpam tags do USER_INPUT', () => {
    const args = unwrapArgs({
      CommandLine: '"npm test"',
      WaitMsBeforeAsync: '5000',
      IsDaemon: 'false',
      Truncated: '"linha 1\\nlinha 2\n<truncated 120 bytes>',
    });
    expect(args).toEqual({
      CommandLine: 'npm test',
      WaitMsBeforeAsync: 5000,
      IsDaemon: false,
      Truncated: 'linha 1\nlinha 2',
    });

    const prompt = cleanPromptText(
      '<USER_REQUEST>\nimplemente compatibilidade com antigravity cli\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n2026\n</ADDITIONAL_METADATA>',
    );
    expect(prompt).toBe('implemente compatibilidade com antigravity cli');
    expect(parseAnnotationPbtxt('title:"Add Antigravity CLI Compatibility"')).toBe('Add Antigravity CLI Compatibility');
  });

  it('describeAntigravityTool traduz ferramentas do Antigravity para atividades do Habblaud', () => {
    expect(describeAntigravityTool('run_command', { CommandLine: '"vitest run"', toolSummary: '"Run unit tests"' }).tool).toBe('Bash');
    expect(describeAntigravityTool('read_file', { Path: '"/app/server/index.ts"' }).tool).toBe('Read');
    expect(describeAntigravityTool('write_file', { Path: '"/app/novo.ts"' }).tool).toBe('Write');
    expect(describeAntigravityTool('edit_file', { Path: '"/app/server/index.ts"' }).tool).toBe('Edit');
    expect(describeAntigravityTool('grep_search', { Query: '"Provider"', SearchPath: '"/app"' }).tool).toBe('Grep');
    expect(describeAntigravityTool('find_by_name', { Pattern: '"*.ts"', SearchDirectory: '"/app"' }).tool).toBe('Glob');
    expect(describeAntigravityTool('search_web', { query: '"antigravity cli docs"' }).tool).toBe('WebSearch');
    expect(describeAntigravityTool('invoke_subagent', { TypeName: '"research"', Role: '"Codebase Researcher"' }).tool).toBe('Agent');
    expect(describeAntigravityTool('call_mcp_tool', { ServerName: '"github"', ToolName: '"create_pull_request"', Arguments: '{"title":"feat"}' }).tool).toBe(
      'mcp__github__create_pull_request',
    );
  });

  it('parseAntigravityLine e createAntigravityTerminalParser interpretam passos sem duplicar tokens em releituras', () => {
    const state = createAntigravityState();
    const parser = createAntigravityTerminalParser();
    const lines = [
      JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-17T03:01:33Z',
        content: '<USER_REQUEST>\nCorrija o teste\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 1,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-17T03:01:35Z',
        model: 'gemini-4-argon-medium',
        input_tokens: 1000,
        cache_read_tokens: 500,
        output_tokens: 120,
        thinking: 'Vou rodar os testes.',
        tool_calls: [{ name: 'run_command', args: { CommandLine: '"npm test"', WaitMsBeforeAsync: '5000' } }],
      }),
      JSON.stringify({
        step_index: 2,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-17T03:01:40Z',
        content: 'Created At: 2026-11-17T00:01:35-03:00\nCompleted At: 2026-11-17T00:01:40-03:00\nCommand exited with code 0.\n\nCommand output:\nPASS all tests',
      }),
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-17T03:01:42Z',
        model: 'gemini-4-argon-medium',
        input_tokens: 1200,
        cache_read_tokens: 500,
        output_tokens: 80,
        content: 'Pronto, todos os testes passaram!',
      }),
    ];

    const entries = lines.flatMap((l) => {
      parseAntigravityLine(state, l, { idPrefix: 'agy:1', now: 1_794_884_500_000 });
      return parser.push(l);
    });
    // Releitura da linha 1 não soma tokens nem toolCalls de novo
    parseAntigravityLine(state, lines[1], { idPrefix: 'agy:1', now: 1_794_884_500_000 });

    expect(state.title).toBe('Corrija o teste');
    expect(state.model).toBe('gemini-4-argon-medium');
    expect(state.turnOpen).toBe(false);
    expect(state.stats).toEqual({
      toolCalls: 1,
      tokensIn: 3200,
      tokensOut: 200,
      subagents: 0,
    });
    expect(entries.map((e) => e.kind)).toEqual(['user', 'thinking', 'tool', 'result', 'assistant']);
  });

  it('AntigravitySource e AntigravityHistory acompanham sessão aberta (WAL + history/annotations + hooks) e subagentes', async () => {
    const home = makeTempDir();
    const agyDir = join(home, '.gemini', 'antigravity-cli');
    const convDir = join(agyDir, 'conversations');
    const annDir = join(agyDir, 'annotations');
    const logDir = join(agyDir, 'brain', CONV_MAIN, '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(annDir, { recursive: true });
    mkdirSync(logDir, { recursive: true });

    writeFileSync(join(convDir, `${CONV_MAIN}.db-wal`), '');
    writeFileSync(join(annDir, `${CONV_MAIN}.pbtxt`), 'title:"Compatibilidade Antigravity"');
    writeFileSync(
      join(agyDir, 'history.jsonl'),
      `${JSON.stringify({ display: 'oi', timestamp: 1_794_884_493_000, workspace: '/home/diluca/habblaud', conversationId: CONV_MAIN })}\n`,
    );
    writeFileSync(
      join(logDir, 'transcript.jsonl'),
      `${JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-17T03:01:33Z',
        content: '<USER_REQUEST>\nOlá Antigravity\n</USER_REQUEST>',
      })}\n`,
    );

    const accounts = new AccountsService({ dirs: [], home, env: { HOME: home }, onChange: () => {} });
    const office = new Office({
      names: new NameStore(join(home, 'names.json')),
      version: '1.0.3',
      startedAt: 1_794_884_490_000,
      accounts: (s) => accounts.list(s),
      sources: () => src.sources(),
      accountName: (id) => accounts.find(id)?.detected.name,
      terminal: true,
      permissions: () => new Map(),
      ptys: () => ({ status: { enabled: false }, list: [] }),
    });
    const src = new AntigravitySource({ accounts, office, dirs: [agyDir], home, watch: false });
    src.boot();

    let snap = office.commit().snapshot;
    expect(snap.agents).toHaveLength(1);
    expect(snap.agents[0]).toMatchObject({
      id: `antigravity-cli:${CONV_MAIN}`,
      provider: 'antigravity',
      account: 'antigravity-cli',
      roomId: '/home/diluca/habblaud',
      title: 'Compatibilidade Antigravity',
      status: 'working',
    });

    // Evento de hook de um subagente e depois Stop
    expect(
      src.applyHookEvent('antigravity-cli', {
        hookEventName: 'PreToolUse',
        conversationId: CONV_SUB,
        parentConversationId: CONV_MAIN,
        agentName: 'Codebase Researcher',
        cwd: '/home/diluca/habblaud',
        toolCall: { id: 'tc1', name: 'read_file', args: { Path: '/home/diluca/habblaud/README.md' } },
      }),
    ).toBe(true);

    snap = office.commit().snapshot;
    expect(snap.agents).toHaveLength(2);
    const sub = snap.agents.find((a) => a.kind === 'sub')!;
    expect(sub).toMatchObject({
      id: `antigravity-cli:${CONV_SUB}`,
      parentId: `antigravity-cli:${CONV_MAIN}`,
      role: 'Codebase Researcher',
      status: 'working',
    });

    const hist = new AntigravityHistory({
      accounts: () => accounts.entriesOf('antigravity'),
      openAgentOf: (acc, sid) => snap.agents.find((a) => a.account === acc && a.sessionId === sid)?.id,
    });
    const recent = await hist.list();
    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      account: 'antigravity-cli',
      provider: 'antigravity',
      sessionId: CONV_MAIN,
      project: '/home/diluca/habblaud',
      title: 'Compatibilidade Antigravity',
      open: true,
    });
  });

  it('reconhece subagentes pelo transcript do pai (invoke_subagent) sem hooks nem proto e acompanha seu ciclo de vida', () => {
    const home = makeTempDir();
    const agyDir = join(home, '.gemini', 'antigravity-cli');
    const convDir = join(agyDir, 'conversations');
    const mainLog = join(agyDir, 'brain', CONV_MAIN, '.system_generated', 'logs');
    const subLog = join(agyDir, 'brain', CONV_SUB, '.system_generated', 'logs');
    mkdirSync(convDir, { recursive: true });
    mkdirSync(mainLog, { recursive: true });
    mkdirSync(subLog, { recursive: true });

    let now = 1_795_500_000_000;
    writeFileSync(join(convDir, `${CONV_MAIN}.db-wal`), '');
    writeFileSync(
      join(agyDir, 'history.jsonl'),
      `${JSON.stringify({ display: 'auditar', timestamp: now - 5_000, workspace: '/repo/habblaud', conversationId: CONV_MAIN })}\n`,
    );
    const mainTranscript = join(mainLog, 'transcript.jsonl');
    writeFileSync(
      mainTranscript,
      `${JSON.stringify({
        step_index: 0,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: new Date(now - 4_000).toISOString(),
        content: '<USER_REQUEST>\nAuditar o código\n</USER_REQUEST>',
      })}\n`,
    );

    const accounts = new AccountsService({ dirs: [], home, env: { HOME: home }, onChange: () => {} });
    const office = new Office({
      names: new NameStore(null),
      version: '1.0.3',
      startedAt: now - 10_000,
      accounts: (s) => accounts.list(s),
      sources: () => src.sources(),
      accountName: (id) => accounts.find(id)?.detected.name,
      terminal: true,
      permissions: () => new Map(),
      ptys: () => ({ status: { enabled: false }, list: [] }),
      now: () => now,
    });
    const src = new AntigravitySource({ accounts, office, dirs: [agyDir], home, watch: false, now: () => now });
    src.boot();
    expect(office.commit().snapshot.agents).toHaveLength(1);

    // Pai dispara invoke_subagent e recebe conversationId no resultado
    now += 2_000;
    const subTranscript = join(subLog, 'transcript.jsonl');
    writeFileSync(
      subTranscript,
      [
        JSON.stringify({
          step_index: 0,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: new Date(now).toISOString(),
          content: 'Audit server/sources/antigravity',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(now + 100).toISOString(),
          model: 'gemini-4-neon',
          tool_calls: [{ name: 'read_file', args: { Path: '"/repo/habblaud/README.md"' } }],
        }),
      ].join('\n') + '\n',
    );
    writeFileSync(
      mainTranscript,
      [
        JSON.stringify({
          step_index: 0,
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          status: 'DONE',
          created_at: new Date(now - 6_000).toISOString(),
          content: '<USER_REQUEST>\nAuditar o código\n</USER_REQUEST>',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(now - 500).toISOString(),
          tool_calls: [
            {
              name: 'invoke_subagent',
              args: { Role: '"Antigravity Source Auditor"', TypeName: '"research"', Prompt: '"Audit antigravity"' },
            },
          ],
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'GENERIC',
          status: 'DONE',
          created_at: new Date(now).toISOString(),
          content: `Created At: 2026-11-24\nCreated the following subagent:\n{\n  "conversationId":  "${CONV_SUB}",\n  "logAbsoluteUri":  "file://${subTranscript}"\n}`,
        }),
      ].join('\n') + '\n',
    );

    src.poll(false);
    let snap = office.commit().snapshot;
    const sub = snap.agents.find((a) => a.kind === 'sub');
    expect(sub).toBeDefined();
    expect(sub).toMatchObject({
      id: `antigravity-cli:${CONV_SUB}`,
      parentId: `antigravity-cli:${CONV_MAIN}`,
      role: 'Antigravity Source Auditor',
      status: 'working',
    });

    // Subagente termina seu turno -> completeSub (entra em graça/done)
    now += 3_000;
    writeFileSync(
      subTranscript,
      [
        JSON.stringify({
          step_index: 0,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          created_at: new Date(now - 3_000).toISOString(),
          content: 'Audit server/sources/antigravity',
        }),
        JSON.stringify({
          step_index: 1,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(now - 2_900).toISOString(),
          model: 'gemini-4-neon',
          tool_calls: [{ name: 'read_file', args: { Path: '"/repo/habblaud/README.md"' } }],
        }),
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          created_at: new Date(now).toISOString(),
          content: 'Relatório concluído.',
        }),
      ].join('\n') + '\n',
    );
    src.poll(false);
    expect(office.isSubDone(`antigravity-cli:${CONV_SUB}`)).toBe(true);
  });

  it('evita duplo unwrapArgs, pareia pendingCalls em FIFO e respeita PLANNER_RESPONSE RUNNING', () => {
    const state = createAntigravityState();
    const parser = createAntigravityTerminalParser();
    const planner = JSON.stringify({
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      created_at: '2026-11-17T03:01:35Z',
      tool_calls: [
        { name: 'grep_search', args: { Query: '"\\"true\\""', SearchPath: '"/app"' } },
        { name: 'run_command', args: { CommandLine: '"gh pr create --title x"' } },
        { name: 'read_file', args: { Path: '"/app/a.ts"' } },
      ],
    });
    const rPlanner = parseAntigravityLine(state, planner, { idPrefix: 'agy:1', now: 1_000 });
    const tEntries = parser.push(planner);
    // Query desembrulhado uma vez = "\"true\"" (string, não boolean) -> aparece no texto da atividade e do terminal
    expect(rPlanner.activities[0].activity.text).toContain('true');
    const grepEntry = tEntries.find((e) => e.kind === 'tool' && e.tool === 'Grep');
    expect(grepEntry?.kind === 'tool' ? grepEntry.title : '').toContain('true');

    // Resultado 1 (grep), resultado 2 (run_command com erro), resultado 3 (read_file OK)
    const rGrep = parseAntigravityLine(
      state,
      JSON.stringify({ step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-17T03:01:36Z', content: 'matches' }),
      { idPrefix: 'agy:1', now: 1_001 },
    );
    expect(rGrep.activities).toEqual([]);
    const rBash = parseAntigravityLine(
      state,
      JSON.stringify({
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-17T03:01:37Z',
        content: 'Command exited with code 0.\n\nCommand output:\nhttps://github.com/org/repo/pull/42',
      }),
      { idPrefix: 'agy:1', now: 1_002 },
    );
    expect(rBash.signals.some((s) => s.type === 'github' && s.event.kind === 'pr_opened')).toBe(true);

    // PLANNER_RESPONSE em RUNNING com texto parcial não fecha turnOpen
    const rStreaming = parseAntigravityLine(
      state,
      JSON.stringify({
        step_index: 5,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'RUNNING',
        created_at: '2026-11-17T03:01:38Z',
        content: 'Parcial...',
      }),
      { idPrefix: 'agy:1', now: 1_003 },
    );
    expect(rStreaming.signals.some((s) => s.type === 'turnEnd')).toBe(false);
    expect(state.turnOpen).toBe(true);
  });

  it('promove main para sub sem agente fantasma, mascara hookTitle, bloqueia hintTranscript arbitrário e respeita stop()', () => {
    const home = makeTempDir();
    const agyDir = join(home, '.gemini', 'antigravity-cli');
    const convDir = join(agyDir, 'conversations');
    mkdirSync(convDir, { recursive: true });
    writeFileSync(join(convDir, `${CONV_MAIN}.db-wal`), '');
    writeFileSync(join(convDir, `${CONV_SUB}.db-wal`), '');
    writeFileSync(
      join(agyDir, 'history.jsonl'),
      [
        JSON.stringify({ display: 'main', timestamp: 1_795_500_000_000, workspace: '/repo/p', conversationId: CONV_MAIN }),
        JSON.stringify({ display: 'sub', timestamp: 1_795_500_000_000, workspace: '/repo/p', conversationId: CONV_SUB }),
      ].join('\n') + '\n',
    );
    const now = 1_795_500_001_000;
    const accounts = new AccountsService({ dirs: [], home, env: { HOME: home }, onChange: () => {} });
    const office = new Office({
      names: new NameStore(null),
      version: '1.0.3',
      startedAt: now - 5_000,
      accounts: (s) => accounts.list(s),
      sources: () => src.sources(),
      accountName: (id) => accounts.find(id)?.detected.name,
      terminal: true,
      permissions: () => new Map(),
      ptys: () => ({ status: { enabled: false }, list: [] }),
      now: () => now,
    });
    const src = new AntigravitySource({ accounts, office, dirs: [agyDir], home, watch: false, now: () => now });
    src.boot();
    expect(office.commit().snapshot.agents.filter((a) => a.kind === 'main')).toHaveLength(2);

    // Hook promove CONV_SUB para subagente com secret no lastUserInput e transcriptPath malicioso
    expect(
      src.applyHookEvent('antigravity-cli', {
        hookEventName: 'PreInvocation',
        conversationId: CONV_SUB,
        parentConversationId: CONV_MAIN,
        agentName: 'research',
        cwd: '/repo/p',
        transcriptPath: join(agyDir, 'history.jsonl'),
        lastUserInput: '<USER_REQUEST>token sk-ant-api03-123456789012345678901234567890</USER_REQUEST>',
      }),
    ).toBe(true);

    const snap = office.commit().snapshot;
    expect(snap.agents.filter((a) => a.id === `antigravity-cli:${CONV_SUB}`)).toHaveLength(1);
    const sub = snap.agents.find((a) => a.id === `antigravity-cli:${CONV_SUB}`)!;
    expect(sub.kind).toBe('sub');
    expect(sub.parentId).toBe(`antigravity-cli:${CONV_MAIN}`);
    expect(sub.title ?? '').not.toContain('sk-ant-api03');
    expect(src.transcriptPathOf(`antigravity-cli:${CONV_SUB}`)).toBeUndefined();

    // Após stop(), applyHookEvent retorna false
    src.stop();
    expect(
      src.applyHookEvent('antigravity-cli', {
        hookEventName: 'PreToolUse',
        conversationId: CONV_MAIN,
        toolCall: { name: 'read_file', args: { Path: '/repo/p/a.ts' } },
      }),
    ).toBe(false);
  });

  it('parseSummariesProto decodifica parentConversationId, agentRole, gitBranch e ignora varint truncado', () => {
    const varint = (n: number) => {
      const bytes: number[] = [];
      let v = n;
      while (v >= 0x80) {
        bytes.push((v & 0x7f) | 0x80);
        v >>>= 7;
      }
      bytes.push(v);
      return Buffer.from(bytes);
    };
    const fieldVarint = (f: number, v: number) => Buffer.concat([varint((f << 3) | 0), varint(v)]);
    const fieldBytes = (f: number, b: Buffer | string) => {
      const buf = typeof b === 'string' ? Buffer.from(b, 'utf8') : b;
      return Buffer.concat([varint((f << 3) | 2), varint(buf.length), buf]);
    };
    const ws = Buffer.concat([fieldBytes(1, 'file:///repo/habblaud'), fieldBytes(4, 'feat/zh-cn')]);
    const roleMsg = Buffer.concat([fieldBytes(1, 'research'), fieldBytes(2, 'Code Auditor')]);
    const meta = Buffer.concat([fieldBytes(5, CONV_MAIN), fieldBytes(8, roleMsg)]);
    const summaryBody = Buffer.concat([fieldVarint(5, 2), fieldBytes(9, ws), fieldBytes(17, meta)]);
    const entry = Buffer.concat([fieldBytes(1, CONV_SUB), fieldBytes(2, summaryBody)]);
    const proto = fieldBytes(1, entry);

    const parsed = parseSummariesProto(proto);
    expect(parsed.get(CONV_SUB)).toMatchObject({
      conversationId: CONV_SUB,
      status: 'running',
      cwd: '/repo/habblaud',
      gitBranch: 'feat/zh-cn',
      parentConversationId: CONV_MAIN,
      agentRole: 'Code Auditor',
    });

    // Buffer com varint truncado no fim não deve quebrar nem emitir campos corrompidos
    const truncated = Buffer.from([0x08, 0x80]); // field 1, wire 0, varint sem terminador
    expect(parseSummariesProto(truncated).size).toBe(0);
  });
});
