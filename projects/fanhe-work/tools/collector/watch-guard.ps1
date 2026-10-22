# Prints "running" when a sync-shops.mjs watcher is already alive, "free" otherwise.
#
# Why this is a file instead of an inline -Command in the .cmd:
#   The check needs a pipe and a quoted -Filter. Inside cmd's `for /f ('...')`
#   those two fight each other: the pipe must be escaped with ^, and the escaped
#   quotes around Name='node.exe' were mangled badly enough that Get-CimInstance
#   received the filter as separate positional arguments. Keeping the query in a
#   file removes every layer of cmd quoting from the problem.
$procs = @(
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*sync-shops.mjs*' }
)
if ($procs.Count -gt 0) { Write-Output 'running' } else { Write-Output 'free' }
