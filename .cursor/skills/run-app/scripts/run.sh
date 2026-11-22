#!/bin/bash
# Run or rerun the Downroad app. Kills existing instance first.
cd "$(dirname "$0")/../../../.."
pkill -f "Downroad" 2>/dev/null || true
sleep 1
npm start
