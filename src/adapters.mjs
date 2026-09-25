import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { CodexIpc } from './vendor/local-ipc.mjs';
import { claudeSessions, ClaudeWake } from './vendor/claude-wake.mjs';

import { projectRoot, dshAuth, ensureDshAuth, openDshSocket } from './dsh-auth.mjs';
export { projectRoot, dshAuth };
const home = os.homedir();
const claude = new ClaudeWake();
const uuid = /^[a-zA-Z0-9_-]{1,100}$/;
const checkId = id => { if (!uuid.test(id)) throw Error('对话 ID 无效'); };
export const canonical = p => fs.realpathSync(p);

export function tailRecords(file) {
  // ponytail: read the last 2 MiB; callers get an explicit truncated flag, not a claim of complete history.
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 2 * 1024 * 1024);
    const data = Buffer.alloc(size - start); fs.readSync(fd, data, 0, data.length, start);
    const lines = data.toString('utf8').split('\n'); if (start) lines.shift();
    const records = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    return { records, truncated: start > 0 };
  } finally { fs.closeSync(fd); }
}

function codexRows(sessionId) {
  const db = new DatabaseSync(path.join(home, '.codex/state_5.sqlite'), { readOnly: true });
  try {
    const fields = 'id AS sessionId, cwd, title, rollout_path';
    return sessionId ? db.prepare(`SELECT ${fields} FROM threads WHERE id=? AND originator='Codex Desktop'`).all(sessionId)
      : db.prepare(`SELECT ${fields} FROM threads WHERE archived=0 AND originator='Codex Desktop' ORDER BY updated_at DESC LIMIT 200`).all();
  } finally { db.close(); }
}

export async function dshCall(method, request = {}, namedArgs) {
  let { baseUrl, cookie } = await ensureDshAuth();
  const rpcId = randomUUID();
  const args = namedArgs ?? (method === 'session/list' ? { _request: request } : { request });
  let response;
  try {
    response = await fetch(`${baseUrl}/api/${method}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) });
  } catch { throw Error('DSH 请求失败，但写入可能已被接受。重试前请先检查原请求的执行结果。'); }
  if (response.status === 401) {
    ({ baseUrl, cookie } = await ensureDshAuth(true));
    try { response = await fetch(`${baseUrl}/api/${method}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }) }); }
    catch { throw Error('认证续期后 DSH 请求仍失败；写入结果不确定，不要重发'); }
  }
  if (!response.ok) throw Error(`DSH HTTP ${response.status}${response.status === 401 ? '：请更新本地登录凭据' : ''}`);
  const body = await response.json();
  if (body.rpcId !== rpcId || body.type !== 'server-response') throw Error('无法识别 DSH 回执');
  if (!body.result?.ok) throw Error(`DSH ${body.result?.error?.code}: ${body.result?.error?.message}`);
  return body.result.value;
}

export async function listWorkspaces() {
  const ws = await openDshSocket();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, items) => {
      if (settled) return; settled = true; clearTimeout(timer); ws.close();
      if (error) reject(Error(error)); else resolve(items);
    };
    const timer = setTimeout(() => finish('读取 DSH 工作区快照超时'), 10000);
    ws.onmessage = e => {
      try {
        const frame = JSON.parse(e.data);
        if (frame.type === 'error') finish('DSH 拒绝提供工作区快照');
        else if (frame.value?.type === 'baseline') {
          const items = frame.value.value?.items;
          if (!Array.isArray(items) || items.some(w => typeof w.workspaceId !== 'string' || typeof w.title !== 'string' || typeof w.path !== 'string' || !Array.isArray(w.sessionIds))) finish('DSH 工作区快照格式无效');
          else finish(null, items);
        }
      } catch { finish('DSH 工作区响应格式无效'); }
    };
    ws.onerror = () => finish('DSH 工作区连接不可用，请检查服务及登录状态');
    ws.onclose = () => finish('尚未取得工作区快照，DSH 连接已关闭');
    ws.send(JSON.stringify({ type: 'open', streamId: 'workspaces', endpoint: 'workspace/follow', payload: { args: {} } }));
  });
}

export function resolveDshLocation(cwd, workspaceName, workspaces = []) {
  if (workspaceName === undefined) {
    if (!cwd) throw Error('请提供已有 DSH 工作区的 workspaceName，或绝对目录 cwd');
    return { cwd: canonical(cwd) };
  }
  let matches = workspaces.filter(w => w.title === workspaceName);
  if (!matches.length) throw Error('未找到此 DSH 工作区名称，请用 talk_workspaces 查看已有名称');
  if (cwd) {
    cwd = canonical(cwd);
    matches = matches.filter(w => w.path === cwd);
    if (!matches.length) throw Error('cwd 与指定 DSH 工作区的目录不一致；具体执行目录或 worktree 路径请写入任务提示词');
  }
  if (matches.length !== 1) throw Error('存在同名 DSH 工作区，请提供 talk_workspaces 列出的精确 cwd');
  const workspace = matches[0];
  return { cwd: canonical(workspace.path), workspace };
}

