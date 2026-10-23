#!/bin/bash
# Talk to kimo-alexa with plain curl: initialize + tools/list over Streamable HTTP (protocol 2025-11-25).
URL=${URL:-http://127.0.0.1:8787/mcp}
type() { printf '\033[1;32m$\033[0m '; for ((i=0;i<${#1};i++)); do printf '%s' "${1:$i:1}"; sleep 0.018; done; echo; sleep 0.3; }
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
clear
echo -e "\033[1;36m# kimo-alexa · self-hosted MCP server · Streamable HTTP · one endpoint: POST /mcp\033[0m"; sleep 0.8
type "curl -si $URL -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{},\"clientInfo\":{\"name\":\"curl\",\"version\":\"1\"}}}'"
R=$(curl -si "$URL" "${H[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}')
echo "$R" | grep -iE '^(HTTP|content-type|mcp-session-id)' | sed 's/\r//'
echo "$R" | grep '^data:' | sed 's/^data: //' | jq -C '.result | {protocolVersion, serverInfo, capabilities}'
SID=$(echo "$R" | grep -i '^mcp-session-id' | awk '{print $2}' | tr -d '\r')
sleep 1.5
curl -s "$URL" "${H[@]}" -H "Mcp-Session-Id: $SID" -H 'MCP-Protocol-Version: 2025-11-25' -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null
type "curl -s $URL -H 'Mcp-Session-Id: ${SID:0:8}…' -H 'MCP-Protocol-Version: 2025-11-25' -d '{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}' | jq '.result.tools[] | {name, description}'"
curl -s "$URL" "${H[@]}" -H "Mcp-Session-Id: $SID" -H 'MCP-Protocol-Version: 2025-11-25' -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | grep '^data:' | sed 's/^data: //' | jq -C -c '.result.tools[] | {name, description: (.description[0:70])}'
sleep ${HOLD:-6}
