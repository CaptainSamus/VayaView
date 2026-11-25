# VayaView on a Fire TV or Fire TV Stick

The PC does all the work: it holds the library, runs the schedules and streams the video. The Fire TV
app is a small window onto the PC's VayaView over your home Wi-Fi. So:

- **VayaView must be open on the PC** for the TVs to play anything. If the PC app is closed, the TV
  shows "VayaView wasn't found" and keeps trying by itself every 10 seconds; it connects as soon as
  the PC app opens.
- The TV app's screens are loaded from the PC each time, so **updating the PC updates the TVs**. The
  TV app itself only needs reinstalling when `VayaView-TV.apk` changes (rare).
- Tested on: Fire TV Stick (AFTKRT), Fire TV Stick 4K 2018 (AFTMM, Fire OS 6) and a Fire TV
  smart TV (AFTDCT31, Fire OS 7).

## 1. Switch on Phone access on the PC

VayaView on the PC → **Settings → Phone**. Switch it on and note the **PIN** and the address it
shows (for example `http://192.168.1.20:47817`). TVs and phones use the same door (port 47817).

## 2. Install the app on the Fire TV (ADB from the PC)

Download `VayaView-TV.apk` from the [latest release](https://github.com/CaptainSamus/VayaView/releases/latest).

On the Fire TV:
1. **Settings → My Fire TV → About**: click the device name 7 times to unlock Developer options.
2. **Settings → My Fire TV → Developer options**: turn on **ADB debugging** and **Apps from Unknown Sources**.
3. **Settings → My Fire TV → About → Network**: note the TV's IP address.

On the PC, with Android **platform-tools** (adb) installed ([download](https://developer.android.com/tools/releases/platform-tools)):

```
adb connect <TV-IP>:5555
adb install -r VayaView-TV.apk
```

The first `adb connect` shows a prompt **on the TV**: choose **Always allow from this computer**. If adb
says `unauthorized`, that prompt is waiting on the TV screen.

> The Downloader-app route (typing a URL into Downloader on the stick) did not work reliably. Use adb.

### Optional permissions (only for Spotify party mode on the TV)

```
adb shell appops set com.vayaview.tv GET_USAGE_STATS allow
adb shell appops set com.vayaview.tv SYSTEM_ALERT_WINDOW allow
```

These let VayaView stay in front when the Spotify app on the TV starts playing. Run them again on
any new TV.

## 3. First start

Open VayaView from the TV's apps. It searches the home network for the PC (port 47817) and remembers
it. If it can't find it, type the PC's address shown in Settings → Phone. Then enter the PIN once.

## Using the remote

| Button | What it does |
|---|---|
| Channel up / down | Change channel (only these by default) |
| Up / Down | Show the station banner (or change channel, if "Up/Down change channel" is on in the TV bar; for remotes without channel keys) |
| Select / Menu | Open the button bar (Guide, Subtitles, Audio, Sound, Last, modes, Complete Sync, Reconnect) |
| Left / Right | Open the button bar on ⏪ / ⏩ |
| Rewind / Fast-forward | 5 seconds back / ahead (in Music: next song) |
| Play / Pause | Pause or resume (Live TV pauses and shows "● Live" to jump back) |
| Back | Close what's open; hold ~2 s to reconnect to the PC |

The remote's own **Guide** button (the "live TV" key) is taken by Fire OS before any app sees it, so
use the Guide button in VayaView's bar.

## Troubleshooting (things that actually happened)

| Symptom | Cause | Fix |
|---|---|---|
| "VayaView wasn't found" | VayaView closed on the PC, or Phone access off | Open VayaView on the PC; the TV reconnects within ~10 s |
| Nothing plays, but the PC plays fine | Same as above: the PC app was closed | Keep VayaView open on the PC |
| `adb: unauthorized` | The "Allow USB debugging" prompt is waiting on the TV | Accept it on the TV, tick "Always allow" |
| Black picture, sound OK | The Fire TV WebView draws video black inside rounded, clipped boxes | Fixed in the app (no rounded corners around video on TVs) |
| Green blocks on 4K films (Fire TV Stick 4K 2018, AFTMM) | That chip garbles 4K copy streams in the WebView | Fixed: on that model 4K films are sent as 1080p (the PC's GPU re-encodes, HDR is tone-mapped) |
| TV a few seconds behind the PC | Start-up delay after a tune | It catches up by itself (a small ⏩ 1.08× badge shows while it speeds up) |
| Sound keeps playing after pressing Home | Android WebView doesn't pause media | Fixed: leaving the app pauses and mutes everything |
| Spotify app jumps in front of VayaView | Spotify brings itself forward when playback moves to the TV | Run the two `appops` commands above |
| Songs skip at 0:00 / black flashes in Live TV | The Spotify party was still playing on the TV while video played; a Fire TV plays sound from one app at a time | Pause the Spotify party before switching to Live TV / Music (VayaView now does this itself) |

## Building the TV app yourself

`node scripts/build-tv-apk.mjs` builds `releases/VayaView-TV.apk` without Gradle
(aapt2 → javac → d8 → zipalign → apksigner). It needs a JDK and the Android SDK build-tools in
`tools/` (not in the repo). The signing key lives in `android/keystore/` (not in the repo): **keep
it**. An APK signed with a different key won't install over the existing app; you'd have to uninstall
it first (`adb uninstall com.vayaview.tv`), and the TV would forget its PC and PIN.

To look inside the TV app while it runs (WebView debugging is on in the APK):

```
adb shell cat /proc/net/unix | findstr webview_devtools_remote
adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>
```

then open `chrome://inspect` on the PC (or use the Chrome DevTools Protocol on port 9333).
