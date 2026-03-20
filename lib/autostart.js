import fs from 'fs'
import path from 'path'
import os from 'os'

const APP_NAME = 'pearup'

function getMacPlistPath () {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.pearup.daemon.plist')
}

function getLinuxDesktopPath () {
  return path.join(os.homedir(), '.config', 'autostart', 'pearup.desktop')
}

export function enableAutostart (mode = 'tray') {
  const platform = process.platform
  const execPath = process.execPath
  const appDir = path.resolve(new URL('..', import.meta.url).pathname)

  if (platform === 'darwin') {
    const plistPath = getMacPlistPath()
    const cmd = mode === 'tray'
      ? `${execPath} ${path.join(appDir, 'node_modules', 'electron', 'cli.js')} ${path.join(appDir, 'main.js')}`
      : `${execPath} ${path.join(appDir, 'daemon-entry.js')}`

    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.pearup.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${cmd}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${path.join(os.homedir(), '.pearup', 'daemon.log')}</string>
  <key>StandardErrorPath</key>
  <string>${path.join(os.homedir(), '.pearup', 'daemon.log')}</string>
</dict>
</plist>`
    fs.mkdirSync(path.dirname(plistPath), { recursive: true })
    fs.writeFileSync(plistPath, plist)
    return plistPath
  }

  if (platform === 'linux') {
    const desktopPath = getLinuxDesktopPath()
    const cmd = mode === 'tray'
      ? `${path.join(appDir, 'node_modules', '.bin', 'electron')} ${path.join(appDir, 'main.js')}`
      : `${execPath} ${path.join(appDir, 'daemon-entry.js')}`

    const desktop = `[Desktop Entry]
Type=Application
Name=PearUp
Exec=${cmd}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Comment=PearUp P2P messaging daemon
`
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true })
    fs.writeFileSync(desktopPath, desktop)
    return desktopPath
  }

  throw new Error('Unsupported platform: ' + platform)
}

export function disableAutostart () {
  const platform = process.platform
  try {
    if (platform === 'darwin') fs.unlinkSync(getMacPlistPath())
    if (platform === 'linux') fs.unlinkSync(getLinuxDesktopPath())
  } catch {}
}

export function isAutostartEnabled () {
  const platform = process.platform
  try {
    if (platform === 'darwin') return fs.existsSync(getMacPlistPath())
    if (platform === 'linux') return fs.existsSync(getLinuxDesktopPath())
  } catch {}
  return false
}
