# Требовать запуск от имени Администратора
if (!([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "Запуск от имени Администратора..." -ForegroundColor Yellow
    Start-Process powershell.exe "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`"" -Verb RunAs
    exit
}

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  VPNexus Network Recovery Tool (Windows)" -ForegroundColor Cyan
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "Начинаем восстановление сетевых настроек..." -ForegroundColor Green
Start-Sleep -Seconds 2

Write-Host "[1/6] Сброс системных настроек прокси..." -ForegroundColor Yellow
netsh winhttp reset proxy | Out-Null
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyEnable -Value 0 -ErrorAction SilentlyContinue
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name ProxyServer -Value '' -ErrorAction SilentlyContinue
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -Name AutoConfigURL -Value '' -ErrorAction SilentlyContinue
Write-Host "  [OK] Прокси сброшен." -ForegroundColor Green

Write-Host "[2/6] Поиск и отключение зависших VPN-адаптеров..." -ForegroundColor Yellow
$vpnAdapters = Get-NetAdapter | Where-Object { $_.InterfaceDescription -match "TAP|Wintun|Happ|VPN|Virtual" -and $_.Status -eq "Up" }
if ($vpnAdapters) {
    foreach ($adapter in $vpnAdapters) {
        Write-Host "  -> Отключаем адаптер: $($adapter.Name)" -ForegroundColor Gray
        Disable-NetAdapter -Name $adapter.Name -Confirm:$false -ErrorAction SilentlyContinue
    }
    Write-Host "  [OK] Виртуальные адаптеры отключены." -ForegroundColor Green
} else {
    Write-Host "  [OK] Зависших виртуальных адаптеров не найдено." -ForegroundColor Green
}

Write-Host "[3/6] Очистка таблицы маршрутизации..." -ForegroundColor Yellow
route -f | Out-Null
Write-Host "  [OK] Таблица маршрутизации очищена." -ForegroundColor Green

Write-Host "[4/6] Сброс стека Winsock и IP..." -ForegroundColor Yellow
netsh winsock reset | Out-Null
netsh int ip reset | Out-Null
Write-Host "  [OK] Стек Winsock и IP сброшен." -ForegroundColor Green

Write-Host "[5/6] Перезапуск сетевых служб и очистка DNS..." -ForegroundColor Yellow
Restart-Service -Name Dnscache, NlaSvc -Force -ErrorAction SilentlyContinue
ipconfig /flushdns | Out-Null
ipconfig /registerdns | Out-Null
Write-Host "  [OK] DNS-кэш очищен, службы перезапущены." -ForegroundColor Green

Write-Host "[6/6] Запрос нового IP-адреса у DHCP..." -ForegroundColor Yellow
ipconfig /release | Out-Null
Start-Sleep -Seconds 2
ipconfig /renew | Out-Null
Write-Host "  [OK] IP-адрес обновлен." -ForegroundColor Green

Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "  Успешно завершено!" -ForegroundColor Green
Write-Host "==================================================" -ForegroundColor Cyan
Write-Host "ВАЖНО: Для применения изменений НЕОБХОДИМА перезагрузка компьютера." -ForegroundColor Red

$choice = Read-Host "Перезагрузить компьютер сейчас? (Y/N)"
if ($choice -eq 'Y' -or $choice -eq 'y' -or $choice -eq 'Д' -or $choice -eq 'д') {
    Write-Host "Перезагрузка через 5 секунд..." -ForegroundColor Yellow
    Start-Sleep -Seconds 5
    Restart-Computer -Force
} else {
    Write-Host "Не забудьте перезагрузить компьютер вручную!" -ForegroundColor Yellow
    Start-Sleep -Seconds 3
}