<# Git 开发目录更新：只从指定仓库 main 分支快进，不清理或暂存本地修改。 #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Root,
    [string]$Repository = 'https://github.com/allendennis996-cpu/whale_gril.git',
    [switch]$Check,
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'

function Invoke-SourceGit {
    param([string[]]$Arguments)
    $savedPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $lines = @(& git -C $script:sourceRoot @Arguments 2>&1 | ForEach-Object { $_.ToString() })
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($code -ne 0) { throw ('Git 操作失败：' + ($lines -join "`n")) }
    return $lines
}

try {
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw '源码更新需要 Git，请先安装 Git for Windows。' }
    $script:sourceRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd('\','/')
    $top = (Invoke-SourceGit -Arguments @('rev-parse','--show-toplevel')) -join ''
    if ([IO.Path]::GetFullPath($top).TrimEnd('\','/') -ne $script:sourceRoot) { throw '只能在项目自身的 Git 根目录更新。' }
    if (-not $Repository -or $Repository.StartsWith('-')) { throw '更新仓库地址无效。' }
    Write-Host ('  源码更新来源：' + $Repository + ' / main') -ForegroundColor Cyan
    $localHead = (Invoke-SourceGit -Arguments @('rev-parse','HEAD')) -join ''
    $remote = (Invoke-SourceGit -Arguments @('ls-remote','--exit-code','--',$Repository,'refs/heads/main')) -join ''
    $target = ($remote -split '\s+')[0]
    if ($target -notmatch '^[a-f0-9]{40,64}$') { throw '无法读取目标仓库 main 分支的提交号。' }
    Write-Host ('  当前提交：' + $localHead.Substring(0,12))
    Write-Host ('  远端提交：' + $target.Substring(0,12))
    if ($Check -or $DryRun) {
        if ($localHead -eq $target) { Write-Host '  已经是最新源码。' } else { Write-Host '  有不同提交；实际更新前将检查本地修改、分支和隐私文件。' }
        Write-Host '  检查完成，未修改代码、配置、数据或 Git 分支。'
        exit 0
    }
    if ($localHead -eq $target) { Write-Host '  已经是最新源码。'; exit 0 }
    $branch = (Invoke-SourceGit -Arguments @('symbolic-ref','--quiet','--short','HEAD')) -join ''
    if ($branch -ne 'main') { throw '源码更新只支持 main 分支；请先处理当前分支并手动切回 main。' }
    $dirty = @(Invoke-SourceGit -Arguments @('status','--porcelain=v1','--untracked-files=normal'))
    if ($dirty.Count) { throw '检测到未提交的源码修改或新文件。请先自行提交或保存；-Force 也不会丢弃这些改动。' }
    if (-not $Yes -and -not [Console]::IsInputRedirected) {
        $answer = Read-Host '  回车更新源码，输入 q 取消（更新后需重启服务和桥接）'
        if ($answer -match '^\s*[qQ]') { Write-Host '  已取消。'; exit 0 }
    }
    # 直接使用本项目的仓库地址，不依赖 origin（它可能还指向上游）。
    [void](Invoke-SourceGit -Arguments @('fetch','--no-tags','--',$Repository,'main'))
    $fetched = (Invoke-SourceGit -Arguments @('rev-parse','FETCH_HEAD')) -join ''
    if ($fetched -ne $target) { throw '检查期间远端提交发生变化，请重新运行更新。' }
    [void](Invoke-SourceGit -Arguments @('merge-base','--is-ancestor',$localHead,$target))
    $files = @(Invoke-SourceGit -Arguments @('ls-tree','-r','--name-only',$target))
    $blocked = @($files | Where-Object { $_ -match '(^|/)(data|\.venv|venv|runtime|backup|node_modules|wechatauto_db|wechatauto_logs|wechat-identities)(/|$)|(^|/)config\.json$|(^|/)wechat-identities.*\.json$|\.log$' })
    if ($blocked.Count) { throw '远端源码包含运行环境或隐私文件，拒绝覆盖本机。' }
    if ($files -notcontains 'server.js' -or $files -notcontains 'package.json') { throw '目标提交缺少项目入口或版本文件，拒绝更新。' }
    # Git 快进不会执行目标代码，也不会替换本地配置、身份目录、聊天数据或运行环境。
    [void](Invoke-SourceGit -Arguments @('merge','--ff-only','--',$target))
    Write-Host ('  源码更新完成：' + $target.Substring(0,12)) -ForegroundColor Green
    Write-Host '  请重启控制台服务和微信桥接。config.json、data/ 和本机运行环境已保留。'
    exit 0
} catch {
    Write-Host ('  更新中止：' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
