"""Bounded Windows accessibility queries in a disposable, deadline-limited process."""
import json
import os
from pathlib import Path
import subprocess
import time

from .core import PermissionDenied
from .core import OperationNotApplied
from .privacy import sensitive_label, sensitive_text

FILE_DIALOG_MESSAGE = 'Windows file dialog requires reviewed keyboard input. Verify the exact destination and reopen the saved file.'


class UIAutomationError(PermissionDenied):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


class UIAutomationPreconditionError(UIAutomationError, OperationNotApplied):
    """UI validation failed before any desktop action was dispatched."""


def public_control(item):
    # Filter before shortening: a truncated secret must never become a public label.
    fields = [item.get(key, '') for key in ('name', 'automation_id', 'label')]
    if item.get('protected') or any(not isinstance(v, str) or sensitive_label(v) or sensitive_text(v) for v in fields):
        return None
    return {key: item[key] for key in ('name', 'role', 'enabled', 'automation_id', 'actions')}


def query(request, check):
    if os.name != 'nt':
        raise UIAutomationError('UIA_UNAVAILABLE', 'Windows UI Automation is unavailable on this platform.')
    executable = Path(os.environ.get('SystemRoot', r'C:\Windows')) / 'System32/WindowsPowerShell/v1.0/powershell.exe'
    try:
        process = subprocess.Popen([str(executable), '-NoProfile', '-NonInteractive', '-STA', '-Command', SCRIPT],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   creationflags=subprocess.CREATE_NO_WINDOW)
    except OSError as exc:
        raise UIAutomationError('UIA_UNAVAILABLE', 'The Windows accessibility worker could not start.') from exc
    deadline = time.monotonic() + 8
    payload = json.dumps(request, ensure_ascii=True).encode('ascii')
    try:
        while True:
            check()
            if time.monotonic() > deadline:
                raise TimeoutError()
            try:
                stdout, _ = process.communicate(payload, timeout=0.1)
                break
            except subprocess.TimeoutExpired:
                payload = None
        if process.returncode or len(stdout) > 65536:
            raise ValueError('Invalid UI Automation worker response')
        result = json.loads(stdout.decode('utf-8-sig'))
        if not isinstance(result, dict):
            raise ValueError('Invalid UI Automation worker response')
        if result.get('error'):
            code = result['error']
            if code == 'UIA_FILE_DIALOG':
                raise UIAutomationError(code, FILE_DIALOG_MESSAGE)
            if code not in {'UIA_UNAVAILABLE', 'UIA_TARGET_CHANGED', 'UIA_PROTECTED', 'UIA_UNSUPPORTED', 'UIA_ACTION_UNCERTAIN'}:
                code = 'UIA_UNAVAILABLE'
            message = 'UI Automation could not safely complete this step. Inspect again; never replay uncertain input.'
            if code in {'UIA_TARGET_CHANGED', 'UIA_PROTECTED', 'UIA_UNSUPPORTED', 'UIA_FILE_DIALOG'}:
                raise UIAutomationPreconditionError(code, message)
            raise UIAutomationError(code, message)
        return result
    except UIAutomationError:
        raise
    except Exception as exc:
        code = 'UIA_ACTION_UNCERTAIN' if request.get('action') else 'UIA_UNAVAILABLE'
        reason='deadline exceeded' if isinstance(exc,TimeoutError) else type(exc).__name__
        raise UIAutomationError(code, f'UI Automation worker stopped ({reason}; exit {process.poll()}). Inspect actual state before further input; do not replay.') from exc
    finally:
        if process.poll() is None:
            process.kill()
            process.communicate()


