param([string]$PageId = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$interop = Get-ChildItem "$env:WINDIR\assembly\GAC_MSIL\Microsoft.Office.Interop.OneNote\15*\Microsoft.Office.Interop.OneNote.dll" | Select-Object -First 1
if (!$interop) { throw 'OneNote desktop for Windows is required. Open and sync your notebook in OneNote first.' }
Add-Type -ReferencedAssemblies $interop.FullName -TypeDefinition @'
public class ModernDrawOneNote {
 public static string Read(string id) {
  var app = new Microsoft.Office.Interop.OneNote.Application();
  string xml;
  if (id.Length == 0) app.GetHierarchy("", Microsoft.Office.Interop.OneNote.HierarchyScope.hsPages, out xml, Microsoft.Office.Interop.OneNote.XMLSchema.xs2013);
  else app.GetPageContent(id, out xml, Microsoft.Office.Interop.OneNote.PageInfo.piBinaryData, Microsoft.Office.Interop.OneNote.XMLSchema.xs2013);
  return xml;
 }
}
'@
$xml = [ModernDrawOneNote]::Read($PageId)
if (!$PageId) { [Console]::Write($xml); exit }
Add-Type -AssemblyName PresentationCore,WindowsBase
[xml]$page = $xml
$strokes = New-Object System.Collections.Generic.List[object]
foreach ($ink in $page.SelectNodes("//*[local-name()='InkDrawing' or local-name()='InkWord']")) {
 if (!$ink.Data) { throw 'OneNote returned ink without binary data. Sync the page and try again.' }
 $stream = New-Object System.IO.MemoryStream(,[Convert]::FromBase64String($ink.Data))
 try {
  $collection = New-Object System.Windows.Ink.StrokeCollection($stream)
  $bounds = $collection.GetBounds()
  $sx = 1.0; $sy = 1.0; $dx = 0.0; $dy = 0.0
  if ($ink.Position -and $ink.Size) {
   if ($bounds.Width -gt 0) { $sx = [double]$ink.Size.width * 4 / 3 / $bounds.Width }
   if ($bounds.Height -gt 0) { $sy = [double]$ink.Size.height * 4 / 3 / $bounds.Height }
   $dx = [double]$ink.Position.x * 4 / 3 - $bounds.X * $sx
   $dy = [double]$ink.Position.y * 4 / 3 - $bounds.Y * $sy
  }
  foreach ($stroke in $collection) {
   $a = $stroke.DrawingAttributes
   $points = @($stroke.StylusPoints | ForEach-Object { @{x=$_.X*$sx+$dx; y=$_.Y*$sy+$dy; pressure=[double]$_.PressureFactor} })
   $tool = 'pen'; if ($a.IsHighlighter) { $tool = 'highlighter' }
   $strokes.Add(@{ id=[guid]::NewGuid().ToString(); tool=$tool; color=('#{0:X2}{1:X2}{2:X2}' -f $a.Color.R,$a.Color.G,$a.Color.B); width=$a.Width*($sx+$sy)/2; opacity=([double]$a.Color.A/255); horizontalOrigin=0; anchor=@{pos=0;lineText=''}; points=$points })
  }
 } finally { $stream.Dispose() }
}
[Console]::Write((@{xml=$xml;strokes=@($strokes.ToArray())} | ConvertTo-Json -Depth 12 -Compress))
