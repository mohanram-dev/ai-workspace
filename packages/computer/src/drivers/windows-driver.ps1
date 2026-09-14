# Desktop driver for AI Workspace computer use (Windows).
# Reads one JSON command per line on stdin and writes one JSON result per line on stdout.
# Commands: screen, screenshot {maxWidth,path}, move {x,y}, click {x,y,button,count}, down/up {x,y,button},
#           drag {fromX,fromY,toX,toY,button}, scroll {x,y,dx,dy}, type {text}, key {keys[]}, cursor, exit.
# Coordinates are physical screen pixels of the virtual screen (all monitors).
$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -Namespace AiwDriver -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, IntPtr extra);
"@
[void][AiwDriver.Native]::SetProcessDPIAware()

$MOUSE = @{ LEFTDOWN = 0x02; LEFTUP = 0x04; RIGHTDOWN = 0x08; RIGHTUP = 0x10; MIDDLEDOWN = 0x20; MIDDLEUP = 0x40; WHEEL = 0x800; HWHEEL = 0x1000 }
# Keys are sent with System.Windows.Forms.SendKeys; modifiers become its prefixes.
$MODIFIERS = @{ ctrl = "^"; control = "^"; alt = "%"; shift = "+" }
$NAMED_KEYS = @{
  enter = "{ENTER}"; return = "{ENTER}"; tab = "{TAB}"; escape = "{ESC}"; esc = "{ESC}"; backspace = "{BACKSPACE}"; delete = "{DELETE}"; del = "{DELETE}";
  insert = "{INSERT}"; space = " "; home = "{HOME}"; end = "{END}"; pageup = "{PGUP}"; pagedown = "{PGDN}"; up = "{UP}"; down = "{DOWN}"; left = "{LEFT}"; right = "{RIGHT}";
  f1 = "{F1}"; f2 = "{F2}"; f3 = "{F3}"; f4 = "{F4}"; f5 = "{F5}"; f6 = "{F6}"; f7 = "{F7}"; f8 = "{F8}"; f9 = "{F9}"; f10 = "{F10}"; f11 = "{F11}"; f12 = "{F12}";
  printscreen = "{PRTSC}"; capslock = "{CAPSLOCK}"; numlock = "{NUMLOCK}"
}

function Get-Bounds { [System.Windows.Forms.SystemInformation]::VirtualScreen }

function Move-To($x, $y) {
  $b = Get-Bounds
  $cx = [Math]::Max($b.Left, [Math]::Min($b.Right - 1, [int]$x))
  $cy = [Math]::Max($b.Top, [Math]::Min($b.Bottom - 1, [int]$y))
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point $cx, $cy
  Start-Sleep -Milliseconds 30
}

function Button-Flags($button) {
  switch ($button) {
    "right" { return @($MOUSE.RIGHTDOWN, $MOUSE.RIGHTUP) }
    "middle" { return @($MOUSE.MIDDLEDOWN, $MOUSE.MIDDLEUP) }
    default { return @($MOUSE.LEFTDOWN, $MOUSE.LEFTUP) }
  }
}

function Escape-Key($text) { [regex]::Replace($text, '[+^%~(){}[]]', { param($m) "{" + $m.Value + "}" }) }

# Windows key combinations are not expressible with SendKeys (no {WIN} token); they are rejected.
function Press-Keys($keys) {
  $prefix = ""
  $main = @()
  foreach ($k in @($keys)) {
    $n = ([string]$k).ToLowerInvariant()
    if ($MODIFIERS.ContainsKey($n)) { $prefix += $MODIFIERS[$n]; continue }
    if ($n -in @("win", "super", "cmd", "meta")) { throw "The Windows key cannot be sent." }
    if ($NAMED_KEYS.ContainsKey($n)) { $main += $NAMED_KEYS[$n]; continue }
    if ($n.Length -eq 1) { $main += (Escape-Key $n); continue }
    throw "Unknown key: $k"
  }
  if ($main.Count -eq 0) { throw "No key to press." }
  $body = ($main -join "")
  if ($prefix -ne "" -and $main.Count -gt 1) { $body = "(" + $body + ")" }
  [System.Windows.Forms.SendKeys]::SendWait($prefix + $body)
}

