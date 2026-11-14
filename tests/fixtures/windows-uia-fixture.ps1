param([Parameter(Mandatory=$true)][string]$State,[switch]$FullScreen)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class FixtureForeground {
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int X;public int Y;}
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd,int command);
 [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint processId);
 [DllImport("user32.dll")] public static extern bool LogicalToPhysicalPointForPerMonitorDPI(IntPtr hwnd,ref Point point);
}
'@
$form=New-Object Windows.Forms.Form
$form.Text='PCRC synthetic UI Automation acceptance'
$form.StartPosition='Manual';$form.Location=New-Object Drawing.Point(80,80)
$form.ClientSize=New-Object Drawing.Size(700,410)
$form.TopMost=$true
if($FullScreen){$form.WindowState='Maximized'}
$script:field=New-Object Windows.Forms.TextBox
$script:field.Name='message';$script:field.AccessibleName='Message'
$script:field.Location=New-Object Drawing.Point(30,40);$script:field.Width=350
$form.Controls.Add($script:field)
$save=New-Object Windows.Forms.Button
$save.Name='save';$save.AccessibleName='Save draft';$save.Text='Save draft'
$save.Location=New-Object Drawing.Point(30,95);$save.Size=New-Object Drawing.Size(150,40)
$form.Controls.Add($save)
$status=New-Object Windows.Forms.Label
$status.Name='status';$status.Text='Status: Ready';$status.AccessibleName='Status: Ready'
$status.Location=New-Object Drawing.Point(30,155);$status.AutoSize=$true
$form.Controls.Add($status)
$save.Add_Click({$status.Text='Status: Saved '+$script:field.Text;$status.AccessibleName=$status.Text;[IO.File]::WriteAllText((Join-Path $State 'saved.txt'),$script:field.Text)})
foreach($index in 1,2) {
 $duplicate=New-Object Windows.Forms.Button
 $duplicate.Name="duplicate$index";$duplicate.AccessibleName='Duplicate';$duplicate.Text='Duplicate'
 $duplicate.Location=New-Object Drawing.Point((220+$index*150),95);$duplicate.Width=120
 $form.Controls.Add($duplicate)
}
$password=New-Object Windows.Forms.TextBox
$password.Name='password';$password.AccessibleName='Password';$password.UseSystemPasswordChar=$true
$password.Location=New-Object Drawing.Point(30,220);$password.Width=250
$form.Controls.Add($password)
$pin=New-Object Windows.Forms.TextBox
$pin.Name='pin';$pin.AccessibleName='PIN';$pin.Location=New-Object Drawing.Point(30,260)
$form.Controls.Add($pin)
$disabled=New-Object Windows.Forms.Button
$disabled.Name='disabled';$disabled.AccessibleName='Disabled button';$disabled.Text='Disabled';$disabled.Enabled=$false
$disabled.Location=New-Object Drawing.Point(30,310);$form.Controls.Add($disabled)
$hidden=New-Object Windows.Forms.Button
$hidden.Name='hidden';$hidden.AccessibleName='Hidden button';$hidden.Visible=$false
$form.Controls.Add($hidden)
$script:alternate=$null
$timer=New-Object Windows.Forms.Timer
$timer.Interval=50
$timer.Add_Tick({
 $path=Join-Path $State 'command.txt'
 if(Test-Path -LiteralPath $path) {
  $command=[IO.File]::ReadAllText($path);[IO.File]::Delete($path)
  switch($command) {
   'replace' {
    $old=$script:field;$form.Controls.Remove($old);$old.Dispose()
    $script:field=New-Object Windows.Forms.TextBox
    $script:field.Name='message';$script:field.AccessibleName='Message'
    $script:field.Location=New-Object Drawing.Point(30,40);$script:field.Width=350
    $form.Controls.Add($script:field)
   }
   'disable' {$script:field.Enabled=$false}
   'change' {$script:field.Text='External change'}
   'hide' {$script:field.Visible=$false}
   'reset' {
    $script:field.Enabled=$true;$script:field.Visible=$true;$script:field.Text=''
    $status.Text='Status: Ready';$status.AccessibleName=$status.Text
    $saved=Join-Path $State 'saved.txt';if(Test-Path -LiteralPath $saved){[IO.File]::Delete($saved)}
    # A hover left by a previous trial can create a foreground tooltip over the fixture.
    if($form.ContainsFocus){[Windows.Forms.Cursor]::Position=$form.PointToScreen((New-Object Drawing.Point(10,10)))}
   }
   'save-dialog' {
    $form.BeginInvoke([Action]{
     $dialog=New-Object Windows.Forms.SaveFileDialog
     $dialog.Title='PCRC synthetic Save As';$dialog.InitialDirectory=$State
     $dialog.FileName='default.txt';$dialog.Filter='Text files (*.txt)|*.txt'
     try {
      if($dialog.ShowDialog($form) -eq 'OK') {[IO.File]::WriteAllText($dialog.FileName,'PCRC_DIALOG_SAVED')}
     } finally {$dialog.Dispose()}
    }) | Out-Null
   }
   'blank' {
    $script:alternate=New-Object Windows.Forms.Form
    $script:alternate.Text='PCRC synthetic blank window';$script:alternate.FormBorderStyle='None'
    $script:alternate.Location=New-Object Drawing.Point(100,100);$script:alternate.Size=New-Object Drawing.Size(650,400);$script:alternate.TopMost=$true
    $script:alternate.Show();$script:alternate.Activate();[FixtureForeground]::SetForegroundWindow($script:alternate.Handle) | Out-Null
   }
   'focus' {
    if($script:alternate){$script:alternate.Close();$script:alternate=$null}
    $form.Activate();[FixtureForeground]::SetForegroundWindow($form.Handle) | Out-Null
   }
   'focus-save-dialog' {
    $popup=[FixtureForeground]::GetLastActivePopup($form.Handle)
    [uint32]$fixtureOwner=0
    [FixtureForeground]::GetWindowThreadProcessId($popup,[ref]$fixtureOwner) | Out-Null
    if($popup -ne $form.Handle -and $fixtureOwner -eq $PID){[FixtureForeground]::SetForegroundWindow($popup) | Out-Null}
   }
   'close' {$form.Close()}
  }
  [IO.File]::WriteAllText((Join-Path $State 'ack.txt'),$command)
 }
})
$form.Add_Shown({
 [FixtureForeground]::ShowWindow($form.Handle,5) | Out-Null
 [FixtureForeground]::SetForegroundWindow($form.Handle) | Out-Null
 $fieldPoint=$script:field.PointToScreen((New-Object Drawing.Point(30,10)))
 $savePoint=$save.PointToScreen((New-Object Drawing.Point(40,15)))
 $fieldPhysical=New-Object FixtureForeground+Point;$fieldPhysical.X=$fieldPoint.X;$fieldPhysical.Y=$fieldPoint.Y
 $savePhysical=New-Object FixtureForeground+Point;$savePhysical.X=$savePoint.X;$savePhysical.Y=$savePoint.Y
 if(-not [FixtureForeground]::LogicalToPhysicalPointForPerMonitorDPI($form.Handle,[ref]$fieldPhysical)){throw 'Fixture coordinate conversion failed'}
 if(-not [FixtureForeground]::LogicalToPhysicalPointForPerMonitorDPI($form.Handle,[ref]$savePhysical)){throw 'Fixture coordinate conversion failed'}
 @{field=@{x=$fieldPhysical.X;y=$fieldPhysical.Y};save=@{x=$savePhysical.X;y=$savePhysical.Y}} | ConvertTo-Json -Compress | Set-Content -LiteralPath (Join-Path $State 'positions.json')
 [IO.File]::WriteAllText((Join-Path $State 'ready.txt'),$form.Handle.ToInt64().ToString());$timer.Start()
})
try {[Windows.Forms.Application]::Run($form)} finally {$timer.Stop();if($script:alternate){$script:alternate.Close()};$form.Dispose()}
