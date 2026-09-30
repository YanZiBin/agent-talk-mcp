import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from './store.mjs';
import { Delivery, eligible, eventKey } from './delivery.mjs';
import { DshEvents } from './dsh-events.mjs';
import { listSessions, listWorkspaces, resolveDshLocation, readSession, createSession, dshCall, closeAdapters, canonical, projectRoot } from './adapters.mjs';

process.umask(0o077);
z.setErrorMap(issue => ({ message: `参数校验失败（${issue.code}），请检查字段的类型、格式和取值范围。` }));
const store = new Store(process.env.AGENT_TALK_DB || path.join(projectRoot, '.local/agent-talk.sqlite'));
const delivery = new Delivery(store), events = new DshEvents(store, delivery);
const server = new McpServer({ name: 'agent-talk', version: '0.4.0' }, { instructions: '在当前已有的 Codex/Claude 对话中协调 DSH。面向用户的说明、进度和结果总结应跟随用户语言，默认使用简体中文；不要因为工具名、参数名、状态码或原始错误是英文，就改用英文回复。保留原始引用、代码、文件路径和标识符，不擅自翻译用户传递的材料。绑定精确的发起对话；用户指定已有 DSH 工作区时，用 talk_workspaces 查询名称和目录，再通过 workspaceName 创建 DSH 对话，新建 DSH 对话默认开启自动回传，必须将 replyTo 指向精确绑定的当前发起对话，无需额外调用 talk_follow；只有用户明确不要回传时才设置 autoReturn=false。未收到回传时先检查 talk_read 的 returnRoute、lastReturn 或 talk_outbox，不要猜测未开启，也不要重发 held 消息。提示词与工作流程由用户决定。收到其他 AI 的回复后，先结合当前对话的目标和上下文理解、判断，再以自己的视角向用户简洁汇报。默认不直接照搬原文，也不把对方的说法当作自己已经核实的事实；用户另有要求时，以用户要求为准。保持 requestId 稳定。接收方忙碌时将消息持久保存到队列；结果不确定的发送绝不能重发。原客户端停止后，桥接投递保持暂停，只有发起对话或用户明确决定才恢复。权限审批仍在 DSH Web 处理。审查完成的执行对话不再复用。不自动创建桌面对话或归档。' });
const aliasSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const appSchema = z.enum(['codex', 'claude', 'dsh']);
const idSchema = z.string().uuid();
const json = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function returnStatus(alias) {
  const route = store.db.prepare('SELECT source,destination,enabled,error FROM follows WHERE source=?').get(alias);
  const last = store.db.prepare('SELECT * FROM deliveries WHERE source=? AND destination=? ORDER BY createdAt DESC,rowid DESC LIMIT 1').get(alias, route?.destination || '');
  return { returnRoute: route ? { ...route, enabled: !!route.enabled } : { enabled: false }, lastReturn: last ? store.result(last) : null };
}
function questions(alias) {
  return store.db.prepare('SELECT id,kind,request,state FROM questions WHERE source=? ORDER BY rowid DESC LIMIT 30').all(alias).map(q => ({ ...q, request: JSON.parse(q.request) }));
}
function tool(name, description, schema, fn) {
  server.tool(name, description, schema, async args => {
    try { return json(await fn(args)); } catch (e) { return { ...json({ error: e.message }), isError: true }; }
  });
}
async function follow(source, destination, enabled = true) {
  const src = store.get(source), dst = store.get(destination);
  if (src.app !== 'dsh' || !['codex', 'claude'].includes(dst.app)) throw Error('自动回传只能从 DSH 发往已有的 Codex/Claude 对话');
  if (!enabled) {
    store.db.prepare('UPDATE follows SET enabled=0 WHERE source=?').run(source);
    store.db.prepare("UPDATE deliveries SET state='cancelled' WHERE source=? AND state='queued'").run(source);
    events.tick(); return { source, destination, enabled: false };
  }
  if (src.state === 'completed' || dst.state === 'completed') throw Error('已标记完成的对话不能开启自动回传');
  const old = store.db.prepare('SELECT * FROM follows WHERE source=?').get(source);
  if (old?.enabled && old.destination === destination) return { source, destination, enabled: true, unchanged: true };
  const snapshot = await readSession(src);
  store.follow(source, destination, JSON.stringify((snapshot.messages || []).filter(eligible).map(eventKey)));
  events.tick();
  return { source, destination, enabled: true, startsAfterCurrentHistory: true };
}

