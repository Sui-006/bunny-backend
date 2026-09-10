# 把任意图片转成 Bunny's Home 的 PWA 图标集（180/192/512 + maskable 512）
# 依赖：Windows 自带 System.Drawing（GDI+），无需第三方库。
# 用法：powershell -ExecutionPolicy Bypass -File server/scripts/convert-icon.ps1 -Source "图片路径" -OutDir "frontend/icons"
param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$OutDir
)

Add-Type -AssemblyName System.Drawing

$src = New-Object System.Drawing.Bitmap($Source)
$w = $src.Width
$h = $src.Height
Write-Host "source: ${w}x${h}"

# 中心裁成正方形（取短边）
$side = [Math]::Min($w, $h)
$offX = [Math]::Floor(($w - $side) / 2)
$offY = [Math]::Floor(($h - $side) / 2)
$crop = New-Object System.Drawing.Rectangle($offX, $offY, $side, $side)
$sq = $src.Clone($crop, $src.PixelFormat)

$edgeColor = $sq.GetPixel(0, 0)   # maskable 背景取样（左上角）

function Resize-Save([int]$size, [string]$name, [System.Drawing.Image]$img, [bool]$full) {
  $out = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.Clear($edgeColor)
  if ($full) {
    $g.DrawImage($img, 0, 0, $size, $size)
  } else {
    # maskable：缩到 80%，居中，保证内容落在安全区
    $pad = [Math]::Floor($size * 0.10)
    $g.DrawImage($img, $pad, $pad, $size - 2*$pad, $size - 2*$pad)
  }
  $out.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $out.Dispose()
  Write-Host "✓ $name $($size)x$($size)"
}

Resize-Save 180 "icon-180.png" $sq $true
Resize-Save 192 "icon-192.png" $sq $true
Resize-Save 512 "icon-512.png" $sq $true
Resize-Save 512 "icon-maskable-512.png" $sq $false

$src.Dispose(); $sq.Dispose()
Write-Host "done -> $OutDir"
