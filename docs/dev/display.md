# Studio display

The homepage can display a day/night studio scene, a local clock, and the existing task topology. Display settings are available from the monitor button. Panels, tasks, and the connection power control remain interactive.

`arc.display.enabled` and `arc.display.phase` use Core-backed preferences. Lighting accepts `auto`, `day`, or `night`. Automatic lighting follows local time: day starts at 07:00 and night starts at 19:00. The clock displays local hours and minutes in the selected UI locale. It schedules the next minute boundary, stops its timer while the document is hidden, and refreshes on visibility, focus, page restoration, or an application clock override.

`ui/display/Studio.tsx` owns presentation and full-screen controls. `ui/display/model.ts` owns pure time calculations. `ui/theme.ts` applies a transient studio lighting override to the effective theme; disabling studio restores the saved theme preference. Semantic studio colors live in `ui/tokens.css`.

The four local WebP images in `ui/public/studio/` share day/night composition and provide separate landscape and portrait framing. CSS selects the orientation and fades between lighting states. Reduced motion disables the fade. The scene does not execute third-party content or change operating-system wallpaper.

Ambient light uses small CSS transform and opacity changes over the artwork. Daylight drifts near the window and a few leaf shadows move at the wall edge. Night lighting uses a restrained desk-lamp glow and window reflections. The layers follow each orientation's window and lamp placement. They have no filters, canvas, video decoder, JavaScript frame loop or global pointer-move handler.

`useStudioMotion` reuses the pet visibility policy, including native minimization and application reduced-motion overrides. Hidden windows, reduced motion and non-homepage views remove ambient animation. Open panels, pointer hover over controls and keyboard interaction pause it and lower its opacity; ambient motion resumes after 2.4 seconds without attention on a control. This policy does not change the task timeline or user preferences. The clock also stops scheduling updates while the native window is not visible and refreshes when it returns.

The full-screen control uses the browser Fullscreen API or the existing Tauri window API. Native Escape exits full screen only when no dialog or popup owns Escape. Closing full screen restores focus to the display control. Browser Escape follows the browser's native behavior. The full-screen state is not persisted or entered automatically.

Development fixtures may set `studio` to a lighting value. The development-only `studio` query parameter also supports `day`, `night`, or `auto` without persisting those preview settings. Release builds do not read that parameter.

## Limits

The scene uses static artwork with bounded ambient overlays, not a continuously rendered 3D room. Automatic lighting uses local clock hours and does not request location or calculate sunrise. Full-screen support depends on the browser or native host. The headless Core has no presentation window.
