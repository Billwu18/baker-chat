# ============================================================
#  打一个「客户端绿色版」——就是那一个 exe，双击就跑，不用装。
#
#  为什么会有这个脚本：客户端本来就只有一个 exe（Tauri 把整个前端嵌进
#  可执行文件里了），但它是躺在 src-tauri\target\release\ 里的 —— 那是
#  编译产物目录，随手就会被 clean 掉，也没人知道该发哪几个文件。
#  这个脚本负责：确认 exe 是新的 → 拷出来 → 附一份说人话的说明 → 打包。
#
#  跑法：
#     pwsh -File tools/make-client-portable.ps1
#     pwsh -File tools/make-client-portable.ps1 -SkipBuild    # 只用现成的 exe
#     pwsh -File tools/make-client-portable.ps1 -Open         # 打完把目录打开
#
#  产物：
#     dist-portable\baker-client-<版本>-portable\        （目录）
#     dist-portable\baker-client-<版本>-portable.zip     （发这个）
# ============================================================

[CmdletBinding()]
param(
    # 故意留空、到下面再算：在 param() 的默认值里读 $PSScriptRoot，
    # 用 -File 启动的 Windows PowerShell 5.1 下它是空的，于是 Split-Path
    # 会报 "Cannot bind argument to parameter 'Path'"。
    [string]$OutDir = '',
    [string]$BundleName = '',
    [switch]$SkipBuild,
    [switch]$NoZip,
    [switch]$Force,
    [switch]$Open,
    # 明知 dist\ 比 exe 新还硬要打包（默认是**拦下来**，见下面那一步）。
    [switch]$AllowStaleDist
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'dist-portable' }
$exeSrc = Join-Path $repoRoot 'src-tauri\target\release\baker.exe'

function Step([string]$t) { Write-Host "`n== $t" -ForegroundColor Cyan }
function Ok([string]$t)   { Write-Host "   ok   $t" -ForegroundColor Green }
function Info([string]$t) { Write-Host "         $t" -ForegroundColor DarkGray }
function Warn([string]$t) { Write-Host "   注意  $t" -ForegroundColor Yellow }
function Die([string]$t)  { Write-Host "`n  失败：$t" -ForegroundColor Red; exit 1 }

# ------------------------------------------------------------------ 版本号
Step '读版本号'
$pkgPath = Join-Path $repoRoot 'package.json'
if (-not (Test-Path $pkgPath)) { Die "找不到 $pkgPath" }
$pkg = [IO.File]::ReadAllText($pkgPath) | ConvertFrom-Json
$ver = $pkg.version
if (-not $ver) { $ver = '0.0.0' }
Ok "版本 $ver"

if (-not $BundleName) { $BundleName = "baker-client-$ver-portable" }
$bundleDir = Join-Path $OutDir $BundleName

# ------------------------------------------------------------------ 先建，再决定要不要重来
Step '准备输出目录'
if (Test-Path $bundleDir) {
    if (-not $Force) {
        $leftover = @(Get-ChildItem $bundleDir -Force)
        if ($leftover.Count -gt 0) {
            Die "$bundleDir 已经存在且非空 —— 加 -Force 让我清掉重打"
        }
    }
    # 用户很可能正开着上一次发出去的那个 BAKER.exe —— 而它就是从这个目录里启动的。
    # Windows 允许**重命名正在运行的映像**、但不允许删除它，所以直接 Remove-Item
    # 会报「拒绝访问」，而且那个报错完全没提「是因为你还开着它」。
    # 挪的时候必须挪到**另一个目录**去：留在这个目录里改名，删目录时照样被它绊住。
    # 窗口继续照常跑（映像已经映射进内存了），重打不受影响。
    $sideCar = Join-Path (Split-Path -Parent $bundleDir) ("BAKER-运行中-$(Get-Date -Format yyyyMMdd-HHmmss).exe")
    $movedAny = $false
    Get-ChildItem $bundleDir -Filter '*.exe' -Force -ErrorAction SilentlyContinue | ForEach-Object {
        $locked = $false
        try { [IO.File]::OpenWrite($_.FullName).Close() } catch { $locked = $true }
        if ($locked) {
            try {
                Move-Item -LiteralPath $_.FullName -Destination $sideCar -Force
                $movedAny = $true
            } catch {
                Warn "挪不动 $($_.Name)（$($_.Exception.Message)）—— 先关掉它再重跑"
            }
        }
    }
    if ($movedAny) {
        Warn "你正开着这个目录里的 BAKER.exe —— 已经把它挪到 $sideCar"
        Info '那个窗口继续跑、不受影响；等你关掉它，把上面这个文件删掉就行。'
    }
    Remove-Item $bundleDir -Recurse -Force
}
New-Item -ItemType Directory -Path $bundleDir -Force | Out-Null
Ok $bundleDir