export async function listSessions(app, cwd) {
  let rows;
  if (app === 'claude') rows = (await claudeSessions()).map(s => {
    const meta = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', `${s.pid}.json`), 'utf8'));
    if (meta.entrypoint !== 'claude-desktop') return null;
    return { sessionId: s.sessionId, cwd: s.cwd, title: s.name, status: meta.status, nativeId: meta.hostSessionId };
  }).filter(Boolean);
  else if (app === 'codex') rows = codexRows().map(({ rollout_path, ...r }) => ({ ...r, status: 'unknown' }));
  else if (app === 'dsh') rows = (await dshCall('session/list')).items.filter(s => !s.parentSessionId).map(s => ({
    sessionId: s.sessionId, cwd: s.cwd, status: s.running ? 'running' : 'idle', available: s.agentAvailable, projections: s.projections,
  }));
  else throw Error('不支持此应用');
  return cwd ? rows.filter(r => r.cwd && canonical(r.cwd) === canonical(cwd)) : rows;
}

export const textParts = content => typeof content === 'string' ? content : (content || []).filter(p => ['text', 'input_text', 'output_text'].includes(p.type)).map(p => p.text || '').join('\n');

export async function readSession(target) {
  checkId(target.sessionId);
  if (target.app === 'dsh') {
    const row = (await listSessions('dsh')).find(s => s.sessionId === target.sessionId);
    if (!row) throw Error('未找到此 DSH 对话');
    if (canonical(row.cwd) !== target.cwd) throw Error('对话目录已发生变化');
    const seq = row.projections?.asOfSeq;
    if (!Number.isSafeInteger(seq)) throw Error('DSH 对话缺少已验证的历史记录位置');
    const page = await dshCall('session/page', { address: { kind: 'session', sessionId: target.sessionId }, throughSeq: seq, maxMessages: 40 });
    const events = page.records.filter(r => r.type === 'event').map(r => r.event);
    const endings = events.filter(e => e.type === 'turn/end');
    const ended = endings.at(-1);
    const lastAssistant = new Map(events.filter(e => e.type === 'assistant/message').map(e => [e.data.turn, e.seq]));
    const results = new Map(events.filter(e => e.type === 'tool/result').map(e => [e.data.message.toolCallId, e.data.message]));
    const progress = events.filter(e => e.type === 'tool/call').slice(-10).map(e => ({ id: e.data.callId, tool: e.data.name, time: e.time, state: results.has(e.data.callId) ? (results.get(e.data.callId).isError ? 'failed' : 'finished') : (row.status === 'running' ? 'running' : 'unfinished') }));
    const messages = events.flatMap(e => {
      if (e.type === 'user/message' && e.data.source?.kind === 'user') return [{ id: String(e.seq), role: 'user', text: textParts(e.data.content), time: e.time, requestId: e.data.source.rpcId }];
      if (e.type === 'assistant/message') return [{ id: String(e.seq), role: 'assistant', text: textParts(e.data.message?.content), time: e.time, final: lastAssistant.get(e.data.turn) === e.seq && endings.some(x => x.data.turn === e.data.turn && x.data.reason?.kind === 'completed') }];
      if (e.type === 'turn/end' && e.data.reason?.kind !== 'completed') return [{ id: `end-${e.seq}`, role: 'status', event: true, text: JSON.stringify(e.data.reason), time: e.time }];
      return [];
    });
    let status = row.status;
    if (status === 'idle' && ended?.data.reason?.kind === 'aborted') status = 'paused';
    if (status === 'idle' && ended?.data.reason?.kind === 'error') status = 'failed';
    if (status === 'idle' && ended?.data.reason?.kind === 'blocked') status = 'needs_input';
    const stopped = endings.filter(e => e.data.reason?.kind === 'aborted').at(-1);
    return { status, progress, cursor: seq, pauseKey: stopped ? String(stopped.seq) : null, messages, truncated: page.hasMore, endReason: ended?.data.reason, inbox: row.projections?.values?.inbox };
  }
  let file, status = 'unknown', pauseKey = null;
  if (target.app === 'claude') {
    const row = (await listSessions('claude')).find(s => s.sessionId === target.sessionId);
    if (!row) throw Error('此 Claude 对话未在桌面端运行');
    if (canonical(row.cwd) !== target.cwd) throw Error('对话目录已发生变化');
    status = row.status;
    const root = path.join(home, '.claude/projects');
    const matches = fs.readdirSync(root).map(p => path.join(root, p, `${target.sessionId}.jsonl`)).filter(p => fs.existsSync(p));
    if (matches.length !== 1) throw Error('Claude 对话记录缺失，或存在多个匹配项');
    file = matches[0];
  } else {
    const [row] = codexRows(target.sessionId);
    if (!row || canonical(row.cwd) !== target.cwd) throw Error('Codex 对话目录不匹配');
    file = row.rollout_path;
  }
  const { records, truncated } = tailRecords(file);
  const messages = [];
  for (const r of records) {
    if (target.app === 'claude' && ['user', 'assistant'].includes(r.type)) {
      const text = textParts(r.message?.content); if (text) messages.push({ id: r.uuid, role: r.type, text, final: r.message?.stop_reason === 'end_turn', time: r.timestamp });
      if (r.type === 'user' && ['[Request interrupted by user]', '[Request interrupted by user for tool use]'].includes(text.trim())) pauseKey = r.uuid;
    }
    if (target.app === 'codex') {
      const p = r.payload;
      if (r.type === 'event_msg') {
        if (p.type === 'task_started') status = 'running';
        if (p.type === 'task_complete') status = 'idle';
        if (p.type === 'turn_aborted') { status = 'paused'; pauseKey = r.timestamp; }
        const item = p.item;
        if (p.type === 'item_completed' && ['UserMessage', 'AgentMessage'].includes(item?.type)) {
          messages.push({ id: item.id, role: item.type === 'UserMessage' ? 'user' : 'assistant', text: textParts(item.content), final: item.phase === 'final_answer', time: r.timestamp });
        }
      }
      if (r.type === 'response_item' && p.type === 'message' && ['user', 'assistant'].includes(p.role)) {
        messages.push({ id: p.id || r.timestamp, role: p.role, text: textParts(p.content), final: p.phase === 'final_answer', time: r.timestamp });
      }
    }
  }
  const unique = [...new Map(messages.map(m => [m.id, m])).values()];
  return { status, pauseKey, messages: unique.slice(-40), truncated: truncated || unique.length > 40 };
}

