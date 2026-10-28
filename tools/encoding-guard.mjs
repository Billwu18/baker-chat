#!/usr/bin/env node
// 编码护栏 —— 防的是一类**完全没有报错、只表现成乱码**的故障。
//
// 背景（真的踩到过）：
//
//   `tools/*.ps1` 里全是中文提示。Windows PowerShell 5.1（系统自带那个，
//   新机器上默认就是它）**没有 BOM 就按 ANSI 读** .ps1。文件是 UTF-8，
//   于是「权限 : 管理员」变成「鏉冮檺 : 绠＄悊鍛?」——不只是显示难看，
//   乱码字节会真的把解析器带偏（`Unexpected token '}'`），脚本根本跑不起来。
//   pwsh 7 默认按 UTF-8 读，所以**用 pwsh 测是测不出来的**。
//
// 同一个坑的第二面：用 5.1 的 `Get-Content` 读本项目自己的 UTF-8 文件
// （package.json 之类）也按 ANSI 解，中文一乱码就会吃掉引号，
// 让 `ConvertFrom-Json` 报一个看起来像「JSON 坏了」的假错。
// 两种故障都只在 5.1 上出现，而 5.1 正是别人机器上的那个。
//
// 这个文件里查的都是**语法层面查不出、跑起来也不报错**的东西，
// 所以它有存在的必要：它红的时候，说明有人会在自己机器上遇到一个我们看不见的故障。
//
// 1.x 时这里还查 `server/deploy/*.ps1`、`server/deploy/*.cmd` 和 install.ps1
// 里那段启动器模板。服务器那一整条链路删掉之后，那些目标都不存在了，
// 对应的小节也一起走了 —— 现在只剩 tools/ 下的 .ps1。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const BOM = [0xef, 0xbb, 0xbf];
let failures = 0;

function fail(msg) {
  failures += 1;
  console.log(`FAIL ${msg}`);
}

function pass(msg) {
  console.log(`ok   ${msg}`);
}

/** 扫一个目录下的 .ps1（不存在就跳过，不当失败）。 */
function ps1FilesIn(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ps1'))
    .map((f) => join(dir, f));
}

// ---------------------------------------------------------------- 1. .ps1 必须有 BOM
//
// 仓库根也查一遍，不能只盯 tools/：`tools/check-all.ps1` 曾经在一次编辑里
// 丢了 BOM，护栏照样报「全部合格」，直到用 5.1 跑它才炸出
// `Unexpected token '}'` —— 而 5.1 正是目标机器上的那个。
// 判据和受众都一模一样（中文注释 + 5.1 按 ANSI 读），没有理由只保住一半。
{
  const all = [...ps1FilesIn(join(root, 'tools')), ...ps1FilesIn(root)];

  if (all.length === 0) {
    fail('一个 .ps1 都没找到 —— 目录是不是被搬走了？');
  }

  for (const path of all) {
    const rel = path.slice(root.length + 1).replace(/\\/g, '/');
    const buf = readFileSync(path);
    const hasBom = buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2];
    const text = buf.toString('utf8');

    if (!hasBom) {
      fail(
        `${rel} 没有 UTF-8 BOM —— Windows PowerShell 5.1 会按 ANSI 读它，` +
          `中文全变乱码、脚本直接解析失败。加 BOM：把文件存成 "UTF-8 with BOM"。`,
      );
      continue;
    }
    // 带 BOM 还出现 U+FFFD，说明文件本身就是坏的 UTF-8，不是读取方式的问题。
    if (text.includes('\uFFFD')) {
      fail(`${rel} 内容里有 U+FFFD —— 文件本身不是合法 UTF-8，已经坏了`);
      continue;
    }
    const nonAscii = [...text].filter((c) => c.codePointAt(0) > 127).length;
    pass(`${rel} 有 BOM，${nonAscii} 个非 ASCII 字符（中文提示靠它才对）`);
  }
}

// ------------------------------- 2. .ps1 里不许用 Get-Content 读本项目自己的文件
//
// 查法：先把每行的双/单引号字符串和 `#` 注释挖掉，再看还剩不剩 `Get-Content` ——
// 这样 `Write-Host "… Get-Content …"` 这类**提示文案**不会被误判。
// `<# ... #>` 块注释整段跳过（那里正解释着为什么不用 Get-Content，
// 以及本文件顶部那段背景）。
{
  const psFiles = ps1FilesIn(join(root, 'tools'));

  for (const path of psFiles) {
    const rel = path.slice(root.length + 1).replace(/\\/g, '/');
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    const hits = [];
    let inBlockComment = false;
    lines.forEach((line, i) => {
      if (inBlockComment) {
        if (line.includes('#>')) inBlockComment = false;
        return;
      }
      if (line.includes('<#')) {
        const rest = line.slice(line.indexOf('<#') + 2);
        if (!rest.includes('#>')) { inBlockComment = true; return; }
      }
      const code = line
        .replace(/"[^"]*"/g, '""')   // 挖掉双引号字符串
        .replace(/'[^']*'/g, "''")   // 挖掉单引号字符串
        .replace(/#.*$/, '');        // 挖掉行尾注释
      if (/\bGet-Content\b/.test(code)) hits.push(i + 1);
    });
    if (hits.length > 0) {
      fail(
        `${rel}:${hits.join(',')} 用了 Get-Content —— Windows PowerShell 5.1 按 ANSI 读，` +
          `读本项目自己写的 UTF-8 文件（package.json / 日志）` +
          `会把中文读成乱码，甚至让 ConvertFrom-Json 报假的“JSON 坏了”。` +
          `改用 [IO.File]::ReadAllText / ReadAllLines（无条件 UTF-8）。`,
      );
    } else {
      pass(`${rel} 没用 Get-Content 读自家文件（5.1 不会读成乱码）`);
    }
  }
}

// ---------------------------------------------------------------- 收尾
console.log('');
if (failures > 0) {
  console.log(`=== encoding-guard: ${failures} 处不合格 ===`);
  process.exit(1);
}
console.log('=== encoding-guard: 全部合格 ===');
