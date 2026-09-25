import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

export const projectRoot = path.resolve(import.meta.dirname, '..');
export const authFile = () => process.env.AGENT_TALK_DSH_AUTH || path.join(projectRoot, '.local/dsh-auth.json');
export const loginFile = () => process.env.AGENT_TALK_DSH_LOGIN || path.join(projectRoot, '.local/dsh-login.json');
export function localOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.search || u.hash || u.pathname !== '/') throw Error('DSH 必须使用本机回环 HTTP 地址');
  return u.origin;
}
export function readPrivate(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('DSH 凭据文件必须属于当前用户，且权限为 600');
    try { return JSON.parse(fs.readFileSync(fd, 'utf8')); }
    catch { throw Error('DSH 凭据文件格式无效，未记录其中内容'); }
  } finally { fs.closeSync(fd); }
}
export function writePrivate(file, data) {
  const dir = path.dirname(file); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('DSH 凭据目录必须属于当前用户，且权限为 700');
  const temp = path.join(dir, `.auth-${randomUUID()}.tmp`);
  try { fs.writeFileSync(temp, JSON.stringify(data), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function dshAuth() {
  const config = readPrivate(authFile()); localOrigin(config.baseUrl);
  if (typeof config.cookie !== 'string' || /[\r\n]/.test(config.cookie)) throw Error('DSH Cookie 无效');
  return config;
}
export function cookieExpiry(cookie) {
  try {
    const value = cookie.split(';').map(x => x.trim()).find(x => x.startsWith('dsh-auth-')).split('=').slice(1).join('=');
    const exp = JSON.parse(Buffer.from(value.split('.')[1], 'base64url')).expiresAt;
    return Number.isSafeInteger(exp) ? exp : 0;
  } catch { return 0; }
}
export async function exchangeLogin(loginUrl) {
  let url;
  try { url = new URL(loginUrl); localOrigin(url.origin); }
  catch { throw Error('本地 DSH 登录地址无效'); }
  if (url.username || url.password || url.pathname !== '/' || url.hash || url.searchParams.getAll('token').length !== 1 || !url.searchParams.get('token')) throw Error('本地 DSH 登录地址无效');
  let response;
  try { response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
  catch { throw Error('DSH 登录不可用，未记录凭据'); }
  const cookie = response.headers.getSetCookie().filter(x => x.startsWith('dsh-auth-')).map(x => x.split(';')[0]).join('; ');
  if (response.status !== 303 || !cookie || cookieExpiry(cookie) <= Date.now()) throw Error('DSH 登录失败，请检查凭据桥接扩展是否正在运行');
  return { baseUrl: url.origin, cookie, expiresAt: cookieExpiry(cookie) };
}
let refreshing;
export async function ensureDshAuth(force = false) {
  let auth, source;
  try { auth = dshAuth(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { source = readPrivate(loginFile()); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!source) {
    if (auth && !force && cookieExpiry(auth.cookie) > Date.now()) return auth;
    throw Error('DSH 凭据需要续期，请启用本地 DSH 凭据桥接扩展');
  }
  const baseUrl = localOrigin(source.baseUrl);
  let login; try { login = new URL(source.loginUrl); } catch { throw Error('DSH 凭据交接信息无效'); }
  if (login.origin !== baseUrl) throw Error('DSH 凭据交接信息中的服务地址不一致');
  const generation = createHash('sha256').update(source.loginUrl).digest('hex');
  if (!force && auth && auth.baseUrl === baseUrl && auth.generation === generation && cookieExpiry(auth.cookie) > Date.now() + 12 * 3600000) return auth;
  if (!refreshing) refreshing = (async () => {
    const fresh = { ...await exchangeLogin(source.loginUrl), generation };
    writePrivate(authFile(), fresh); return fresh;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function openDshSocket() {
  let auth = await ensureDshAuth();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const ws = new WebSocket(`${auth.baseUrl}/api/remote.mux`, { headers: { Cookie: auth.cookie } });
        const timer = setTimeout(() => { ws.close(); reject(Error('DSH WebSocket 握手超时')); }, 10000);
        ws.onopen = () => { clearTimeout(timer); resolve(ws); };
        ws.onerror = () => { clearTimeout(timer); reject(Error('DSH WebSocket 握手失败')); };
        ws.onclose = () => { clearTimeout(timer); reject(Error('DSH WebSocket 已关闭')); };
      });
    } catch {
      if (attempt) throw Error('认证续期后 DSH WebSocket 仍不可用');
      // Only the connection handshake is retried; no stream/RPC message has been sent.
      auth = await ensureDshAuth(true);
    }
  }
}
