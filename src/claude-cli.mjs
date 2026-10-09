import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { eventId } from './delivery.mjs';
import { claudeHistory } from './adapters.mjs';

const instructions = '你是通过 agent-talk 接收任务的后台执行者，没有人在看这个终端，任务由一个 Codex 对话派发。需要派活方或用户做决定时，调用 talk_ask 提问并等待回答，不要靠结束本轮来提问。完成后，最后一条回复写清楚结果、改动和未决事项，它会原样回传给派活方。';

// Headless `claude -p` worker: one process per turn, at most one per conversation; the result returns when the process exits.
export class ClaudeCli {
  constructor(store) { this.store = store; this.delivery = null; this.children = new Map(); this.closing = false; }
  row(alias) { return this.store.db.prepare('SELECT * FROM claude_cli WHERE alias=?').get(alias); }
  read(target) {
    const run = this.row(target.alias);
    return { status: run.status, pauseKey: run.status === 'paused' ? String(run.endedAt) : null, endReason: run.lastResult ? JSON.parse(run.lastResult) : null };
  }
  history(target) {
    return this.row(target.alias).initialized ? claudeHistory(target.sessionId) : { progress: [], messages: [], truncated: false };
  }
  start(target, text, requestId) {
    const alias = target.alias, run = this.row(alias);
    // The conditional update is the per-conversation lock, shared by every MCP process.
    if (!this.store.db.prepare("UPDATE claude_cli SET status='running',pid=NULL,stopping=0,startedAt=? WHERE alias=? AND status!='running'").run(Date.now(), alias).changes) {
      return { state: 'busy', detail: 'Claude CLI 仍在执行上一条消息；尚未发送' };
    }
    const mcp = { mcpServers: { agent_talk_worker: { type: 'stdio', command: process.execPath, args: [path.join(import.meta.dirname, 'claude-ask.mjs')], env: { AGENT_TALK_DB: this.store.file, AGENT_TALK_ALIAS: alias } } } };
    const args = ['-p', '--output-format', 'stream-json', '--verbose', run.initialized ? '--resume' : '--session-id', target.sessionId,
      '--dangerously-skip-permissions', '--disallowedTools', 'AskUserQuestion', 'mcp__agent-talk__*', '--mcp-config', JSON.stringify(mcp),
      '--append-system-prompt', instructions, ...(run.model ? ['--model', run.model] : []), ...(run.effort ? ['--effort', run.effort] : [])];
    // talk_ask blocks until Codex answers, so the stdio idle timeout (30 minutes by default) is turned off.
    const child = spawn(process.env.AGENT_TALK_CLAUDE_BIN || 'claude', args, { cwd: target.cwd, env: { ...process.env, CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT: '0' } });
    let result = null, stderr = '';
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let m; try { m = JSON.parse(line); } catch { return; }
      if (m.type === 'system' && m.subtype === 'init') this.store.db.prepare('UPDATE claude_cli SET initialized=1 WHERE alias=?').run(alias);
      if (m.type === 'result') result = m;
    });
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-2048); });
    child.stdin.on('error', () => { /* The exit code and stderr explain an early exit. */ });
    return new Promise(resolve => {
      child.once('error', e => {
        if (child.pid) return;
        this.store.db.prepare('UPDATE claude_cli SET status=? WHERE alias=?').run(run.status, alias);
        resolve({ state: 'refused', detail: `无法启动 Claude CLI（${e.code}），请检查 claude 命令或 AGENT_TALK_CLAUDE_BIN` });
      });
      child.once('spawn', () => {
        this.store.db.prepare('UPDATE claude_cli SET pid=? WHERE alias=?').run(child.pid, alias);
        // Receipt and route errors stay in the database, as in the poll loop.
        const done = new Promise(ok => child.once('close', (code, signal) => ok(this.finish(alias, requestId, result, code, signal, stderr).catch(() => {}))));
        this.children.set(alias, { child, done });
        child.stdin.end(text);
        resolve({ state: 'accepted', detail: 'Claude CLI 已启动，执行尚未完成' });
      });
    });
  }
  async finish(alias, requestId, result, code, signal, stderr) {
    this.children.delete(alias);
    const db = this.store.db, stopped = this.row(alias).stopping;
    const status = this.closing ? 'failed' : stopped ? 'paused' : result?.subtype === 'success' && !result.is_error ? 'idle' : 'failed';
    const summary = { subtype: result?.subtype ?? null, isError: result?.is_error ?? null, errors: result?.errors, numTurns: result?.num_turns, costUsd: result?.total_cost_usd, permissionDenials: result?.permission_denials?.length, exitCode: code, signal, ...(result ? {} : { stderr }), ...(this.closing ? { detail: '桥接进程已退出，任务被中断' } : {}) };
    db.prepare('UPDATE claude_cli SET status=?,pid=NULL,stopping=0,endedAt=?,lastResult=? WHERE alias=?').run(status, Date.now(), JSON.stringify(summary), alias);
    // A question nobody can answer any more is closed, together with its queued notice.
    const route = db.prepare('SELECT destination FROM follows WHERE source=? AND enabled=1').get(alias);
    for (const q of db.prepare("SELECT id FROM questions WHERE source=? AND state='pending'").all(alias)) {
      db.prepare("UPDATE questions SET state='closed' WHERE id=?").run(q.id);
      if (route) this.store.queuedReceipt(eventId(alias, route.destination, `question:${q.id}`), { state: 'cancelled', detail: 'Claude CLI 已结束，此问题已关闭' });
    }
    if (this.closing) return;
    if (route) {
      const denied = result?.permission_denials?.length ? `\n（有 ${result.permission_denials.length} 次工具调用被拒绝，详见 talk_read 的 endReason）` : '';
      const text = status === 'idle' ? `最终回复:\n${result.result}${denied}` : `运行事件:\n${status === 'paused' ? '已按暂停请求中断' : 'Claude CLI 异常结束'}\n${JSON.stringify(summary)}`;
      await this.delivery.deliver(this.delivery.enqueueEvent(alias, route.destination, `run:${requestId}`, text));
    }
    // A message that arrived while this turn ran is sent now instead of waiting for the next poll.
    const next = db.prepare("SELECT id FROM deliveries WHERE destination=? AND state='queued' ORDER BY createdAt LIMIT 1").get(alias);
    if (next) await this.delivery.deliver(next.id);
  }
  stop(alias) {
    const run = this.row(alias);
    if (run.status !== 'running') return;
    this.store.db.prepare('UPDATE claude_cli SET stopping=1 WHERE alias=?').run(alias);
    // SIGINT ends the turn; SIGTERM would leave it unfinished.
    const own = this.children.get(alias);
    if (own) { own.child.kill('SIGINT'); return; }
    // Started by another MCP process; a pid that is gone means a stale lock, which this stop clears.
    try { process.kill(run.pid, 'SIGINT'); }
    catch { this.store.db.prepare("UPDATE claude_cli SET status='paused',pid=NULL,stopping=0,endedAt=? WHERE alias=?").run(Date.now(), alias); }
  }
  async closeAll() {
    this.closing = true;
    for (const { child } of this.children.values()) child.kill('SIGINT');
    await Promise.all([...this.children.values()].map(c => c.done));
  }
}
