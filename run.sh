#!/bin/sh
# start the bridge in the background (logs to data/server.log)
cd "$(dirname "$0")"; mkdir -p data
[ -f data/server.pid ] && kill "$(cat data/server.pid)" 2>/dev/null
setsid nohup node src/server.mjs > data/server.log 2>&1 < /dev/null &
echo $! > data/server.pid
