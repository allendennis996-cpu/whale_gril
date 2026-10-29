# 仅识别目标安装目录的服务、桥接及守护进程，不按进程名全局停止。
function Get-WhaleProjectProcesses {
    param([Parameter(Mandatory = $true)][string]$Root)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + '\'
    $entries = @('server.js', 'examples\wechatauto_bridge.py', 'scripts\bridge_loop.bat', '启动微信桥接.bat')
    try { $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop) }
    catch { return @() }
    foreach ($process in $processes) {
        if ($process.Name -notmatch '^(node|python|pythonw|cmd)\.exe$') { continue }
        $owned = $false
        if ($process.Name -ne 'cmd.exe' -and $process.ExecutablePath) {
            $owned = $process.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
        }
        if (-not $owned -and $process.CommandLine) {
            foreach ($entry in $entries) {
                $pattern = '(^|[\s"])' + [regex]::Escape($prefix + $entry) + '(?=[\s"]|$)'
                if ($process.CommandLine -match $pattern) { $owned = $true; break }
            }
        }
        if ($owned -and $process.ProcessId -ne $PID) {
            [pscustomobject]@{Id = $process.ProcessId; Name = $process.Name; Path = $process.ExecutablePath}
        }
    }
}
