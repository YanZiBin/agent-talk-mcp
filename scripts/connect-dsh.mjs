import { exchangeLogin, writePrivate, authFile } from '../src/dsh-auth.mjs';
process.umask(0o077);
try {
  let value = ''; for await (const chunk of process.stdin) { value += chunk; if (value.length > 4096) throw Error('输入内容过长'); }
  writePrivate(authFile(), await exchangeLogin(value.trim()));
  console.log('已保存本地 DSH 登录凭据，未输出 token。');
} catch { console.error('DSH 登录失败，请检查本地启动地址。未输出任何凭据。'); process.exitCode = 1; }
