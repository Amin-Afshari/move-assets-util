# Run the migration in a loop until all assets are moved
$MaxRetries = 1000

for ($i=1; $i -le $MaxRetries; $i++) {
    Write-Host "Starting batch $i..." -ForegroundColor Cyan
    
    # Run the script using bun
    bun scripts/move-assets.ts
    
    # Capture exit code
    $exitCode = $LASTEXITCODE
    
    if ($exitCode -ne 0) {
        Write-Host "Script crashed with exit code $exitCode. Restarting in 5 seconds..." -ForegroundColor Red
        Start-Sleep -Seconds 5
    } else {
        Write-Host "Batch finished successfully." -ForegroundColor Green
        # Optional: Check output to see if "Found 0 listings" (requires parsing output or exit code convention)
        # For now, we assume user will stop it when done.
    }
    
    # Small pause to let system cool down / release resources
    Start-Sleep -Seconds 2
}
