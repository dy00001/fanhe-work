' Launch the sync watcher with no console window.
'
' Why this file exists
'   The scheduled task action used to be cmd.exe /c start-sync-watch.cmd. A task
'   registered with an interactive logon token shows that console on screen, so
'   a black window sat there forever. A watcher that is supposed to be invisible
'   looked like a stuck process, and closing the window killed it.
'
' Why not "run whether user is logged on or not" (S4U)
'   That hides the console but loads no user profile, so DPAPI keys and the Edge
'   profile are unavailable. The collector needs the per-shop Edge profile with
'   its cookies; under S4U the login state would silently look empty.
'
' How it works
'   The Run call uses window style 0 to hide the window. Its last flag is True:
'   WAIT for the launcher to exit. That keeps the task itself in the Running
'   state for as long as the watcher lives, which is what makes
'   MultipleInstances=IgnoreNew meaningful -- otherwise every repeat trigger
'   would start another launcher and pay for a guard check. When the watcher
'   dies the task ends, and the next repeat trigger starts it again.
'   Arguments after the script name are forwarded (the poll interval).
Option Explicit
Dim fso, shell, here, command
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)
command = """" & here & "\start-sync-watch.cmd"""

Dim index
For index = 0 To WScript.Arguments.Count - 1
  command = command & " " & WScript.Arguments(index)
Next

shell.Run command, 0, True
