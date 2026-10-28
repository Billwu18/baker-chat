<#
  所有自检的总入口。

  跑法：`npm test`（等价于 `pwsh -File tools/check-all.ps1`）。

  ## 和 1.x 那一版的差别

  1.x 这个脚本里有一大半在启服务器、等端口、跑 `server/` 下面的东西。服务器
  和公网那一整条链路已经删了（P2P 转向），所以那些步骤连同 `server/` 目录
  一起走了。现在四段，全部是**本机就能跑完**的：

    1. 类型检查        —— 前端 + 工具脚本
    2. TS 自检         —— tools/*-selftest.ts，esbuild 打成一个 mjs 再 node 跑
    3. 护栏            —— CSS 同名类、文件编码（都是「不报错但会出错」的那类）
    4. Rust 侧         —— src-tauri 的 cargo test --lib

  ## 为什么每个自检都单独起一个 node 进程

  它们是各自的 `main()` + `process.exit`。合成一个进程跑，任一个里忘了处理的
  异步会把别的拖挂，而且「哪个文件红的」要看半天。分开跑还能并行。

  ## -SkipRust / -SkipTs

  改前端时不想等 cargo，改 Rust 时不想等 esbuild，各给一个开关。

  ## -Release（报告 T2）

  `cargo test --lib` 走的是 dev profile。`Cargo.toml` 的 `[profile.release]`
  里有 `lto = true`、`codegen-units = 1`、`panic = "abort"`、`strip = true`，
  这些都可能让**只有 release 才编得出来的问题**藏到发版那天：平时 23 项全绿，
  `desktop:build` 一跑才发现编不过。默认不跑（一次一分多钟，塞进日常 `npm test`
  就会有人开始 -Skip），`-Release` 时插一步 `cargo build --release`。

  **这一步不产出可发布的 exe。** 实测同一份代码：
    - `cargo build --release`      → 3.09 MB，**前端资源没嵌进去**，双击开不出界面；
    - `npx tauri build --no-bundle` → 27.29 MB，资源在（`index-*.js` / `baker://net`
      都能在字节里找到），这才是能发的那份。
  所以 `-Release` 回答的是「release profile 编不编得过」，不是「能不能发」。
  发版走 `npx tauri build` 之后再用 `tools/make-client-portable.ps1` 打包
  （它自己会拦 dist 陈旧、会扫 exe 里有没有 `remote-debugging-port`）。

  ## 不在这里的那一项：变异检查

  `npm run test:mutation` 是单独跑的，故意不挂进这里。它会**改写源码**再还原，
  一旦中途被打断（Ctrl+C、工具超时、断电）就会把一处变异留在文件里 ——
  而那种状态最坏的地方在于它**看不出来**：类型检查、自检、界面全照过。

  更实际的理由是它根本不属于这个阶段：这里回答「东西对不对」，变异检查回答
  「这些断言有没有用」。前者每次改代码都该跑，后者只在改测试和改动安全相关的
  代码之后才需要跑 —— 一次十几条、每条都要重打包，塞进来会让 `npm test` 从
  二十几秒变成一分多钟，然后大家开始加 `-Skip`，最后没人跑。
#>

[CmdletBinding()]
param(
  [switch]$SkipRust,
  [switch]$SkipTs,
  [switch]$SkipGuards,
  [switch]$NoParallel,
  [switch]$Release
)

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$tmp = Join-Path $root '.tmp'
if (-not (Test-Path -LiteralPath $tmp)) { New-Item -ItemType Directory -Path $tmp | Out-Null }

# 工具链一律用**仓库本地的** `node_modules\.bin`，不走 `npx`。
#
# 两个理由：`npx` 在没装 npm 的机器上根本不存在（这台开发机就是 —— 只有一个
# node.exe，连 npm 都没有），而 `npx` 还可能顺手去注册表问一嘴版本，离线环境
# 会一直卡到超时。本地的 tsc / esbuild 就是 package-lock 锁定的那一份，更确定，
# 也快（省掉 npx 的 shell 包装）。
$localBin = Join-Path $root 'node_modules\.bin'
if (Test-Path -LiteralPath $localBin) { $env:Path = "$localBin;$env:Path" }

$script:results = @()

function Write-Head([string]$text) {
  Write-Host ''
  Write-Host "──── $text" -ForegroundColor Cyan
}

function Write-Detail([string]$text, [string]$color = 'Gray') {
  Write-Host "     $text" -ForegroundColor $color
}

# 记一条结果。$Code 是进程退出码，0 才算过。
function Add-Result([string]$name, [int]$Code, [double]$Seconds) {
  $script:results += [pscustomobject]@{
    Name    = $name
    Ok      = ($Code -eq 0)
    Code    = $Code
    Seconds = [math]::Round($Seconds, 2)
  }
  $tag = if ($Code -eq 0) { 'ok  ' } else { 'FAIL' }
  $color = if ($Code -eq 0) { 'Green' } else { 'Red' }
  Write-Host ("  [{0}] {1}  ({2}s)" -f $tag, $name, [math]::Round($Seconds, 2)) -ForegroundColor $color
}

# 跑一条外部命令，把它的输出收下来：过了只留一行，红了把全文倒出来。
# 直接让它往控制台喷的话，红的绿的全混在一起，「哪一行是哪个失败的原因」就没了。
function Invoke-Captured([string]$name, [scriptblock]$body, [string]$logName) {
  $log = Join-Path $tmp $logName
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $code = 0
  try {
    & $body 2>&1 | Out-File -LiteralPath $log -Encoding utf8
    $code = if ($null -eq $LASTEXITCODE) { 0 } else { $LASTEXITCODE }
  } catch {
    $_ | Out-String | Add-Content -LiteralPath $log -Encoding utf8
    $code = 1
  }
  $sw.Stop()
  Add-Result $name $code $sw.Elapsed.TotalSeconds
  if ($code -ne 0) {
    Write-Detail "日志：$log" 'DarkGray'
    # 用 [IO.File]::ReadAllLines 而不是 Get-Content —— 后者在 Windows PowerShell 5.1
    # 下默认按系统 ANSI 读，日志里的中文提示会变成乱码（见 tools/encoding-guard.mjs）。
    [IO.File]::ReadAllLines($log) | Select-Object -Last 40 | ForEach-Object {
      Write-Host "       $_" -ForegroundColor DarkYellow
    }
  }
  return $code
}

# ---------------------------------------------------------------- 0. 预检

Write-Head '0. 环境'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Detail '找不到 node —— 后面的都跑不了。' 'Red'; exit 1 }
Write-Detail "node $(& node --version)"
Write-Detail "工作目录 $root"

# cargo 经常装了但没进 PATH（用户目录下那种）。这里按需补一次，
# 而不是要求谁去改系统环境变量。
$cargoOnPath = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargoOnPath) {
  foreach ($candidate in @(
      (Join-Path $env:USERPROFILE '.cargo\bin'),
      (Join-Path $env:CARGO_HOME 'bin')
    ) | Where-Object { $_ }) {
    if (Test-Path -LiteralPath (Join-Path $candidate 'cargo.exe')) {
      $env:PATH = "$candidate;$env:PATH"
      Write-Detail "cargo 不在 PATH 上，已补上 $candidate" 'Yellow'
      break
    }
  }
}
$cargoOk = [bool](Get-Command cargo -ErrorAction SilentlyContinue)
if ($cargoOk) { Write-Detail "cargo $(& cargo --version)" }
elseif (-not $SkipRust) { Write-Detail '找不到 cargo —— Rust 那一段会失败。' 'Yellow' }

# ---------------------------------------------------------------- 1. 类型检查

if (-not $SkipTs) {
  Write-Head '1. 类型检查（tsc --noEmit × 2）'

  # 两份配置，两个世界：
  #   src   —— 浏览器。跑在这里的代码不该认识 `process` / `Buffer`。
  #   tools —— Node。探针要 `process.exit` / `Buffer` / `node:crypto`。
  # 只跑第一份的话，7 个探针（几千行断言）**从来没有被类型检查过** ——
  # esbuild 只转译不检查，一个写错的字段名在那里只会变成运行时的 undefined，
  # 而断言「undefined !== true」永远是绿的。这不是假想：改成两份之后立刻
  # 抳出 10 处，其中一处是恒真的断言。
  Invoke-Captured 'typecheck' { tsc --noEmit } 'tsc.log' | Out-Null
  Invoke-Captured 'typecheck:tools' { tsc --noEmit -p tsconfig.tools.json } 'tsc-tools.log' | Out-Null
}

# ---------------------------------------------------------------- 2. TS 自检

if (-not $SkipTs) {
  Write-Head '2. TS 自检'

  # 只认 *-selftest.ts：名字里的 "selftest" 是有约定的 —— 探针（probe）允许
  # 连外部的东西，自检必须离线自足。这里按约定挑，不按目录扫。
  $selftests = Get-ChildItem -LiteralPath (Join-Path $root 'tools') -Filter '*-selftest.ts' -File |
    Sort-Object Name

  if ($selftests.Count -eq 0) {
    Write-Detail '（一个都没有）' 'Yellow'
  }

  $jobs = @()
  foreach ($file in $selftests) {
    $name = [IO.Path]::GetFileNameWithoutExtension($file.Name)
    $bundle = Join-Path $tmp "$name.mjs"

    # 打包失败要单独算一步失败 —— 否则报出来的是「node 跑了个不存在的文件」，
    # 真正的原因（tsc 不过）反而不见了。
    #
    # 两条 alias 把 `@tauri-apps/api` 指到自检替身上（`tools/stub-tauri.ts`）：
    # 真身没法在 node 里加载，这正是 `src/p2p/tauri-net.ts` 原来零测试的原因（报告 T4）。
    # 替身只记「调了什么」并让测试驱动回调，不模拟 Tauri。除 `tauri-net` / `tauri-log`
    # 之外没有别的模块 import 它，所以这两条 alias 对其余自检是空操作。
    $bundleOk = Invoke-Captured "打包 $name" {
      esbuild $file.FullName --bundle --format=esm --platform=node --outfile=$bundle `
        --alias:@tauri-apps/api/core=./tools/stub-tauri.ts `
        --alias:@tauri-apps/api/event=./tools/stub-tauri.ts
    } "esbuild-$name.log"

    if ($bundleOk -eq 0) {
      if ($NoParallel) {
        Invoke-Captured $name { node $bundle } "run-$name.log" | Out-Null
      } else {
        $jobs += [pscustomobject]@{ Name = $name; Bundle = $bundle }
      }
    }
  }

  # 并行跑：这些自检互相不认识（各自建自己的节点、自己的假网络），
  # 唯一的共享资源是 CPU。串行跑 20 秒，并行 7 秒。
  if ($jobs.Count -gt 0) {
    Write-Head '2b. TS 自检（并行执行）'
    $running = @()
    foreach ($job in $jobs) {
      $log = Join-Path $tmp "run-$($job.Name).log"
      $proc = Start-Process -FilePath 'node' -ArgumentList @($job.Bundle) `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
        -NoNewWindow -PassThru
      $running += [pscustomobject]@{ Name = $job.Name; Proc = $proc; Log = $log; Sw = [Diagnostics.Stopwatch]::StartNew() }
    }
    foreach ($item in $running) {
      $item.Proc.WaitForExit()
      $item.Sw.Stop()
      $code = $item.Proc.ExitCode
      if (Test-Path -LiteralPath "$($item.Log).err") {
        $errText = [IO.File]::ReadAllText("$($item.Log).err")
        if ($errText -and $errText.Trim()) { Add-Content -LiteralPath $item.Log -Value $errText -Encoding utf8 }
      }
      Add-Result $item.Name $code $item.Sw.Elapsed.TotalSeconds
      if ($code -ne 0) {
        Write-Detail "日志：$($item.Log)" 'DarkGray'
        [IO.File]::ReadAllLines($item.Log) | Select-Object -Last 40 | ForEach-Object {
          Write-Host "       $_" -ForegroundColor DarkYellow
        }
      }
    }
  }
}

# ---------------------------------------------------------------- 3. 护栏

if (-not $SkipGuards) {
  Write-Head '3. 护栏'

  foreach ($guard in @('css-guard.mjs', 'encoding-guard.mjs')) {
    $path = Join-Path $root "tools\$guard"
    if (-not (Test-Path -LiteralPath $path)) {
      # 原来这里是「没有就跳过」—— 于是删掉 $guard 之后 `npm test` 仍然 exit 0，
      # 「全绿」变成「什么都没查」。护栏自己也是被测对象：它消失必须变红。
      $script:results += [pscustomobject]@{
        Name    = "$([IO.Path]::GetFileNameWithoutExtension($guard))·缺失"
        Ok      = $false
        Code    = 127
        Seconds = 0
      }
      Write-Detail "没有 $guard —— 记一次失败（护栏不该静默消失）" 'Red'
      continue
    }
    $name = [IO.Path]::GetFileNameWithoutExtension($guard)
    Invoke-Captured $name { node $path } "guard-$name.log" | Out-Null
  }

  # 报告 T7 的另一半：`tools/*.mjs` 不在任何编译或引用的链子上 —— tsc 不看 `.mjs`，
  # 也没人 import 它们，所以一个纯语法错误可以静静躺着，直到你真的去跑它。
  # （典型受害者是 `check-leftover-mutations.mjs`：它只在「怀疑变异有残留」时才被
  # 想起来，而那一刻你最不想要的就是它自己先崩了。）
  $mjs = @(Get-ChildItem -LiteralPath (Join-Path $root 'tools') -Filter '*.mjs' -File)
  if ($mjs.Count -gt 0) {
    Invoke-Captured "tools/*.mjs 语法（$($mjs.Count) 个）" {
      $bad = @()
      foreach ($m in $mjs) {
        node --check $m.FullName
        if ($LASTEXITCODE -ne 0) { $bad += $m.Name }
      }
      if ($bad.Count -gt 0) { throw "语法不过：$($bad -join '、')" }
      Write-Host "$($mjs.Count) 个 .mjs 全部通过 node --check"
    } 'node-check-mjs.log' | Out-Null
  }
}

# ---------------------------------------------------------------- 4. Rust

if (-not $SkipRust) {
  Write-Head '4. Rust 侧'

  $tauri = Join-Path $root 'src-tauri'
  if (-not (Test-Path -LiteralPath $tauri)) {
    Write-Detail '没有 src-tauri 目录，跳过' 'Yellow'
  }
  elseif (-not $cargoOk) {
    Write-Detail '没有 cargo，跳过' 'Yellow'
  }
  else {
    # 先做一次 `cargo check --all-targets`。
    #
    # 这一步补的是一个真实的盲区（报告 T2）：`Cargo.toml` 里 `[lib] name="app_lib"`
    # 与 `src/main.rs` 是**两个 target**，而下面那个 `cargo test --lib` 只编译 lib。
    # 于是把 `lib.rs` 里的 `pub fn run` 改个名字，19 项全绿，可 `tauri build` 直接
    # 编译失败 —— 交付物能不能构建，和「测试全绿」之间原来没有任何连接。
    # `--all-targets` 把 bin 也编一遍（实测 1.5s，几乎是白送的）。
    #
    # 注意它**不替代** release 构建：`[profile.release]` 的 lto/panic=abort
    # 仍然没被编译过，那一条见报告 T2/T3（要真跑 `npm run desktop:build`）。
    Push-Location -LiteralPath $tauri
    try {
      Invoke-Captured 'cargo check --all-targets' { cargo check --all-targets } 'cargo-check.log' | Out-Null

      # --test-threads=4：默认的「有几个核起几个线程」在这里会放大竞争。
      # net 层那几个测试是真的在建 TCP 连接、真的在等 UDP 组播，并行度太高时
      # 端口和时序会互相干扰，失败信息还长得像产品 bug。
      Invoke-Captured 'cargo test --lib' { cargo test --lib -- --test-threads=4 } 'cargo-test.log' | Out-Null

      # -Release：把 `[profile.release]` 真的编一次（报告 T2）。
      #
      # 上面两步都走 dev profile，而交付物走的是 release —— `lto = "fat"` +
      # `panic = "abort"` 这两个设置从来没有被任何一项检查碰过。这类问题只在
      # 发版那天出现，而那天你最不想再多一个变量。默认关掉是因为 fat LTO
      # 一次几分钟（首次更久），塞进日常 `npm test` 只会让人开始加 -Skip。
      if ($Release) {
        # 用独立的 target-dir：`cargo build --release` 默认写到
        # `target\release\baker.exe`，而 `tauri build` 的产品 exe **也在那个路径**。
        # 两者的区别是前端资源嵌没嵌进去（27.29 MB vs 3.09 MB），一旦被覆盖，
        # 后面的 `make-client-portable.ps1 -SkipBuild` 会把 3 MB 那份当成产品发出去
        # —— 而它照样过了「exe 比 dist 新」和「扫调试开关」两道闸。
        Invoke-Captured 'cargo build --release' {
          cargo build --release --target-dir target/profile-check
        } 'cargo-release.log' | Out-Null
      }
    } finally {
      Pop-Location
    }
  }
}

# ---------------------------------------------------------------- 汇总

$total = $script:results.Count
$bad = @($script:results | Where-Object { -not $_.Ok })

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
foreach ($r in $script:results) {
  $color = if ($r.Ok) { 'Green' } else { 'Red' }
  Write-Host ("  {0,-28} {1,8}s  {2}" -f $r.Name, $r.Seconds, $(if ($r.Ok) { '通过' } else { "失败（exit $($r.Code)）" })) -ForegroundColor $color
}
Write-Host '============================================' -ForegroundColor Cyan

if ($bad.Count -eq 0) {
  Write-Host "全部通过（$total 项）" -ForegroundColor Green
  exit 0
}
Write-Host "失败 $($bad.Count) 项 / 共 $total 项" -ForegroundColor Red
exit 1
