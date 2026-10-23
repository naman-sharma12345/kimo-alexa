#!/bin/sh
# Ken-Burns clips from AI-generated stills (no copyrighted material). 8 s, 1280x720, 30 fps.
cd "$(dirname "$0")"; mkdir -p trip
i=0
for n in 1:coast-road 2:lake-picnic 3:beach 4:cafe 5:forest-trail 6:sunset; do
  idx=${n%%:*}; name=${n#*:}; h=$((9+idx)); i=$((i+1))
  if [ $((idx % 2)) -eq 0 ]; then Z="1.0+0.0006*on"; X="iw/2-(iw/zoom/2)"; else Z="1.15-0.0005*on"; X="(iw-iw/zoom)*on/240"; fi
  ffmpeg -y -loglevel error -loop 1 -i src/trip$idx.jpg -vf "scale=2560:-2,zoompan=z='$Z':x='$X':y='ih/2-(ih/zoom/2)':d=240:s=1280x720:fps=30,format=yuv420p" -t 8 -c:v libx264 -crf 20 -metadata creation_time="2026-10-17T$h:15:00Z" trip/2026-10-17_$(printf %02d $h)15_$name.mp4
done
# a weekday clip that should NOT be picked for "Saturday"
ffmpeg -y -loglevel error -f lavfi -i "gradients=s=1280x720:c0=0x203040:c1=0x405060:speed=0.01:d=8" -vf format=yuv420p -c:v libx264 -crf 24 -metadata creation_time="2026-10-14T09:00:00Z" trip/2026-10-14_0900_desk-timelapse.mp4
ls -la trip
