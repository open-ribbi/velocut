`red-tone.mp4` is a synthetic two-second 96×64 red video with a 440 Hz tone,
created for media import/probe tests (no third-party footage):

```sh
ffmpeg -f lavfi -i 'color=c=red:s=96x64:r=10:d=2' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=2' \
  -shortest -c:v libx264 -profile:v baseline -pix_fmt yuv420p \
  -c:a aac -b:a 64k -movflags +faststart red-tone.mp4
```
