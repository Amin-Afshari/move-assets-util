#!/bin/bash

MAX_RETRIES=1000

for ((i=1; i<=MAX_RETRIES; i++)); do
  echo "Starting batch $i..."

  LOG_FILE="/tmp/move-assets-util-last.log"
  bun scripts/move-assets.ts | tee "$LOG_FILE"
  EXIT_CODE=${PIPESTATUS[0]}

  if grep -q "No listings with unmigrated photos found. Migration complete." "$LOG_FILE"; then
    echo "All done. Exiting."
    exit 0
  fi

  if [ $EXIT_CODE -ne 0 ]; then
    echo "Script crashed with exit code $EXIT_CODE. Restarting in 5 seconds..."
    sleep 5
  else
    echo "Batch finished successfully."
  fi

  sleep 2
done
