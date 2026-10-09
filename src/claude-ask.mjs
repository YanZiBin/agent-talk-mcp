import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Store } from './store.mjs';
import { Delivery } from './delivery.mjs';

// Started by a headless Claude CLI worker through --mcp-config; the answer arrives through talk_answer in the dispatcher's MCP process.
process.umask(0o077);
const alias = process.env.AGENT_TALK_ALIAS, store = new Store(process.env.AGENT_TALK_DB), delivery = new Delivery(store);
const server = new McpServer({ name: 'agent-talk-worker', version: '0.5.0' });
const text = (value, isError = false) => ({ content: [{ type: 'text', text: value }], ...(isError ? { isError } : {}) });
server.tool('talk_ask', '向派活方（发起任务的 Codex 对话）提问，并等待对方回答后继续。需要派活方或用户做决定时调用，不要用结束本轮的方式提问。options 可填候选答案；不填时对方直接用文字回答。', { question: z.string().min(1).max(20000), options: z.array(z.string().min(1).max(200)).max(10).optional() }, async ({ question, options = [] }) => {
  const route = store.db.prepare('SELECT destination FROM follows WHERE source=? AND enabled=1').get(alias);
  if (!route) return text('自动回传未开启，派活方收不到问题。请按自己的判断继续，并在最终回复里说明需要的决定。', true);
  const id = randomUUID(), request = { questions: [{ id: 'q', question, options: options.map(label => ({ label })) }] };
  store.db.prepare("INSERT INTO questions VALUES(?,?,'claude-cli','question',?,'pending',NULL)").run(id, alias, JSON.stringify(request));
  delivery.enqueueEvent(alias, route.destination, `question:${id}`, `Claude CLI 正在等待回答。请用 talk_questions 读取 ${alias} 的问题，再用 talk_answer 回答，questionId 为 ${id}，答案 id 为 q。如果需要用户决定，请向用户提问。\n${JSON.stringify(request.questions)}`);
  // Only waits while a question is open: one primary-key read per second.
  for (;;) {
    await sleep(1000);
    const row = store.db.prepare('SELECT state,answer FROM questions WHERE id=?').get(id);
    if (row.state === 'submitted') { const [a] = JSON.parse(row.answer).answers; return text([...a.selected, a.custom].filter(Boolean).join('\n')); }
    if (row.state === 'closed') return text('此问题已关闭，任务已被暂停或结束。', true);
  }
});
await server.connect(new StdioServerTransport());
process.stdin.on('end', () => { store.close(); process.exit(0); });
