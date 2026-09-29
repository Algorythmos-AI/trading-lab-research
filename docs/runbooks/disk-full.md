# Disk nearly full

The jobs refuse to arm below 3 GB free on `/System/Volumes/Data`. Use that path, not `/`, which misreports on
APFS. A full disk crashed the routine on 2026-09-28.

**Free space safely:**

```
npm cache clean --force
rm -rf ~/Library/Developer/Xcode/DerivedData
xcrun simctl shutdown all && xcrun simctl delete unavailable
uv cache prune
pnpm store prune
```

- Quit the iOS Simulator and memory-heavy apps. macOS keeps 1 GB swap files on the same disk.
- Then check with `df -h /System/Volumes/Data` and `make -C ~/trading preflight`.
