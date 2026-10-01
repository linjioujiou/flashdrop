// 一键初始化 Cloudflare 资源：R2 桶 / D1 数据库 / 数据表 / 管理令牌
// 用法：npm run setup   （需先 npx wrangler login）
import { execSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

const BUCKET = 'flashdrop-files';
const DB = 'flashdrop';

function run(args, { input } = {}) {
  const r = spawnSync('npx', args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', input, env: { ...process.env, CI: 'true' } });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function step(name, fn) {
  process.stdout.write(`\n==> ${name} ... `);
  try { const r = fn(); console.log('完成'); return r; }
  catch (e) { console.log('失败'); throw e; }
}

console.log('闪传 FlashDrop 初始化（将创建 Cloudflare 资源并部署）');

step('检查 wrangler 登录状态', () => {
  const r = run(['wrangler', 'whoami']);
  if (r.code !== 0 || /not authenticated/i.test(r.out)) {
    throw new Error('尚未登录 Cloudflare，请先执行: npx wrangler login');
  }
});

step(`创建 R2 桶 ${BUCKET}`, () => {
  const r = run(['wrangler', 'r2', 'bucket', 'create', BUCKET]);
  if (r.code !== 0 && !/already exists|已有/i.test(r.out)) throw new Error(r.out);
});

step(`创建 D1 数据库 ${DB}`, () => {
  const r = run(['wrangler', 'd1', 'create', DB]);
  if (r.code !== 0 && !/already exists/i.test(r.out)) throw new Error(r.out);
  const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(r.out);
  if (!m) throw new Error('无法从输出中解析 database_id，请手动填写 wrangler.toml\n' + r.out);
  let toml = fs.readFileSync('wrangler.toml', 'utf8');
  if (toml.includes('REPLACE_WITH_D1_UUID')) {
    toml = toml.replace('REPLACE_WITH_D1_UUID', m[1]);
    fs.writeFileSync('wrangler.toml', toml);
    console.log(`\n    database_id = ${m[1]}`);
  }
});

step('初始化远端数据表', () => {
  const r = run(['wrangler', 'd1', 'execute', DB, '--remote', '--file=./schema.sql']);
  if (r.code !== 0) throw new Error(r.out);
});

let adminToken;
step('设置 ADMIN_TOKEN 管理令牌', () => {
  const saved = '.admin-token.txt';
  if (fs.existsSync(saved)) {
    adminToken = fs.readFileSync(saved, 'utf8').trim();
    console.log(`\n    复用已保存的令牌（${saved}）`);
  } else {
    adminToken = randomBytes(24).toString('hex');
    fs.writeFileSync(saved, adminToken);
    console.log(`\n    新令牌已保存到 ${saved}，请妥善保管`);
  }
  const r = run(['wrangler', 'secret', 'put', 'ADMIN_TOKEN'], { input: adminToken + '\n' });
  if (r.code !== 0) throw new Error(r.out);
});

let adminPassword;
step('设置 ADMIN_PASSWORD 后台登录密码', () => {
  const saved = '.admin-credentials.txt';
  if (fs.existsSync(saved)) {
    try {
      const j = JSON.parse(fs.readFileSync(saved, 'utf8'));
      if (j.password && j.token === adminToken) { adminPassword = j.password; console.log(`\n    复用已保存的密码（${saved}）`); return; }
    } catch {}
  }
  // 可读性较好的随机密码（大小写字母 + 数字，避开易混淆字符）
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(14);
  adminPassword = [...bytes].map(b => alphabet[b % alphabet.length]).join('');
  fs.writeFileSync(saved, JSON.stringify({ token: adminToken, password: adminPassword }, null, 2));
  console.log(`\n    新密码已保存到 ${saved}，请妥善保管`);
  const r = run(['wrangler', 'secret', 'put', 'ADMIN_PASSWORD'], { input: adminPassword + '\n' });
  if (r.code !== 0) throw new Error(r.out);
});

step('部署到 Cloudflare Workers', () => {
  const r = run(['wrangler', 'deploy']);
  if (r.code !== 0) throw new Error(r.out);
  const url = /https:\/\/[^\s]+\.workers\.dev/.exec(r.out);
  console.log(`\n\n  ✅ 部署完成${url ? `: ${url[0]}` : ''}`);
  console.log(`     前台:       ${url ? url[0] : ''}/`);
  console.log(`     管理后台:   ${url ? url[0] : ''}/admin`);
  console.log(`     登录密码:   ${adminPassword}  （见 .admin-credentials.txt）`);
  console.log(`     API 令牌:   ${adminToken}  （见 .admin-token.txt）`);
  console.log('\n  建议（可选）：在 Cloudflare 控制台为 R2 桶 flashdrop-files 配置生命周期规则，');
  console.log('  对前缀 files/ 的对象在 7 天后自动删除，作为应用层自动删除之外的双保险。\n');
});
