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
'   WScript.Shell.Run with window style 0 hides the window; the False flag means
'   "do not wait", so the task action returns at once while the launcher keeps
'   running in the background. Arguments after the script name are forwarded to
'   the launcher (the poll interval).
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

shell.Run command, 0, False
