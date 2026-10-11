# Generates extension icons: blue gradient rounded square + white chat bubble + download arrow.
# Usage: powershell -File generate-icons.ps1   (writes extension/icons/icon{16,32,48,128}.png)

Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "extension\icons"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2*$r, 2*$r, 180, 90)
  $p.AddArc($x+$w-2*$r, $y, 2*$r, 2*$r, 270, 90)
  $p.AddArc($x+$w-2*$r, $y+$h-2*$r, 2*$r, 2*$r, 0, 90)
  $p.AddArc($x, $y+$h-2*$r, 2*$r, 2*$r, 90, 90)
  $p.CloseFigure()
  return $p
}

function New-Icon([int]$size, [string]$path) {
  $s = [single]$size
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  # Background: rounded square, blue gradient (light top-left to deep bottom-right)
  $rect = New-Object System.Drawing.RectangleF(0, 0, $s, $s)
 $c1 = [System.Drawing.Color]::FromArgb(96, 165, 250)   # light blue
  $c2 = [System.Drawing.Color]::FromArgb(29, 78, 216)    # deep blue
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, 60.0)
  $r = [math]::Round($s * 0.22)
  $bgPath = New-RoundRect 0.5 0.5 ($s - 1.0) ($s - 1.0) $r
  $g.FillPath($bgBrush, $bgPath)

  # Chat bubble: white rounded rect with a small tail at bottom-left
  $bw = $s * 0.64; $bh = $s * 0.50
  $bx = ($s - $bw) / 2.0; $by = $s * 0.17
  $white = [System.Drawing.Brushes]::White
  $bubblePath = New-RoundRect $bx $by $bw $bh ([math]::Round($s * 0.10))
  $g.FillPath($white, $bubblePath)
  $tailX = $bx + $bw * 0.16
  $tail = @(
    (New-Object System.Drawing.PointF([single]($tailX), [single]($by + $bh - 1.0))),
    (New-Object System.Drawing.PointF([single]($tailX + $s * 0.13), [single]($by + $bh - 1.0))),
    (New-Object System.Drawing.PointF([single]($tailX - $s * 0.02), [single]($by + $bh + $s * 0.13)))
  )
  $g.FillPolygon($white, $tail)

  # Download arrow inside bubble (shaft + head + tray), deep blue
  $blue = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(29, 78, 216))
  $cx = $s / 2.0
  $shaftW = $s * 0.105
  $shaft = New-Object System.Drawing.RectangleF([single]($cx - $shaftW/2), [single]($by + $bh*0.20), [single]$shaftW, [single]($bh*0.40))
  $g.FillRectangle($blue, $shaft)
  $head = @(
    (New-Object System.Drawing.PointF([single]($cx - $s*0.145), [single]($by + $bh*0.56))),
    (New-Object System.Drawing.PointF([single]($cx + $s*0.145), [single]($by + $bh*0.56))),
    (New-Object System.Drawing.PointF([single]$cx, [single]($by + $bh*0.80)))
  )
  $g.FillPolygon($blue, $head)
  $tray = New-Object System.Drawing.RectangleF([single]($cx - $s*0.165), [single]($by + $bh*0.86), [single]($s*0.33), [single]($s*0.05))
  $g.FillRectangle($blue, $tray)

  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose(); $bgBrush.Dispose(); $bgPath.Dispose(); $bubblePath.Dispose(); $blue.Dispose()
}

foreach ($n in @(16, 32, 48, 128)) {
  New-Icon $n (Join-Path $outDir ("icon{0}.png" -f $n))
}
Write-Output "icons written to $outDir"
