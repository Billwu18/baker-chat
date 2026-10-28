# 「测试的测试」：证明那些全绿的测试真的能红。
#
# ## 为什么需要这个文件
#
# BAKER 的测试曾经出现过一种假绿 —— 把两条真 bug 种回源码，四个入口探针的
# 打包产物 **md5 逐字节不变**。也就是说那些探针根本没有 import 产品代码，
# 它们全绿不代表产品正确。断言「全绿」毫无价值，直到有人证明它能红。
#
# 所以这个脚本把**已知会重现真实症状**的改动一条条种进源码、跑对应的自检、
# 要求它必须是红的，然后原样还原。种进去的都是**真 bug 而不是语法错误**，
# 而且都属于「正常路径上看不出来」那一类 —— 类型检查、别的测试、界面全照过。
#
# 判据是反的：
#
#   改坏之后自检**红了**  → 这条不变式有人在守（守住）
#   改坏之后自检**照样全绿** → 那条不变式其实没人测（漏掉）
#
# 所以这个脚本红，不代表产品坏了，而是代表**有一句话我们写进了注释却没写进测试**。
#
# ## 为什么变异表在 JSON 里
#
# 1.x 的这张表是 20 个 PowerShell 哈希字面量（A–T），每个都要跟四种转义规则
# 打架：反引号、`$`、单双引号、换行。改一处要数三遍引号，而且改错了要等到
# 运行时「找不到变异点」才知道。现在表在 tools/mutations.json 里，看一眼就是原文。
#
# ## 为什么要 -Clean 预检
#
# 每一处变异都是「改文件 → 跑测试 → 还原」，这一串**不是原子的**：跑到一半被
# Ctrl+C、被工具超时掐掉、或者机器断电，变异就留在源码里了。而因为脚本再也
# 没有跑完过，没有任何地方会告诉你这件事。
#
# 真出过一次：`auth 帧不带 x` 留在 websocket.ts 里，之后所有静态检查、
# 单元测试、探针都照过，只有集成探针连不上服务器（4003 bad signature），
# 而它的失败信息里没有一个字提到 websocket.ts。
#
# ## 为什么每改一处要重打一次包
#
# esbuild 是把源码整份打包进产物的。改完不重打，跑的还是上一次那份 ——
# 于是每条都会「漏掉」，而脚本会一本正经地报告「15 条不变式都没人守」。
# 这不是假设，是最容易犯的那个错，所以每轮都强制重新打包。
#
#   pwsh -File tools/mutation-check.ps1            # 全跑
#   pwsh -File tools/mutation-check.ps1 -Only fold # 只跑 id 或文件名含 fold 的
#
# 会临时改写源码；用 try/finally 保证还原（即使断言失败、即使中途 Ctrl+C）。
#
# ## 为什么「还原」本身也要被验证
#
# try/finally 只在**进程还活着**的时候管用。跑到一半被掐掉（工具超时、关窗口、
# 断电），变更就留在源码里，而且因为脚本再也没跑完过，没有任何东西会告诉你 ——
# 开跑前的锚点预检能发现「上一轮的残留」，但它只在**下一轮启动时**才起作用，
# 中间那段时间你看到的是一份被改坏的源码。
#
# 所以现在开跑前把每个会被动到的文件**逐字节**存一份，收尾时逐字节比回去，
# 对不上就明确报出来并且让整轮失败。「还原后回到绿」这句话必须有东西在证明它。
#
# ## 为什么硬超时是必须的
#
# `$TimeoutSec` 以前声明了却全文没用。挂住的 suite 会**永久挂起**，而它挂在哪
# 一条上，源码就停在**那一条的变异态**里 —— 超时保护不是性能问题，是正确性问题。
#
# ## 为什么日志要落盘
#
# check-all 每个 suite 都写 `.tmp/*.log`，这个脚本以前只在控制台刷屏：
# 「守住 20/20」事后无法审计，也没法回答「上个月这条到底是谁守住的」。
#
# ## 为什么 `-KeepGoing` 没有了
#
# 它原来的实现在最后一步是 `if ($KeepGoing) { exit 0 }` —— 也就是「有不变式没人守」
# 的情况下退出码仍然是 0。一个把失败报成成功的开关不该存在；循环本来就是跑完全部
# 条目的，这个开关没有任何正面作用。
[CmdletBinding()]
param(
    [string]$Only = '',
    [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$tmp = Join-Path $repo '.tmp'
if (-not (Test-Path -LiteralPath $tmp)) { New-Item -ItemType Directory -Path $tmp | Out-Null }

# 和 `tools/check-all.ps1` 一样：用仓库本地的 node_modules/.bin，不走 `npx`
# （这台机器上没装 npm，npx 根本不存在；而且 npx 可能去问注册表版本）。
$localBin = Join-Path $repo 'node_modules\.bin'
if (Test-Path -LiteralPath $localBin) { $env:Path = "$localBin;$env:Path" }

# 全文落盘，供事后审计（check-all 每个 suite 都写 .tmp/*.log，这边以前只在控制台刷屏）。
$logPath = Join-Path $tmp 'mutation-check.log'
try { Start-Transcript -LiteralPath $logPath -Force | Out-Null } catch {
    Write-Host "（写不进 $logPath 的转录：$_ —— 继续跑，只是这一轮没有留档）" -ForegroundColor DarkYellow
}

# ---------------------------------------------------------------- 读写源码

$script:SourceBom = @{}

function Read-SourceText {
    <# 完整读一个源码文件，返回文本。
       为什么不用 Get-Content：Windows PowerShell 5.1 的 Get-Content 按**系统 ANSI**
       （简体中文机器上是 GBK）读，而这些源码里有中文注释 —— 读进来就是乱码。
       只难看也就算了，要命的是每一处 finally 都会把内存里那份**写回文件**，
       等于把整个文件的中文永久改坏。pwsh 7 默认 UTF-8，所以一直没暴露。

       顺带把「原来有没有 BOM」按路径记在 $script:SourceBom 里，Write-SourceText 写回时照原样。 #>
    param([string]$path)
    $bytes = [IO.File]::ReadAllBytes($path)
    $bom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
    $script:SourceBom[$path] = $bom
    $text = [Text.Encoding]::UTF8.GetString($bytes)
    if ($bom) { $text = $text.TrimStart([char]0xFEFF) }
    return $text
}

function Write-SourceText {
    <# 按 UTF-8 写回源码，BOM 照 Read-SourceText 记下的原样。
       （Set-Content 在 pwsh 7 下写 UTF-8 无 BOM，会把原本带 BOM 的文件的 BOM 抹掉。） #>
    param([string]$path, [string]$text)
    $bom = $false
    if ($script:SourceBom.ContainsKey($path)) { $bom = $script:SourceBom[$path] }
    $enc = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($bom)
    [IO.File]::WriteAllText($path, $text, $enc)
}

function Invoke-NodeSuite {
    <# 跑一个打包产物，带**硬超时**。
       返回 @{ TimedOut; ExitCode; Output }。

       为什么不用 `& node ...`：那样挂住就是真的挂住。挂在哪一条上，源码就停在
       那一条的变异态里，而 finally 永远不会执行 —— 超时保护在这里是正确性需求，
       不是「跑快点」。#>
    param([string]$bundle, [int]$timeoutSec)
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'node'
    $psi.ArgumentList.Add($bundle)
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $psi.WorkingDirectory = $repo
    $p = [Diagnostics.Process]::Start($psi)
    # 先挂上异步读再等退出：否则输出超过管道缓冲区时子进程会卡在写、我们卡在等。
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $exited = $p.WaitForExit($timeoutSec * 1000)
    if (-not $exited) {
        try { $p.Kill($true) } catch { }
        return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = '' }
    }
    [void]$outTask.Wait(5000)
    [void]$errTask.Wait(5000)
    $text = ''
    if ($outTask.IsCompleted) { $text += $outTask.Result }
    if ($errTask.IsCompleted) { $text += $errTask.Result }
    return [pscustomobject]@{ TimedOut = $false; ExitCode = $p.ExitCode; Output = $text }
}

function Invoke-CargoSuite {
    <# 跑 `cargo test --lib`，同样带硬超时。
       Rust 侧的变异必须重编译才能生效，所以这一步天然比 TS 慢
       （一次约 5-15 秒），条数要克制。 #>
    param([int]$timeoutSec)
    $psi = [Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = 'cargo'
    $psi.ArgumentList.Add('test')
    $psi.ArgumentList.Add('--lib')
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    $psi.WorkingDirectory = (Join-Path $repo 'src-tauri')
    $p = [Diagnostics.Process]::Start($psi)
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    $exited = $p.WaitForExit($timeoutSec * 1000)
    if (-not $exited) {
        try { $p.Kill($true) } catch { }
        return [pscustomobject]@{ TimedOut = $true; ExitCode = -1; Output = '' }
    }
    [void]$outTask.Wait(5000)
    [void]$errTask.Wait(5000)
    $text = ''
    if ($outTask.IsCompleted) { $text += $outTask.Result }
    if ($errTask.IsCompleted) { $text += $errTask.Result }
    return [pscustomobject]@{ TimedOut = $false; ExitCode = $p.ExitCode; Output = $text }
}

# Rust 侧的「抓住」在输出里长这样，和 TS 的 FAIL 不是同一个词。
$RustFailPattern = 'FAILED|panicked at'

# ---------------------------------------------------------------- 变异表

$tablePath = Join-Path $PSScriptRoot 'mutations.json'
if (-not (Test-Path -LiteralPath $tablePath)) {
    Write-Host '找不到 tools/mutations.json' -ForegroundColor Red
    exit 1
}

# 用 ReadAllText 而不是 Get-Content：这份 JSON 里全是中文（同一个坑，见 Read-SourceText）。
$table = [IO.File]::ReadAllText($tablePath) | ConvertFrom-Json
$all = @($table.mutations)

$picked = if ($Only) {
    @($all | Where-Object { $_.id -like "*$Only*" -or $_.file -like "*$Only*" -or $_.suite -like "*$Only*" })
} else {
    $all
}
if ($picked.Count -eq 0) {
    Write-Host "没有匹配 -Only '$Only' 的变异" -ForegroundColor Yellow
    exit 1
}

Write-Host "`n=== 变异检查：$($picked.Count) 条（表里共 $($all.Count) 条）===" -ForegroundColor Cyan

# ---------------------------------------------------------------- 干净度预检
#
# 上一次没跑完会把变异留在文件里，而不会有任何东西告诉你。开跑前先自己的表
# 跟每个文件对一遍：每条 find 必须**恰好**出现一次。
$rotted = @()

foreach ($m in $picked) {
    $target = Join-Path $repo $m.file
    if (-not (Test-Path -LiteralPath $target)) {
        Write-Host "  [锚点失效] $($m.id) —— 找不到 $($m.file)" -ForegroundColor Red
        $rotted += $m.id
        continue
    }
    $text = Read-SourceText $target
    $count = ([regex]::Matches($text, [regex]::Escape([string]$m.find))).Count
    if ($count -ne 1) {
        # 找不到或者找到多处都算失效 —— 「跳过一条」和「通过一条」在日志里长得太像了。
        Write-Host "  [锚点失效] $($m.id) —— find 在 $($m.file) 里出现 $count 次（要恰好 1 次）" -ForegroundColor Red
        $rotted += $m.id
    }
}

if ($rotted.Count -gt 0) {
    Write-Host "`n有 $($rotted.Count) 条锚点对不上源码。先把 tools/mutations.json 改对再跑 ——" -ForegroundColor Red
    Write-Host '源码改过之后，变异表会安静地失效，而这正是它最不该失效的时候。' -ForegroundColor Yellow
    exit 1
}
Write-Host '  锚点全部对齐 ✓' -ForegroundColor Green

# ---------------------------------------------------------------- 干净快照
#
# try/finally 只在进程还活着时管用。开跑前把每个会被动到的文件逐字节存一份，
# 收尾时比回去 —— 「还原后回到绿」这句话必须有东西在证明它。
$pristine = @{}
foreach ($m in $picked) {
    $target = Join-Path $repo $m.file
    if (-not $pristine.ContainsKey($target) -and (Test-Path -LiteralPath $target)) {
        $pristine[$target] = [IO.File]::ReadAllBytes($target)
    }
}

# ---------------------------------------------------------------- 基线
#
# 先确认干净代码是绿的，否则下面「红了」说明不了任何问题。
Write-Host "`n--- 基线（干净代码必须绿）---" -ForegroundColor Cyan

# 与 `tools/check-all.ps1` 保持一致：把 `@tauri-apps/api` 指到自检替身上，
# 否则 `tauri-net-selftest` 会在打包阶段就失败（真身依赖 window/Tauri）。
# 用绝对路径（正斜杠）而不是 `./tools/...`，因为这个脚本不该依赖「从仓库根调用」。
$stubTauri = (Join-Path $PSScriptRoot 'stub-tauri.ts') -replace '\\', '/'
$esbuildAliases = @(
    "--alias:@tauri-apps/api/core=$stubTauri"
    "--alias:@tauri-apps/api/event=$stubTauri"
)

$suites = @($picked | Select-Object -ExpandProperty suite -Unique)
$baseline = @{}
foreach ($s in $suites) {
    if ($s -eq 'rust') {
        # Rust 侧：没有「打包」这一步，变异靠重编译生效。
        $out = (Invoke-CargoSuite -timeoutSec ([Math]::Max($TimeoutSec, 300)))
        if ($out.TimedOut) {
            Write-Host "  ★ 基线：cargo test --lib 跑不完（超过 $([Math]::Max($TimeoutSec, 300)) 秒）" -ForegroundColor Red
            Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
            exit 1
        }
        if ($out.ExitCode -ne 0) {
            Write-Host '  ★ 基线就是红的（rust），变异检查没有意义' -ForegroundColor Red
            ($out.Output -split "`r?`n" | Select-Object -Last 15) |
                ForEach-Object { Write-Host "    $($_.TrimEnd())" -ForegroundColor Red }
            Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
            exit 1
        }
        $baseline[$s] = $true
        Write-Host '  rust 绿 ✓' -ForegroundColor Green
        continue
    }
    $bundle = Join-Path $tmp "mut-$s.mjs"
    $suiteSrc = Join-Path $PSScriptRoot "$s.ts"
    Remove-Item -LiteralPath $bundle -ErrorAction SilentlyContinue
    esbuild $suiteSrc --bundle --format=esm --platform=node --outfile=$bundle @esbuildAliases 2>&1 | Out-Null
    # 判「打包成没成」看的是**产物在不在**，不是 $LASTEXITCODE。
    # 试过：exit code 是 0，而文件根本没生成 —— 于是下一句 node 报
    # MODULE_NOT_FOUND，日志上看起来像「基线就是红的」，实际是没打出来。
    if (-not (Test-Path -LiteralPath $bundle)) {
        Write-Host "  ★ $s 打包没有产出（$bundle）—— 先修好再谈变异" -ForegroundColor Red
        exit 1
    }
    $out = (Invoke-NodeSuite -bundle $bundle -timeoutSec $TimeoutSec)
    if ($out.TimedOut) {
        Write-Host "  ★ 基线跑了 $TimeoutSec 秒还没结束（$s）—— 它挂住了，先查这个" -ForegroundColor Red
        Write-Host '    （挂住的 suite 会让整轮停在这里，剩下的条目一条都跑不到）' -ForegroundColor DarkYellow
        Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
        exit 1
    }
    if ($out.ExitCode -ne 0) {
        Write-Host "  ★ 基线就是红的（$s），变异检查没有意义" -ForegroundColor Red
        # 不筛 'FAIL' 行 —— 崩掉（比如 import 出错）的产物根本没有 FAIL 行，
        # 只筛的话日志上会是一片空白，看不出到底是崩了还是断言失败。
        ($out.Output -split "`r?`n" | Select-Object -Last 15) |
            ForEach-Object { Write-Host "    $($_.TrimEnd())" -ForegroundColor Red }
        Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
        exit 1
    }
    $baseline[$s] = $true
    Write-Host "  $s 绿 ✓" -ForegroundColor Green
}

# ---------------------------------------------------------------- 逐条种变异

$caught = @()
$survived = @()
$invalid = @()

foreach ($m in $picked) {
    $target = Join-Path $repo $m.file
    $suite = [string]$m.suite
    $bundle = Join-Path $tmp "mut-$suite.mjs"
    $suiteSrc = Join-Path $PSScriptRoot "$suite.ts"

    Write-Host "`n--- $($m.id) ---" -ForegroundColor Cyan
    Write-Host "  $($m.what)" -ForegroundColor DarkGray

    $original = Read-SourceText $target
    $ok = $false
    $broken = $false
    $detail = ''
    $isRust = ($suite -eq 'rust')
    try {
        Write-SourceText $target $original.Replace([string]$m.find, [string]$m.replace)

        if ($isRust) {
            # 没有打包这一步：`cargo test` 自己会重编译。
            $runOut = Invoke-CargoSuite -timeoutSec ([Math]::Max($TimeoutSec, 300))
            if ($runOut.TimedOut) {
                $broken = $true
                $detail = "cargo test 跑了 $([Math]::Max($TimeoutSec, 300)) 秒还没结束"
            }
            else {
                $failLine = ($runOut.Output -split "`r?`n" | Where-Object { $_ -match $RustFailPattern } | Select-Object -First 1)
                if ($runOut.ExitCode -ne 0 -and $failLine) {
                    $ok = $true
                    $detail = $failLine.Trim()
                }
                elseif ($runOut.ExitCode -ne 0) {
                    $broken = $true
                    $detail = '非零退出，但一行 FAILED/panicked 都没有（编译错或环境问题，不是断言抓住的）'
                }
                else {
                    $detail = 'cargo test 照样全绿'
                }
            }
        }
        else {
        # 必须**先**改源码再打包：反过来的话打进产物里的是干净版本，
        # 于是永远绿，看上去像「这个不变式不值得测」。
        $buildOut = & esbuild $suiteSrc --bundle --format=esm --platform=node --outfile=$bundle @esbuildAliases 2>&1 | Out-String
        if ($LASTEXITCODE -ne 0) {
            # 打包失败**不算守住**。
            #
            # 这里原来写的是「打包失败也算红」，理由是「改坏的代码多半根本
            # 编译不过」—— 但那正好把这条检查的意义抹掉了：把源码改成语法
            # 错误，不需要任何断言被执行就能计入「守住」。于是一条早就没人
            # 测的不变式，只要它的 find/replace 恰好把代码改崩，就会永远
            # 显示成绿的。这不是安全网，这是把安全网的破洞漆成绿色。
            #
            # 正确语义是：变异必须**编译得过**、然后**被断言抓住**。编译不过
            # 说明这个变异本身是坏的，它既没证明测试有用，也不该被忽略 ——
            # 单独列出来，让整轮失败。
            $broken = $true
            $detail = '打包失败（变异本身编译不过，它证明不了测试有没有用）'
        }
        else {
            $runOut = Invoke-NodeSuite -bundle $bundle -timeoutSec $TimeoutSec
            if ($runOut.TimedOut) {
                # 挂住既不是「守住」也不是「漏掉」，是这条变异把 suite 卡死了。
                $broken = $true
                $detail = "跑了 $TimeoutSec 秒还没结束（把 suite 卡住了）"
            }
            else {
                # 判据除了退出码，还要**真的有一行 FAIL**。
                #
                # 只看退出码的话，「断言抓住了」和「进程崩了 / 环境抽风」在日志上
                # 都是「非零退出」，长得一模一样；而 suite 里确实有依赖等待
                # （p2p-node-selftest 用 50/600/400ms 的 settle），偶发失败会把
                # 一条其实没人守的不变式记成「守住」——于是这个脚本存在的意义
                # 正好被它自己的判据抹掉。
                $failLine = ($runOut.Output -split "`r?`n" | Where-Object { $_ -match 'FAIL' } | Select-Object -First 1)
                if ($runOut.ExitCode -ne 0 -and $failLine) {
                    $ok = $true
                    $detail = $failLine.Trim()
                }
                elseif ($runOut.ExitCode -ne 0) {
                    $broken = $true
                    $detail = '非零退出，但一行 FAIL 都没有（是崩了，不是断言抓住的）'
                }
                else {
                    $detail = "$suite 照样全绿"
                }
            }
        }
        }
    }
    catch {
        $broken = $true
        $detail = "跑的时候炸了：$_"
    }
    finally {
        # 无论如何都还原。
        Write-SourceText $target $original
    }

    if ($broken) {
        $invalid += [pscustomobject]@{ Mutation = $m; Detail = $detail }
        Write-Host "  [无效] $detail" -ForegroundColor Magenta
        Write-Host '         → 这条变异自己就是坏的，换一个改法' -ForegroundColor DarkYellow
    }
    elseif ($ok) {
        $caught += $m.id
        Write-Host "  [守住] $detail" -ForegroundColor Green
    }
    else {
        $survived += $m
        Write-Host "  [漏掉] $($m.file) 改坏之后 $suite 全绿" -ForegroundColor Red
        Write-Host '         → 这句话只写在注释里，没人测' -ForegroundColor DarkYellow
    }
}

# ---------------------------------------------------------------- 汇总

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  守住 $($caught.Count) / 漏掉 $($survived.Count) / 无效 $($invalid.Count)" -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan

if ($invalid.Count -gt 0) {
    Write-Host "`n无效的变异（自己编译不过，一条断言都没跑到）：" -ForegroundColor Magenta
    foreach ($x in $invalid) {
        Write-Host "  BROKEN  $($x.Mutation.id)" -ForegroundColor Magenta
        Write-Host "          $($x.Detail)" -ForegroundColor DarkGray
        Write-Host "          $($x.Mutation.file) → $($x.Mutation.suite)" -ForegroundColor DarkGray
    }
}

if ($survived.Count -gt 0) {
    Write-Host "`n漏掉的不变式（写进注释了，但没人测）：" -ForegroundColor Red
    foreach ($m in $survived) {
        Write-Host "  FAIL  $($m.id)" -ForegroundColor Red
        Write-Host "        $($m.what)" -ForegroundColor DarkGray
        Write-Host "        $($m.file) → $($m.suite)" -ForegroundColor DarkGray
    }
}

# ---------------------------------------------------------------- 还原校验
#
# 收尾比一次字节。try/finally 只保证「进程活着时」会写回，而被工具超时掐掉、
# 关窗口、断电都不在它的保护范围里 —— 那时源码就停在最后一条的变异态上，
# 而且不会有任何东西告诉你。
$dirty = @()
foreach ($path in $pristine.Keys) {
    $now = [IO.File]::ReadAllBytes($path)
    $before = $pristine[$path]
    $same = ($now.Length -eq $before.Length)
    if ($same) {
        for ($i = 0; $i -lt $now.Length; $i++) {
            if ($now[$i] -ne $before[$i]) { $same = $false; break }
        }
    }
    if (-not $same) { $dirty += $path }
}

if ($dirty.Count -gt 0) {
    Write-Host "`n★ 有 $($dirty.Count) 个文件没有还原回去（逐字节比对不一致）：" -ForegroundColor Red
    foreach ($path in $dirty) {
        Write-Host "    $($path.Substring($repo.Length + 1))" -ForegroundColor Red
    }
    Write-Host '  源码现在停在被改坏的状态。先把它改回来，再跑任何别的东西。' -ForegroundColor Yellow
    Write-Host '  （开跑前的锚点预检**下一轮**才会发现这种残留，中间这段时间没有护栏。）' -ForegroundColor DarkYellow
}

Write-Host "`n（全文日志：$(Split-Path -Leaf $logPath)）" -ForegroundColor DarkGray

if ($survived.Count -eq 0 -and $invalid.Count -eq 0 -and $dirty.Count -eq 0) {
    Write-Host "`n每条不变式都有人在守，$($pristine.Count) 个文件逐字节还原一致。" -ForegroundColor Green
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
    exit 0
}

Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
exit 1