export async function sendNative(target, text, requestId) {
  if (target.app === 'dsh') {
    await dshCall('session/prompt', { sessionId: target.sessionId, requestId, mode: 'queue', content: [{ type: 'text', text }] });
    return { state: 'accepted', detail: 'DSH 已接受提示词，执行尚未完成' };
  }
  if (target.app === 'claude') return claude.wake({ target, text, attemptId: requestId, createdAt: Date.now() });
  const c = new CodexIpc(); let submitted = false;
  try {
    await c.connect(path.join(home, '.codex/ipc/ipc.sock'));
    const owner = await c.request('thread-owner-discovery', { hostId: 'local', conversationId: target.sessionId }, 1);
    if (owner.resultType !== 'success' || !owner.handledByClientId) return { state: 'unavailable', detail: '未找到已连接且管理此任务的 Codex 原客户端' };
    if (!owner.result?.supportsUntrustedAppInput) return { state: 'unsupported', detail: '原客户端不支持对话间消息输入' };
    const callId = `agent_talk_${requestId}`; submitted = true;
    const r = await c.request('thread-follower-start-turn', { conversationId: target.sessionId, turnStart: {
      request: { threadId: target.sessionId, input: [] }, context: { responseItems: [
        { type: 'function_call', call_id: callId, name: 'untrusted_input', arguments: '{}' },
        { type: 'function_call_output', call_id: callId, output: [{ type: 'input_text', text }] },
      ] },
    } }, 2, owner.handledByClientId);
    if (r.resultType === 'success' && r.result?.result?.turn?.id) return { state: 'accepted', turnId: r.result.result.turn.id };
    if (r.error === 'App context must wait until the current turn finishes') return { state: 'busy', detail: '原客户端当前轮次仍在运行，尚未注入任何消息' };
    return { state: 'unknown', detail: '尚未确认原客户端是否已启动新轮次，重试前请先检查原对话' };
  } catch { return { state: submitted ? 'unknown' : 'unavailable', detail: 'Codex 原客户端连接不可用，不会自动重试' }; }
  finally { c.close(); }
}

export async function createSession(app, cwd, requestId, title, workspaceId) {
  if (app !== 'dsh') return { state: 'unsupported', detail: '尚未验证自动创建桌面端原生对话的能力，也未用命令行对话替代' };
  const created = await dshCall('session/create', { ...(workspaceId ? { workspaceId } : { cwd }), sessionId: requestId });
  if (title) await dshCall('session/rename', { sessionId: created.sessionId, title });
  return { state: 'created', app, sessionId: created.sessionId, cwd };
}

export async function codexProbe(sessionId) {
  const c = new CodexIpc();
  try { await c.connect(path.join(home, '.codex/ipc/ipc.sock')); const r = await c.request('thread-owner-discovery', { hostId: 'local', conversationId: sessionId }, 1); return { available: r.resultType === 'success', peerInput: r.result?.supportsUntrustedAppInput === true }; }
  finally { c.close(); }
}
export const closeAdapters = () => claude.close();
