#!/bin/sh
# Records tools/curl_demo.sh in an xterm (Xvfb :98) to video/curl_initialize_tools_list.mp4
cd "$(dirname "$0")/.."
Xvfb :98 -screen 0 1920x1080x24 -nolisten tcp >/dev/null 2>&1 & XP=$!
sleep 1.5
DISPLAY=:98 xterm -geometry 166x50+0+0 -fa 'DejaVu Sans Mono' -fs 15 -bg '#0b0f17' -fg '#e6edf3' -b 24 +sb -e "HOLD=7 bash tools/curl_demo.sh" & TP=$!
sleep 1
ffmpeg -y -loglevel error -f x11grab -draw_mouse 0 -framerate 30 -video_size 1920x1080 -i :98.0 -t 21 -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p video/curl_initialize_tools_list.mp4
kill $TP $XP 2>/dev/null
