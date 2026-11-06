# The demo video

Kantel's one-minute marketing video, to share on its own: a silent loop through what Kantel does. The home page
doesn't embed it; its hero tells the same story live (`src/components/HeroStory.astro`), with the best of these scenes
rebuilt as HTML. Made with the beat-video skill: `index.html` is a page whose every frame is a function of time, and the renderer screenshots it frame by frame.

| File | What |
| --- | --- |
| `content.js` | The eight scenes: their markup, copy and motion, on a silent 100 BPM grid (a bar is 2.4 s) |
| `theme.css` | The look: the console's dark theme, sized to read at about 600px wide |
| `field.js` | The background: the hero's pixel field, drawn at the video's time, crossfaded at the end so the loop has no seam |
| `sync-pixel-field.mjs` | Copies `src/scripts/pixel-field.js` in as `pixel-field.js` (git-ignored); run it before checking or rendering |
| `fonts/`, `*.svg` | The brand's faces and lockups, local so a render never needs the network |
| `mv.js`, `mv.css`, `kinds.*`, `beats.*`, `format.json` | The beat-video engine and grid, as the skill copied them |

The product in it is drawn, not screenshotted: copy, names and colours follow the console (`packages/ui/src/compute`)
and the docs, so change a scene when what it shows changes.

## Render it

With the beat-video skill set up (`node <skill>/scripts/setup.mjs`):

```sh
node apps/site/video/sync-pixel-field.mjs
node <skill>/scripts/check.mjs apps/site/video     # must print "no errors"
node <skill>/scripts/render.mjs apps/site/video    # out/video.mp4, 1440x1080 at 60 fps, about 2 minutes
```

Then encode a copy to share (no audio track; `+faststart` so it plays before it has all downloaded), with a WebM
beside it for web pages and a poster from the first scene. `out/` is git-ignored:

```sh
cd apps/site/video
ffmpeg -i out/video.mp4 -an -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -movflags +faststart out/kantel-demo.mp4
ffmpeg -i out/video.mp4 -an -c:v libvpx-vp9 -b:v 0 -crf 38 -row-mt 1 out/kantel-demo.webm
ffmpeg -ss 6.6 -i out/video.mp4 -frames:v 1 -q:v 3 out/kantel-demo-poster.jpg
```
