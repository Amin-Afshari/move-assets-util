$MaxRetries = 1000

for ($i=1; $i -le $MaxRetries; $i++) {
    Write-Host "Starting batch $i..." -ForegroundColor Cyan

    $logFile = Join-Path $env:TEMP "move-assets-util-last.log"
    bun scripts/move-assets.ts | Tee-Object -FilePath $logFile
    $exitCode = $LASTEXITCODE

    if (Select-String -Path $logFile -Pattern "No listings with unmigrated photos found. Migration complete." -Quiet) {
        Write-Host "All done. Exiting." -ForegroundColor Green
        break
    }

    if ($exitCode -ne 0) {
        Write-Host "Script crashed with exit code $exitCode. Restarting in 5 seconds..." -ForegroundColor Red
        Start-Sleep -Seconds 5
    } else {
        Write-Host "Batch finished successfully." -ForegroundColor Green
    }

    Start-Sleep -Seconds 2
}
