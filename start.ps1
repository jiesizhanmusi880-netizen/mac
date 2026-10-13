# KTV Maker 一键启动：先起 Spring Boot 后端，再起 Electron 前端
$ErrorActionPreference = 'Continue'
$root = $PSScriptRoot

$env:JAVA_HOME = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { 'D:\jdk' }
$mvn = 'D:\maven\apache-maven-3.8.8-bin\apache-maven-3.8.8\bin\mvn.cmd'
if (-not (Test-Path $mvn)) {
    $found = Get-ChildItem 'D:\maven','C:\Program Files','D:\' -Filter 'mvn.cmd' -Recurse -Depth 3 -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { $mvn = $found.FullName }
}

Write-Host '== 启动后端 (Spring Boot, 127.0.0.1:8787) ==' -ForegroundColor Cyan
Start-Process -FilePath $mvn -ArgumentList '-f', "$root\server\pom.xml", 'spring-boot:run' `
    -WorkingDirectory "$root\server" -WindowStyle Minimized

$ok = $false
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 2
    try {
        $res = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/system/ping' -UseBasicParsing -TimeoutSec 3
        if ($res.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}
if ($ok) {
    Write-Host '后端就绪' -ForegroundColor Green
} else {
    Write-Host '后端启动较慢，继续启动前端（界面顶部会显示状态）' -ForegroundColor Yellow
}

Write-Host '== 启动前端 (Electron) ==' -ForegroundColor Cyan
Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory "$root\desktop"
Write-Host '完成。关闭本窗口不会停止服务。' -ForegroundColor DarkGray
