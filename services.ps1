param([ValidateSet('start','stop','restart','status','menu')][string]$Action='menu')
$ErrorActionPreference='Stop';$Root=Split-Path -Parent $MyInvocation.MyCommand.Path;$Backend=Join-Path $Root 'backend.ps1';$Frontend=Join-Path $Root 'frontend.ps1'
function Status-All{Write-Host '';Write-Host '========== 当前服务状态 ==========';& $Backend -Action status;Write-Host '';& $Frontend -Action status;Write-Host '==================================='}
function Start-All{& $Backend -Action start;& $Frontend -Action start}
function Stop-All{& $Frontend -Action stop;& $Backend -Action stop}
function Menu{while($true){Clear-Host;Write-Host '====== AgentScope 前后端服务管理 ======';Status-All;Write-Host '';Write-Host '1. 后台启动服务';Write-Host '2. 停止服务';Write-Host '3. 查看服务状态';Write-Host '4. 重启服务';Write-Host '0. 退出';$n=Read-Host '请选择';switch($n){'1'{Start-All};'2'{Stop-All};'3'{Status-All};'4'{Stop-All;Start-All};'0'{return};default{Write-Host '无效选项'}};if($n-ne '0'){Read-Host '按回车返回菜单'}}}
if($Action-eq'menu'){Menu}elseif($Action-eq'start'){Start-All}elseif($Action-eq'stop'){Stop-All}elseif($Action-eq'restart'){Stop-All;Start-All}else{Status-All}
