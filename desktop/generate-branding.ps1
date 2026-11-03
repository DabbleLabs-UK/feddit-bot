[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$repo = Split-Path -Parent $PSScriptRoot
$source = Join-Path $repo 'assets/logo.png'
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('feddit-branding-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $temporary
try {
    # Originals remain read-only. All conversion starts from this temporary copy.
    $copy = Join-Path $temporary 'logo.png'
    Copy-Item -LiteralPath $source -Destination $copy
    $image = [Drawing.Image]::FromFile($copy)
    try {
        $web = Join-Path $repo 'public/branding'
        $native = Join-Path $PSScriptRoot 'branding'
        $null = New-Item -ItemType Directory -Path $web, $native -Force
        $pngs = @{}
        foreach ($size in @(16, 24, 32, 48, 64, 128, 180, 256)) {
            $bitmap = [Drawing.Bitmap]::new($size, $size)
            $graphics = [Drawing.Graphics]::FromImage($bitmap)
            $stream = [IO.MemoryStream]::new()
            try {
                $graphics.Clear([Drawing.Color]::Transparent)
                $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
                $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
                $scale = [Math]::Min($size / $image.Width, $size / $image.Height)
                $width = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
                $height = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
                $graphics.DrawImage($image, [int](($size - $width) / 2), [int](($size - $height) / 2), $width, $height)
                $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
                $pngs[$size] = $stream.ToArray()
            } finally { $stream.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
        }
        [IO.File]::WriteAllBytes((Join-Path $web 'logo.png'), $pngs[256])
        [IO.File]::WriteAllBytes((Join-Path $web 'icon-32.png'), $pngs[32])
        [IO.File]::WriteAllBytes((Join-Path $web 'apple-touch-icon.png'), $pngs[180])
        $sizes = @(16, 24, 32, 48, 64, 128, 256)
        $stream = [IO.MemoryStream]::new()
        $writer = [IO.BinaryWriter]::new($stream)
        try {
            $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
            $offset = 6 + 16 * $sizes.Count
            foreach ($size in $sizes) {
                $dimension = if ($size -eq 256) { 0 } else { $size }
                $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
                $writer.Write([byte]0); $writer.Write([byte]0)
                $writer.Write([uint16]1); $writer.Write([uint16]32)
                $writer.Write([uint32]$pngs[$size].Length); $writer.Write([uint32]$offset)
                $offset += $pngs[$size].Length
            }
            foreach ($size in $sizes) { $writer.Write([byte[]]$pngs[$size]) }
            $writer.Flush()
            [IO.File]::WriteAllBytes((Join-Path $web 'app.ico'), $stream.ToArray())
            [IO.File]::WriteAllBytes((Join-Path $native 'app.ico'), $stream.ToArray())
        } finally { $writer.Dispose(); $stream.Dispose() }
        Write-Output 'Generated dashboard, browser and multi-resolution Windows icons from assets/logo.png.'
    } finally { $image.Dispose() }
} finally {
    if ([IO.Path]::GetFileName($temporary) -notlike 'feddit-branding-*' -or
        [IO.Path]::GetDirectoryName($temporary) -ne [IO.Path]::GetTempPath().TrimEnd('\')) {
        throw 'Unexpected branding temporary directory.'
    }
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
