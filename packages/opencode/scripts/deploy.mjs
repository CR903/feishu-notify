/**
 * scripts/deploy.mjs — 把本包的插件**复制**到 opencode 的 live 插件目录
 *
 *   node scripts/deploy.mjs            # 备份（仅首次）→ 临时文件 → rename 原子替换
 *   node scripts/deploy.mjs --check    # 只比对哈希，不写任何东西（漂移闸门，进 npm test）
 *   node scripts/deploy.mjs --dry-run  # 打印将要做的事，不写
 *
 * ## 为什么是"复制"而不是符号链接（R11 的教训）
 *
 * `opencode-mnemon-plugin` 用的是符号链接（编辑仓库即编辑生产、无第二份副本）。
 * 代价在 2026-10-18 被真实付过一次：仓库改名后 `~/.local/bin/feishu-notify-cli` 变成**悬空链接**，
 * 发送端于是 exit 2、通知**静默**失效 —— 链接这种东西坏了不报错，只是"东西不见了"。
 *
 * 本包因此选择复制：live 文件是独立副本，不会因为仓库移动/改名而悬空。
 * 代价是**可能漂移**（改了仓库忘了部署）→ 由 `--check` 的哈希闸门兜住（接进 `npm test`）。
 *
 * ## 退出码（`--check` 的三种结果要能区分，测试据此决定"失败"还是"本机未部署"）
 *
 *   0 = 与包内文件逐字节相同（`--check`）/ 部署成功（写入模式）
 *   1 = 漂移 / 用法错误 / 源文件缺失 / 目标是目录 —— 都是要人去处理的失败
 *   2 = live 文件**不存在**（从未部署过）—— 不是漂移，测试只在 live 存在时才把闸门当真
 *
 * ## 文件系统契约（`.trellis/spec/opencode-plugin/filesystem-truth.md`）
 *
 * - 先读源、再碰目标：目标若是符号链接，写穿它会改到别的文件上去
 * - `lstat` 看"这个路径是什么"，`readlink`/`readFile` 各有各的用途，别混
 * - 临时文件放在**同目录**，`rename` 只在同一文件系统上原子
 * - 比对用**字节**，不用时间戳（`touch` 不算变化）
 * - 备份**只建一次**：`*.pre-package.bak` 是"迁移前那份"的回滚点，第二次运行绝不能把它覆盖成
 *   已部署版本（否则回滚点被自己的部署吃掉）
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..');
export const SOURCE = join(PACKAGE_ROOT, 'src', 'feishu-notify.ts');
export const BACKUP_SUFFIX = '.pre-package.bak';

/** live 插件文件：`FEISHU_NOTIFY_OPENCODE_PLUGINS` 可覆盖（测试、非标准布局） */
export function targetPath(env = process.env) {
  const override = env.FEISHU_NOTIFY_OPENCODE_PLUGINS;
  if (typeof override === 'string' && override.trim() !== '') return override.trim();
  const home = env.HOME && env.HOME.trim() !== '' ? env.HOME : homedir();
  const base = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(base, 'opencode', 'plugins', 'feishu-notify.ts');
}

export const EXIT = { ok: 0, drift: 1, notDeployed: 2 };

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** 目标已存在时的权限沿用；符号链接的 lstat 权限没有意义（是 0755 的链接），一律用 0644 */
function fileMode(existing) {
  if (!existing || existing.isSymbolicLink()) return 0o644;
  return existing.mode & 0o777;
}

/**
 * 只读检查：live 与包内文件是否一致。**不写任何东西**（`--check` 与测试都用它）。
 * @returns {{status:'in-sync'|'drift'|'not-deployed'|'refuse', exit:number, source:{path:string,hash:string,size:number}, target:{path:string,hash:string|null,size:number|null,kind:string}, detail?:string}}
 */
export function checkSync({ env = process.env } = {}) {
  const target = targetPath(env);

  let payload;
  try {
    if (!statSync(SOURCE).isFile()) throw new Error('not a file');
    payload = readFileSync(SOURCE);
  } catch (error) {
    return {
      status: 'refuse',
      exit: EXIT.drift,
      source: { path: SOURCE, hash: '-', size: 0 },
      target: { path: target, hash: null, size: null, kind: 'unknown' },
      detail: `源文件不可读：${SOURCE}（${error?.message ?? error}）`,
    };
  }

  const source = { path: SOURCE, hash: sha256(payload), size: payload.length };
  const existing = lstatSync(target, { throwIfNoEntry: false });

  if (!existing) {
    return { status: 'not-deployed', exit: EXIT.notDeployed, source, target: { path: target, hash: null, size: null, kind: 'absent' } };
  }
  if (existing.isDirectory()) {
    return {
      status: 'refuse',
      exit: EXIT.drift,
      source,
      target: { path: target, hash: null, size: null, kind: 'directory' },
      detail: '目标是目录，拒绝递归/删除（删目录不是本脚本该做的事）',
    };
  }
  if (existing.isSymbolicLink()) {
    // R11：符号链接会随仓库移动而悬空，而悬空是**静默**失效。所以链接本身就是漂移，
    // 即使它当前指向的内容恰好一致 —— "看起来对"和"结构上安全"是两件事。
    return {
      status: 'drift',
      exit: EXIT.drift,
      source,
      target: { path: target, hash: null, size: null, kind: 'symlink' },
      detail: 'live 是符号链接（R11：仓库一动就悬空、且悬空不报错）→ 跑 `npm run deploy` 换成真实副本',
    };
  }

  const live = readFileSync(target); // 跟随普通文件；上面已排除链接
  const targetInfo = { path: target, hash: sha256(live), size: live.length, kind: 'file' };
  return { status: live.equals(payload) ? 'in-sync' : 'drift', exit: live.equals(payload) ? EXIT.ok : EXIT.drift, source, target: targetInfo };
}