# ------------------------------------------------------------------ 前端资源是不是新的
# 这一步是**给未来省事**的：Tauri 客户端是在编译时把 dist/ 整个嵌进 exe 的，
# 所以「改了前端但忘了 npm run build」会得到一个悄无声息发出去的老界面 ——
# 代码在仓库里是新的，用户拿到的是旧的，而且没有任何报错。
Step '检查 exe 是不是比前端资源新'
$distDir = Join-Path $repoRoot 'dist'
if (Test-Path $exeSrc) {
    $exeTime = (Get-Item $exeSrc).LastWriteTime
    if (Test-Path $distDir) {
        $newestAsset = Get-ChildItem $distDir -Recurse -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($newestAsset -and $newestAsset.LastWriteTime -gt $exeTime) {
            # 原来这里是 Warn —— 而警告在「一条命令跑完、看到绿色就发出去」的
            # 用法下等于没写。**实测真的发生过**：dist\ 全部 01:00:37，
            # 而 baker.exe 是 00:49:46，绿色包里 exe 嵌的前端比 dist 旧 11 分钟。
            # 发出去的是旧界面，而且没有任何报错。所以默认改成就地拦住。
            if ($AllowStaleDist) {
                Warn "dist\ 里有文件比 exe 新（$($newestAsset.Name)）—— 按 -AllowStaleDist 放行"
            } else {
                Die @"
dist\ 里有文件比 exe 新（$($newestAsset.Name)），也就是说这个 exe 里嵌的是旧界面。
    dist\ 最新：$($newestAsset.LastWriteTime)
    exe   时间：$exeTime
先 `npm run build` 再 `npm run desktop:build`，然后重跑本脚本。
确实想用现成的 exe 打包，就加 -AllowStaleDist。
"@
            }
        } else {
            Ok 'exe 不比 dist\ 旧'
        }
    }
    Info "exe 时间：$exeTime"
} else {
    Info '还没有 exe，下面会去编译'
}

# ------------------------------------------------------------------ 编译
if (-not $SkipBuild) {
    Step '编译客户端（npm run desktop:build）'
    # 运行中的 exe 会锁住文件、让链接器报「拒绝访问」。
    # Windows 允许**重命名正在运行的映像**，所以这里先让它让路，
    # 而不是要求用户先关掉自己正在用的那个窗口。
    if (Test-Path $exeSrc) {
        $locked = $false
        try { [IO.File]::OpenWrite($exeSrc).Close() } catch { $locked = $true }
        if ($locked) {
            $side = Join-Path (Split-Path -Parent $exeSrc) "baker-old-$(Get-Date -Format yyyyMMdd-HHmmss).exe"
            Rename-Item -LiteralPath $exeSrc -NewName (Split-Path -Leaf $side)
            Ok "正在运行的 exe 已改名让路（它继续跑，不受影响）"
        }
    }
    Push-Location $repoRoot
    try {
        # cargo 不一定在 PATH 里（这个仓库的习惯是装在别处），找不到就明说。
        if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
            Warn 'PATH 里没有 cargo —— 如果下面失败，先把它加进 PATH 再跑'
        }
        & npm run desktop:build
        if ($LASTEXITCODE -ne 0) { Die "npm run desktop:build 失败（退出码 $LASTEXITCODE）" }
    } finally { Pop-Location }
    Ok '编译完成'
} else {
    Step '跳过编译（-SkipBuild）'
}

if (-not (Test-Path $exeSrc)) { Die "没有 $exeSrc —— 先跑一次 npm run desktop:build（或去掉 -SkipBuild）" }

# ------------------------------------------------------------------ 拷 exe
Step '拷出那一个 exe'
$exeDst = Join-Path $bundleDir 'BAKER.exe'
Copy-Item -LiteralPath $exeSrc -Destination $exeDst -Force
$exeLen = (Get-Item $exeDst).Length
Ok ("BAKER.exe  {0:N0} 字节（{1:N1} MB）" -f $exeLen, ($exeLen / 1MB))

# 顺带把哈希记下来 —— 发出去以后能核对拿到的是不是同一个文件
$hash = (Get-FileHash -LiteralPath $exeDst -Algorithm SHA256).Hash
Add-Content -LiteralPath (Join-Path $bundleDir 'BAKER.exe.sha256.txt') -Value "$hash  BAKER.exe" -Encoding ascii
Ok "SHA256  $hash"

