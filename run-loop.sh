#!/bin/bash

# Run the migration in a loop until all assets are moved
MAX_RETRIES=1000

for ((i=1; i<=MAX_RETRIES; i++)); do
    echo "Starting batch $i..."
    
    # Run the script using bun
    bun scripts/move-assets.ts
    
    # Capture exit code
    EXIT_CODE=$?
    
    if [ $EXIT_CODE -ne 0 ]; then
        echo "Script crashed with exit code $EXIT_CODE. Restarting in 5 seconds..."
        sleep 5
    else
        echo "Batch finished successfully."
    fi
    
    # Small pause to let system cool down / release resources
    sleep 2
done