tool('talk_list', '列出原客户端中的对话。cwd 按精确目录筛选；Claude 列出正在运行的 Desktop Code 对话，Codex 列出近期本地任务。不绑定或恢复对话。', { app: appSchema, cwd: z.string().optional() }, async ({ app, cwd }) => ({ sessions: await listSessions(app, cwd), limit: app === 'codex' ? 200 : null }));
tool('talk_workspaces', '列出已有 DSH 工作区的精确名称和目录。只读，不创建或重命名工作区。在 talk_create 中使用 workspaceName 选择工作区。', {}, async () => ({ workspaces: (await listWorkspaces()).map(w => ({ workspaceId: w.workspaceId, name: w.title, cwd: w.path, conversationCount: w.sessionIds.length })) }));
tool('talk_bind', '将精确的已有对话和目录绑定到固定别名。用此工具绑定当前发起任务的 Codex/Claude 对话。不发送消息。', { alias: aliasSchema, app: appSchema, sessionId: z.string(), cwd: z.string() }, async ({ alias, app, sessionId, cwd }) => {
  cwd = canonical(cwd);
  const snapshot = await readSession({ app, sessionId, cwd });
  const target = store.bind(alias, app, sessionId, cwd, snapshot.pauseKey);
  return snapshot.status === 'paused' && target.state === 'active' ? store.control(alias, 'paused', snapshot.pauseKey) : target;
});
tool('talk_read', '读取原客户端状态、近期进度、最终回复、用户消息和问题。returnRoute 显示自动回传是否开启，lastReturn 显示最近回传回执；held 表示接收方暂存、尚未交给模型，不代表回传未开启，不得重发。桥接状态 paused 表示暂停，即使原客户端状态变化也需明确恢复。truncated=true 表示省略了较早历史；idle 只表示空闲，不代表审查通过。', { alias: aliasSchema }, async ({ alias }) => {
  const snapshot = await readSession(store.get(alias));
  const pending = questions(alias);
  return { conversation: delivery.observe(store.get(alias), snapshot), ...snapshot, nativeStatus: snapshot.status, status: snapshot.status === 'running' && pending.some(q => q.state === 'pending') ? 'needs_input' : snapshot.status, questions: pending, ...returnStatus(alias) };
});
tool('talk_send', '向已绑定的对话发送提示词和本地文件路径。同一 requestId 不会重复发送。接收方忙碌或暂时不可用时，消息持久保存到队列。发送结果不确定时绝不重发。文件保留在本机。', { destination: aliasSchema, requestId: idSchema, prompt: z.string().min(1).max(100000), files: z.array(z.string()).max(30).optional() }, async ({ destination, requestId, prompt, files = [] }) => {
  for (const file of files) if (!path.isAbsolute(file) || !fs.existsSync(file)) throw Error('每个文件都必须是本机已存在的绝对路径');
  // 保留已发送消息的固定格式，避免同一 requestId 重试时因翻译而改变内容指纹。
  const text = `[Agent talk message ${requestId}]\n${prompt}${files.length ? '\n\nLocal file paths:\n' + files.join('\n') : ''}`;
  if (Buffer.byteLength(text) > 120000) throw Error('消息超出桥接大小限制，请改为发送本地文档路径');
  return delivery.submit(destination, text, requestId);
});
tool('talk_create', '创建 DSH 原生对话。workspaceName 按精确名称选择已有 DSH 工作区，其目录作为 cwd；不指定工作区时需提供 cwd，对话进入未分组。同时提供两者时目录必须一致。默认开启自动回传：先绑定当前发起方 Codex/Claude 对话，再将别名填入 replyTo；创建成功即开启，无需额外调用 talk_follow。只有用户明确不要回传时才设置 autoReturn=false 并省略 replyTo；缺少目标会报错，不会静默关闭回传。相同别名和 ID 复用同一对话；调用 talk_send 前不会派发任务。', { alias: aliasSchema, app: z.literal('dsh').default('dsh'), cwd: z.string().optional(), workspaceName: z.string().min(1).max(255).optional(), requestId: idSchema, title: z.string().max(120).optional(), replyTo: aliasSchema.optional(), autoReturn: z.boolean().default(true) }, async ({ alias, app, cwd, workspaceName, requestId, title, replyTo, autoReturn }) => {
  if (autoReturn && !replyTo) throw Error('新建 DSH 对话默认开启自动回传。请先用 talk_bind 绑定当前发起对话，再提供 replyTo；只有用户明确不要回传时才传 autoReturn=false。');
  if (!autoReturn && replyTo) throw Error('autoReturn=false 与 replyTo 冲突；关闭回传时请省略 replyTo。');
  const location = resolveDshLocation(cwd, workspaceName, workspaceName === undefined ? [] : await listWorkspaces());
  cwd = location.cwd;
  const workspace = location.workspace;
  if (replyTo) {
    const receiver = store.get(replyTo);
    if (!['codex', 'claude'].includes(receiver.app) || receiver.state === 'completed') throw Error('replyTo 必须指向尚未标记完成的 Codex 或 Claude 对话');
  }
  let target = store.db.prepare('SELECT * FROM sessions WHERE alias=?').get(alias);
  if (target && (target.sessionId !== requestId || target.app !== app || target.cwd !== cwd || target.state === 'completed')) throw Error('此别名已被其他任务或已完成任务使用');
  if (!target || (workspace && !workspace.sessionIds.includes(target.sessionId))) {
    const result = await createSession(app, cwd, requestId, title, workspace?.workspaceId);
    target = store.bind(alias, app, result.sessionId, cwd);
  }
  if (autoReturn) await follow(alias, replyTo);
  else {
    const route = store.db.prepare('SELECT destination FROM follows WHERE source=? AND enabled=1').get(alias);
    if (route) await follow(alias, route.destination, false);
  }
  return { ...target, ...returnStatus(alias), ...(workspace ? { workspace: { workspaceId: workspace.workspaceId, name: workspace.title, cwd } } : {}) };
});
tool('talk_delivery_control', '暂停或恢复投递，或将审查通过的任务标记完成。暂停 DSH 时也会请求原客户端停止并取消排队中的提示；暂停桌面对话只会暂停桥接投递。明确设置 active 才会恢复原客户端停止后的投递。标记完成会关闭回传，不会归档。', { alias: aliasSchema, state: z.enum(['active', 'paused', 'completed']) }, async ({ alias, state }) => {
  const target = store.get(alias);
  const snapshot = state === 'active' ? await readSession(target) : null;
  const result = store.control(alias, state, snapshot?.pauseKey || target.resumeKey);
  if (state === 'paused' && target.app === 'dsh') {
    try { await dshCall('session/cancel', { sessionId: target.sessionId }); }
    catch { return { ...result, nativeCancellation: '尚未确认原客户端是否已停止；桥接保持暂停，请检查 DSH' }; }
  }
  events.tick(); return result;
});
tool('talk_outbox', '读取近期回执、自动回传错误和事件连接状态。queued 表示排队中，可以等待；unknown/sending/held 不得重发。observed 表示已在原客户端历史中读回完全一致的消息文本。', {}, () => ({
  deliveries: store.db.prepare('SELECT * FROM deliveries ORDER BY createdAt DESC LIMIT 50').all().map(r => ({ destination: r.destination, source: r.source, createdAt: r.createdAt, ...store.result(r) })),
  follows: store.db.prepare('SELECT source,destination,enabled,error FROM follows').all(), events: { connectedHere: !!events.clientId, error: events.error, owner: store.db.prepare('SELECT expiresAt FROM leases WHERE name=?').get('dsh-events') || null },
}));
tool('talk_follow', '将开启后新增的 DSH 最终回复、问题、异常结束和用户直接介入的消息回传给发起方 Codex/Claude 对话。接收方忙碌时等待，暂停后需明确恢复。至少一个 MCP 进程及相关原客户端须保持运行。', { source: aliasSchema, destination: aliasSchema, enabled: z.boolean().default(true) }, ({ source, destination, enabled }) => follow(source, destination, enabled));
tool('talk_questions', '读取 DSH 的普通问题和权限请求。普通问题可用 talk_answer 回答；需要用户决定时向用户提问。权限审批只能在 DSH Web 中处理。', { alias: aliasSchema }, ({ alias }) => { store.get(alias); return { questions: questions(alias), eventError: events.error }; });
tool('talk_answer', '回答指定的 DSH 普通问题，不支持代答权限审批。selected 填原始选项的精确标签，custom 可填写文字回答。相同答案不会重复提交。', { alias: aliasSchema, questionId: z.string().min(1), answers: z.array(z.object({ id: z.string(), selected: z.array(z.string()), custom: z.string().optional() })).min(1) }, ({ alias, questionId, answers }) => events.answer(alias, questionId, answers));

let polling = null, closing = false;
function poll() {
  if (closing) return;
  events.tick();
  // Every client session starts its own MCP process; only the lease holder polls.
  if (!store.lease('poll', events.owner)) return;
  if (!polling) polling = delivery.poll().catch(() => { /* Individual follow/receipt errors remain in the database. */ }).finally(() => { polling = null; });
}
await server.connect(new StdioServerTransport());
const timer = setInterval(poll, 3000); timer.unref(); poll();
async function close() {
  if (closing) return; closing = true; clearInterval(timer);
  await events.close(); await polling; store.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run('poll', events.owner);
  await closeAdapters(); await server.close(); store.close();
}
process.stdin.on('end', () => void close());
process.on('SIGINT', () => void close());
process.on('SIGTERM', () => void close());
