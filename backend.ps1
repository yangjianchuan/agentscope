param([ValidateSet('start','stop','restart','status','menu')][string]$Action='menu')
$ErrorActionPreference='Stop'
$Root=Split-Path -Parent $MyInvocation.MyCommand.Path
$Python=Join-Path $Root '.venv\Scripts\python.exe';$Main=Join-Path $Root 'examples\agent_service\main.py';$LogDir=Join-Path $Root 'runtime\logs'
New-Item -ItemType Directory -Force $LogDir|Out-Null
function Get-PortProcess{Get-NetTCPConnection -State Listen -LocalPort 8000 -ErrorAction SilentlyContinue|Select-Object -First 1}
function Status{ $c=Get-PortProcess;if($c){Write-Host '后端服务状态：运行中';Write-Host "监听地址：http://localhost:8000/";Write-Host "监听端口：8000  PID：$($c.OwningProcess)"}else{Write-Host '后端服务状态：已停止';Write-Host '监听地址：无'} }
function Start-Service{if(-not(Get-PortProcess)){Start-Process -FilePath $Python -ArgumentList "`"$Main`"" -WorkingDirectory $Root -RedirectStandardOutput (Join-Path $LogDir 'backend.log') -RedirectStandardError (Join-Path $LogDir 'backend.err.log') -WindowStyle Hidden|Out-Null;Start-Sleep 4};Status}
function Stop-Service{$c=Get-PortProcess;if($c){Stop-Process -Id $c.OwningProcess -Force;Write-Host '后端服务已停止'}else{Write-Host '后端服务未运行'};Status}
function Menu{while($true){Clear-Host;Write-Host '====== AgentScope 后端服务管理 ======';Status;Write-Host '';Write-Host '1. 后台启动服务';Write-Host '2. 停止服务';Write-Host '3. 查看服务状态';Write-Host '4. 重启服务';Write-Host '0. 退出';$n=Read-Host '请选择';switch($n){'1'{Start-Service};'2'{Stop-Service};'3'{Status};'4'{Stop-Service;Start-Service};'0'{return};default{Write-Host '无效选项'}};if($n-ne '0'){Read-Host '按回车返回菜单'}}}
if($Action-eq'menu'){Menu}elseif($Action-eq'start'){Start-Service}elseif($Action-eq'stop'){Stop-Service}elseif($Action-eq'restart'){Stop-Service;Start-Service}else{Status}