function Type-Text($text) {
  # SendKeys treats these as control characters; escape them so text is typed literally.
  $escaped = [regex]::Replace($text, '[+^%~(){}\[\]]', { param($m) "{" + $m.Value + "}" })
  $escaped = $escaped -replace "`r`n", "{ENTER}" -replace "`n", "{ENTER}" -replace "`t", "{TAB}"
  [System.Windows.Forms.SendKeys]::SendWait($escaped)
}

# The image is written as JPEG to the file the caller names; scaled down to maxWidth.
function Take-Screenshot($maxWidth, $path) {
  $b = Get-Bounds
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
  $g.Dispose()
  $scale = 1.0
  $out = $bmp
  if ($maxWidth -gt 0 -and $b.Width -gt $maxWidth) {
    $scale = $maxWidth / $b.Width
    $out = New-Object System.Drawing.Bitmap $bmp, $maxWidth, ([int][Math]::Round($b.Height * $scale))
  }
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $w = $out.Width; $h = $out.Height
  if ($out -ne $bmp) { $out.Dispose() }
  $bmp.Dispose()
  return @{ path = $path; width = $w; height = $h; screenWidth = $b.Width; screenHeight = $b.Height; scale = $scale; left = $b.Left; top = $b.Top }
}

Write-Output (ConvertTo-Json -Compress @{ ready = $true; screen = @{ width = (Get-Bounds).Width; height = (Get-Bounds).Height } })

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if ($line.Trim() -eq "") { continue }
  $result = $null
  try {
    $cmd = ConvertFrom-Json $line
    switch ($cmd.op) {
      "exit" { exit 0 }
      "screen" { $b = Get-Bounds; $result = @{ ok = $true; width = $b.Width; height = $b.Height; left = $b.Left; top = $b.Top } }
      "screenshot" { $s = Take-Screenshot ([int]$cmd.maxWidth) ([string]$cmd.path); $s.ok = $true; $result = $s }
      "cursor" { $p = [System.Windows.Forms.Cursor]::Position; $result = @{ ok = $true; x = $p.X; y = $p.Y } }
      "move" { Move-To $cmd.x $cmd.y; $result = @{ ok = $true } }
      "click" {
        Move-To $cmd.x $cmd.y
        $f = Button-Flags $cmd.button
        $count = if ($cmd.count) { [int]$cmd.count } else { 1 }
        for ($i = 0; $i -lt $count; $i++) {
          [AiwDriver.Native]::mouse_event($f[0], 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 20
          [AiwDriver.Native]::mouse_event($f[1], 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 60
        }
        $result = @{ ok = $true }
      }
      "drag" {
        $f = Button-Flags $cmd.button
        Move-To $cmd.fromX $cmd.fromY
        [AiwDriver.Native]::mouse_event($f[0], 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 80
        $steps = 12
        for ($i = 1; $i -le $steps; $i++) { Move-To ($cmd.fromX + ($cmd.toX - $cmd.fromX) * $i / $steps) ($cmd.fromY + ($cmd.toY - $cmd.fromY) * $i / $steps) }
        Start-Sleep -Milliseconds 80
        [AiwDriver.Native]::mouse_event($f[1], 0, 0, 0, [IntPtr]::Zero)
        $result = @{ ok = $true }
      }
      "scroll" {
        Move-To $cmd.x $cmd.y
        if ($cmd.dy) { [AiwDriver.Native]::mouse_event($MOUSE.WHEEL, 0, 0, [int](-$cmd.dy * 120), [IntPtr]::Zero) }
        if ($cmd.dx) { [AiwDriver.Native]::mouse_event($MOUSE.HWHEEL, 0, 0, [int]($cmd.dx * 120), [IntPtr]::Zero) }
        $result = @{ ok = $true }
      }
      "type" { Type-Text ([string]$cmd.text); $result = @{ ok = $true } }
      "key" { Press-Keys @($cmd.keys); $result = @{ ok = $true } }
      default { $result = @{ ok = $false; error = "Unknown op: $($cmd.op)" } }
    }
  } catch {
    $result = @{ ok = $false; error = $_.Exception.Message }
  }
  Write-Output (ConvertTo-Json -Compress -Depth 4 $result)
}