/**
 * 写入模式：备份（仅首次）→ 临时文件 → rename 原子替换 → 读回自检。
 * @returns {{status:'deployed'|'in-sync'|'refuse', exit:number, ...}}
 */
export function deploy({ env = process.env, dryRun = false } = {}) {
  const target = targetPath(env);
  const before = checkSync({ env });

  if (before.status === 'refuse') return before;
  if (before.status === 'in-sync') return { ...before, status: 'in-sync' };

  const payload = readFileSync(SOURCE); // 先读源：目标若是链接，写穿它会改到别的文件
  const existing = lstatSync(target, { throwIfNoEntry: false });
  const backup = `${target}${BACKUP_SUFFIX}`;
  const backupExists = lstatSync(backup, { throwIfNoEntry: false }) !== undefined;
  const notes = [];

  if (dryRun) {
    return {
      ...before,
      status: 'deployed',
      exit: EXIT.ok,
      dryRun: true,
      backup: backupExists ? backup : existing ? backup : null,
      notes: [
        `将把 ${SOURCE} 写到 ${target}`,
        backupExists
          ? `备份已存在，保留不动：${backup}`
          : existing
            ? `先备份到：${backup}`
            : '目标不存在，无需备份',
      ],
    };
  }

  mkdirSync(dirname(target), { recursive: true });

  // 备份只建一次：它是"迁移前那份"的回滚点，不能被后续部署覆盖
  let backupPath = null;
  if (existing && !backupExists) {
    writeFileSync(backup, readFileSync(target), { mode: fileMode(existing) });
    backupPath = backup;
  }

  // 同目录临时文件 + rename：目标在任一时刻都不会"消失"（unlink 再写会有这个窗口）
  const mode = fileMode(existing);
  const tmp = `${target}.deploy-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, payload, { mode });
    chmodSync(tmp, mode); // umask 之外再保险一次
    renameSync(tmp, target); // 目标若是符号链接，rename 替换**链接本身**，不写穿
  } catch (error) {
    rmSync(tmp, { force: true });
    return { ...before, status: 'refuse', exit: EXIT.drift, detail: `写入失败：${error?.message ?? error}` };
  }

  const after = checkSync({ env });
  if (after.status !== 'in-sync') {
    return { ...after, status: 'refuse', exit: EXIT.drift, detail: `写回后自检不通过（live 与包内文件不一致）—— 请手动核对 ${target}` };
  }
  if (existing?.isSymbolicLink()) notes.push('live 原本是符号链接：已替换为真实副本（R11）');
  if (backupExists) notes.push(`备份已存在，保留不动：${backup}`);
  else if (backupPath) notes.push(`迁移前副本已备份：${backupPath}`);
  else notes.push('目标不存在，无需备份');

  return { ...after, status: 'deployed', exit: EXIT.ok, previous: before.target, backup: backupPath ?? (backupExists ? backup : null), notes };
}

// ---------------------------------------------------------------- CLI

const MARK = { 'in-sync': '✓', drift: '✗', 'not-deployed': '·', refuse: '✗', deployed: '✓' };

function report(result) {
  const lines = [`feishu-notify opencode 插件部署检查（${result.status}）`];
  lines.push(`  包内：${result.source.path}`);
  lines.push(`        sha256 ${result.source.hash}  ${result.source.size}B`);
  lines.push(`  live：${result.target.path}`);
  lines.push(`        ${result.target.hash ? `sha256 ${result.target.hash}  ${result.target.size}B` : `（不存在 · kind=${result.target.kind}）`}`);
  if (result.previous) {
    lines.push(`  变更前 live：sha256 ${result.previous.hash ?? '-'}`);
  }
  if (result.notes) for (const note of result.notes) lines.push(`  · ${note}`);
  if (result.detail) lines.push(`  ${MARK[result.status] ?? '✗'} ${result.detail}`);
  return lines.join('\n');
}

function usage() {
  return [
    '用法: node scripts/deploy.mjs [--check | --dry-run]',
    '',
    '  （无参数）    备份（仅首次）→ 临时文件 → rename 原子替换 live 插件',
    '  --check       只比对字节哈希，不写任何东西（漂移闸门）',
    '  --dry-run     打印将要做的事，不写',
    '',
    `  源：${SOURCE}`,
    `  目标：${targetPath()}（FEISHU_NOTIFY_OPENCODE_PLUGINS 可覆盖）`,
    '  退出码：0 一致/成功 · 1 漂移/拒绝 · 2 live 不存在（从未部署）',
    '',
    `  回滚：cp -p <live>${BACKUP_SUFFIX} <live>`,
  ].join('\n');
}

function main(argv) {
  const args = new Set(argv);
  if (args.has('--help') || args.has('-h')) {
    console.log(usage());
    return EXIT.ok;
  }
  const unknown = argv.filter((arg) => !['--check', '--dry-run'].includes(arg));
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(' ')}\n\n${usage()}`);
    return EXIT.drift;
  }

  const check = args.has('--check');
  const result = check ? checkSync() : deploy({ dryRun: args.has('--dry-run') });
  const out = report(result);
  if (result.exit === EXIT.ok) console.log(out);
  else console.error(out);

  if (check && result.status === 'not-deployed') {
    console.error('  （live 不存在 = 本机从未部署此插件，不是漂移；部署：node scripts/deploy.mjs）');
  }
  if (check && result.status === 'drift') {
    console.error('  修法：node scripts/deploy.mjs（会先备份成 *.pre-package.bak）');
  }
  return result.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