# No document ranges, password values, desktop-root search, or unbounded FindAll.
SCRIPT = r'''
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
try {
 $request=[Console]::In.ReadToEnd() | ConvertFrom-Json
 Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
 Add-Type -ReferencedAssemblies UIAutomationClient,UIAutomationTypes,WindowsBase -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Windows.Automation;
public static class PcrcUia {
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr dialog,int id);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr parent,IntPtr after,string className,string title);
 static bool FileDialog(IntPtr handle,AutomationElement root) {
  // shortcut: Windows shell dialogs only; extend when another picker shows the same uncommitted filename behavior.
  return root.Current.ClassName=="#32770" && (
   FindWindowEx(handle,IntPtr.Zero,"DUIViewWndClassName",null)!=IntPtr.Zero ||
   GetDlgItem(handle,1148)!=IntPtr.Zero || GetDlgItem(handle,1152)!=IntPtr.Zero);
 }
 static readonly Regex Private = new Regex(@"password|passcode|secret|credential|\bpin\b|\botp\b|verification.?code|credit.?card|security.?code|social.?security|private.?key|access.?token|api.?key", RegexOptions.IgnoreCase);
 static bool Protected(AutomationElement e) {
  var c=e.Current;
  if(c.IsPassword || Private.IsMatch(c.Name??"") || Private.IsMatch(c.AutomationId??"")) return true;
  var label=c.LabeledBy;
  return label!=null && Private.IsMatch(label.Current.Name??"");
 }
 static string Id(AutomationElement e) { return String.Join(".",e.GetRuntimeId()); }
 static string ValueStamp(AutomationElement e) {
  object pattern;
  if(e.Current.ControlType!=ControlType.Edit || !e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern))return "";
  var value=((ValuePattern)pattern).Current.Value;
  if(value.Length>1024)throw new InvalidOperationException();
  using(var hash=System.Security.Cryptography.SHA256.Create())return Convert.ToBase64String(hash.ComputeHash(System.Text.Encoding.Unicode.GetBytes(value)));
 }
 static string Stamp(AutomationElement e) {
  var c=e.Current;var b=c.BoundingRectangle;
  return Id(e)+"|"+c.ProcessId+"|"+c.ControlType.Id+"|"+c.AutomationId+"|"+c.ClassName+"|"+c.Name+"|"+b.ToString(System.Globalization.CultureInfo.InvariantCulture)+"|"+ValueStamp(e);
 }
 static Dictionary<string,object> Info(AutomationElement e) {
  var c=e.Current;
  if(Protected(e) || c.IsOffscreen || c.BoundingRectangle.IsEmpty || c.BoundingRectangle.Width<=0 || c.BoundingRectangle.Height<=0 || c.Name.Length>160 || c.AutomationId.Length>160) return null;
  object pattern;
  var actions=new List<string>();
  if(e.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))actions.Add("invoke");
  if(c.ControlType==ControlType.Edit && e.TryGetCurrentPattern(ValuePattern.Pattern,out pattern) && !((ValuePattern)pattern).Current.IsReadOnly && ((ValuePattern)pattern).Current.Value.Length<=1024)actions.Add("set_value");
  if(actions.Count==0)return null;
  var label=c.LabeledBy==null?"":c.LabeledBy.Current.Name;if(label.Length>160)return null;
  return new Dictionary<string,object>{{"name",c.Name},{"role",c.ControlType.ProgrammaticName.Replace("ControlType.","")},{"enabled",c.IsEnabled},{"automation_id",c.AutomationId},{"label",label},{"actions",actions},{"runtime_id",Id(e)},{"stamp",Stamp(e)}};
 }
 static List<AutomationElement> Walk(AutomationElement root, Stopwatch clock) {
  var list=new List<AutomationElement>();
  var pending=new Stack<Tuple<AutomationElement,int>>();pending.Push(Tuple.Create(root,0));
  var walker=TreeWalker.RawViewWalker;
  while(pending.Count>0 && list.Count<128 && clock.ElapsedMilliseconds<3500) {
   var pair=pending.Pop();var e=pair.Item1;list.Add(e);
   if(Protected(e) || e.Current.IsOffscreen || pair.Item2>=6)continue;
   var child=walker.GetFirstChild(e);int siblings=0;
   while(child!=null && pending.Count<128 && siblings++<128 && clock.ElapsedMilliseconds<3500) {
    pending.Push(Tuple.Create(child,pair.Item2+1));child=walker.GetNextSibling(child);
   }
  }
  return list;
 }
 static object Window(AutomationElement root, IntPtr handle) {
  return new {title=root.Current.Name,process_id=root.Current.ProcessId,handle=handle.ToInt64().ToString(),offscreen=root.Current.IsOffscreen};
 }
 static Dictionary<string,object> Snapshot(AutomationElement root, Stopwatch clock) {
  var controls=new List<object>();var text=new List<string>();int visited=0;
  foreach(var e in Walk(root,clock)) {
   visited++;
   try {
    var info=Info(e);if(info!=null && controls.Count<40)controls.Add(info);
    else if(text.Count<8 && !Protected(e) && !e.Current.IsOffscreen && e.Current.ControlType==ControlType.Text && e.Current.Name.Length<=160)text.Add(e.Current.Name);
   } catch(ElementNotAvailableException) { }
  }
  return new Dictionary<string,object>{{"window",Window(root,GetForegroundWindow())},{"window_stamp",Stamp(root)},{"controls",controls},{"status_text",text},{"visited",visited},{"bounded",true},{"truncated",visited>=128 || clock.ElapsedMilliseconds>=3500}};
 }
 public static object Run(string handle,string windowStamp,string runtimeId,string stamp,string action,string value) {
  bool performed=false;
  try {
   var clock=Stopwatch.StartNew();var expected=new IntPtr(Int64.Parse(handle));
   if(GetForegroundWindow()!=expected)return new {error="UIA_TARGET_CHANGED"};
   var root=AutomationElement.FromHandle(expected);
   if(root.Current.Name.Length>160)return new {error="UIA_UNAVAILABLE"};
   if(FileDialog(expected,root))return String.IsNullOrEmpty(action)?(object)new {file_dialog=true,window=Window(root,expected)}:new {error="UIA_FILE_DIALOG"};
   if(String.IsNullOrEmpty(action)) {
    var result=Snapshot(root,clock);
    if(GetForegroundWindow()!=expected)return new {error="UIA_TARGET_CHANGED"};
    return result;
   }
   if(Stamp(root)!=windowStamp)return new {error="UIA_TARGET_CHANGED"};
   AutomationElement target=null;int matches=0;
   foreach(var e in Walk(root,clock))if(Id(e)==runtimeId){target=e;matches++;}
   if(matches!=1 || target==null)return new {error="UIA_TARGET_CHANGED"};
   if(Protected(target))return new {error="UIA_PROTECTED"};
   if(target.Current.IsOffscreen || !target.Current.IsEnabled || target.Current.BoundingRectangle.IsEmpty || target.Current.BoundingRectangle.Width<=0 || target.Current.BoundingRectangle.Height<=0 || Info(target)==null || Stamp(target)!=stamp || GetForegroundWindow()!=expected || clock.ElapsedMilliseconds>3500)return new {error="UIA_TARGET_CHANGED"};
   object pattern;
   if(action=="invoke" && target.TryGetCurrentPattern(InvokePattern.Pattern,out pattern))((InvokePattern)pattern).Invoke();
   else if(action=="set_value" && target.Current.ControlType==ControlType.Edit && target.TryGetCurrentPattern(ValuePattern.Pattern,out pattern) && !((ValuePattern)pattern).Current.IsReadOnly)((ValuePattern)pattern).SetValue(value);
   else return new {error="UIA_UNSUPPORTED"};
   performed=true;
   if(GetForegroundWindow()!=expected)return new {performed=true,verification="window_changed"};
   var after=Snapshot(root,clock);
   after["performed"]=true;after["verification"]="read_back";
   if(action=="set_value" && !Protected(target)) {
    var actual=((ValuePattern)target.GetCurrentPattern(ValuePattern.Pattern)).Current.Value;
    after["value_matches"]=actual==value;
   }
   return after;
  } catch { return performed?(object)new {performed=true,verification="readback_unavailable"}:new {error=String.IsNullOrEmpty(action)?"UIA_UNAVAILABLE":"UIA_ACTION_UNCERTAIN"}; }
 }
}
'@
 [PcrcUia]::Run([string]$request.handle,[string]$request.window_stamp,[string]$request.runtime_id,[string]$request.stamp,[string]$request.action,[string]$request.text) | ConvertTo-Json -Depth 9 -Compress
} catch { @{error='UIA_UNAVAILABLE'} | ConvertTo-Json -Compress }
'''
