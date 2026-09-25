import path from 'node:path';
import { projectRoot, writePrivate, ensureDshAuth } from './dsh-auth.mjs';

// ponytail: one DSH Web instance; use separate credential paths if multiple instances are needed.
// Loaded by the user's DSH Web profile. No signing secret or permission settings are read.
export const name = 'agent-talk-auth';
export const inject = ['connection', 'webServer'];
export function apply(ctx) {
  const baseUrl = `http://127.0.0.1:${ctx.webServer.port}`;
  writePrivate(path.join(projectRoot, '.local/dsh-login.json'), {
    baseUrl, loginUrl: ctx.connection.authenticatedUrl(baseUrl),
  });
  // Keep credentials fresh for MCP processes already running an older adapter, too.
  const refresh = () => void ensureDshAuth().catch(() => ctx.logger.warn('Agent talk 凭据刷新失败，稍后会重试。未记录任何凭据。'));
  refresh();
  const timer = setInterval(refresh, 3600000); timer.unref();
  ctx.on('dispose', () => clearInterval(timer));
}
