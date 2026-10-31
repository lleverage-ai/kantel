# Kantel artwork

The approved Kantel mark and wordmark, as outlined SVGs with no fonts or `<text>`:

- `kantel-mark-on-{light,dark}`: the mark alone. The beam (30°, the "quarter turn") is knocked out of the squircle
  tile, so it shows the ground; the fulcrum is orange `#EC7523`.
- `kantel-wordmark-on-{light,dark}`: "Kantel".
- `kantel-lockup-horizontal-on-{light,dark}`: the mark and the wordmark on one line.
- `kantel-lockup-endorsed-on-{light,dark}`: the same with "by Lleverage" inline. The default endorsed lockup.
- `kantel-lockup-stacked-on-{light,dark}` and `kantel-lockup-stacked-endorsed-below-alt-on-{light,dark}`: stacked
  versions; the "below" endorsement is a secondary alternative only.

`on-light` is Lleverage grey 900 `#252820`, for white and light grounds; `on-dark` is white `#FFFFFF`, for dark ones.

In the console, use the components (`KantelMark`, `KantelWordmark`, `KantelLockup` from `@kantel/ui`), which draw the
same outlines (`../artwork.ts`, checked against these files by `../kantel.test.ts`) in the theme's `--kt-brand-ink`
and `--kt-brand-fulcrum`. Use these files where React isn't: the favicon set in `apps/console/public`, a README, a
slide. Don't recolour them beyond the two inks, retype the wordmark in a font or redraw the mark.