# ------------------------------------------------------------------ exe 是哪一份
Step '校验 exe 里没有调试开关'
# 见审查报告 T3：README 教的那条调试命令（`--no-bundle --config
# src-tauri/tauri.debug.conf.json`，**没有** `--debug`）输出**落在同一个 release
# 路径**上，而那份 conf 带 `--remote-debugging-port=9333 --remote-allow-origins=*`。
# 也就是说「哪一份 exe 在 release 目录里」完全取决于谁最后编译过 —— 脚本原来
# 只查文件存在就拷，sha256 也只证明拷贝没坏、不证明来源。
# 这里按内容判：调试壳里必然有那两个开关字符串，正式产物里没有。
$exeText = [Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($exeDst))
$debugFlags = @()
foreach ($needle in @('remote-debugging-port', 'remote-allow-origins')) {
    if ($exeText.Contains($needle)) { $debugFlags += $needle }
}
if ($debugFlags.Count -gt 0) {
    Die @"
这个 exe 里带着调试开关（$($debugFlags -join '、')）—— 它多半是
tauri.debug.conf.json 产出的那个调试壳，不能当正式包发出去
（任何本机进程都能连上它的调试端口）。请用 npm run desktop:build 重新编译。
"@
}
Ok 'exe 里没有 remote-debugging-port / remote-allow-origins'

# ------------------------------------------------------------------ 使用说明
Step '写使用说明'
$readme = @"
BAKER 聊天客户端 —— 免安装版 $ver
================================================================

就一个 BAKER.exe，双击就能用。不装服务器，不注册账号，不用联网
（除了同一局域网里那几台机器之间）。拔了网线、关掉路由器，只要几台
机器还在同一个交换机/同一个 Wi-Fi 下，照样能聊。

怎么用
  1. 把 BAKER.exe 放到任意位置（U 盘、桌面、D:\tools 都行）。
  2. 双击。
  3. 第一次打开只要填一个「显示名」（随便写，改名字不影响身份）。
     没有服务器地址要填，也没有口令要填 —— 这个版本没有服务器。

  填完就完了。同一局域网里开着 BAKER 的其他人会自动出现在左边的列表里，
  点一下就能建会话、发消息、发文件。别人看到的是你填的显示名。

看不见对方时
  局域网发现走 UDP 组播，下面几种网络会把组播吃掉：
    * 两台机器不在同一个网段（比如一个连 2.4G、一个连 5G 的访客网络）；
    * 路由器开了「AP 隔离 / 客户端隔离」（很多咖啡厅、酒店、公司访客网默认开）；
    * Windows 防火墙把 BAKER 拦了（第一次运行时选「允许专用网络」）；
    * 机器上装了 VPN / 虚拟机 / Docker，多了几个虚拟网卡，组播发错了地方。

  这些都还能救：任意一方点「添加好友」，把自己那串配对码（很长，
  一百来个字符，**用「复制」按钮，别手抄**）发给对方（微信、QQ、
  纸条都行），对方粘进同一个框里点「加为好友」即可。
  配对码里带的是对方的公钥身份，不是地址 —— 所以它不会过期，也不怕抄错
  （末尾四位是校验位，抄错会直接告诉你，不会变成一个查无此人）。

这个 exe 里包含什么
  整个聊天界面（含端到端加密、身份、会话与文件传输）都嵌在这一个文件里，
  不依赖旁边任何文件，也不写注册表。
  你的身份是一对本机生成的密钥，消息端到端加密；没有任何中间服务器,
  也没有人能替你读或替你转发。
  数据（身份、聊天记录、收到的文件）存在
      %APPDATA%\beer.peilika.bakerchat\
  想彻底清掉就把那个目录删了 —— 注意那也同时抹掉你的身份，
  对别人来说你就变成了一个新人。

  想让数据跟着 exe 走（U 盘带走、或者同一台机器上开两个互不干扰的实例），
  就设一个环境变量再启动：
      set BAKER_DATA_DIR=D:\某处\baker-data
      BAKER.exe
  设了它，上面那个 %APPDATA% 目录就不再被碰。

校验
  BAKER.exe.sha256.txt 里是它的 SHA256，可以用来确认拿到的文件没被改过：
      Get-FileHash .\BAKER.exe -Algorithm SHA256
"@
# 带 BOM 写：记事本才会把中文认成 UTF-8
[IO.File]::WriteAllText((Join-Path $bundleDir '使用说明.txt'), $readme, (New-Object Text.UTF8Encoding -ArgumentList @($true)))
Ok '使用说明.txt'

# ------------------------------------------------------------------ 打包
if (-not $NoZip) {
    Step '打包'
    $zip = Join-Path $OutDir "$BundleName.zip"
    if (Test-Path $zip) { Remove-Item $zip -Force }
    Compress-Archive -Path (Join-Path $bundleDir '*') -DestinationPath $zip -CompressionLevel Optimal
    $zipLen = (Get-Item $zip).Length
    Ok ("{0}  {1:N1} MB" -f (Split-Path -Leaf $zip), ($zipLen / 1MB))
} else {
    Step '跳过压缩（-NoZip）'
}

Write-Host "`n打包完成。" -ForegroundColor Green
Write-Host "  $bundleDir"
if (-not $NoZip) { Write-Host "  $(Join-Path $OutDir "$BundleName.zip")" }
Write-Host "`n把那个 exe 拷到任何一台 Windows 上双击就行，不需要安装。" -ForegroundColor Green

if ($Open) { Start-Process explorer.exe $bundleDir }
