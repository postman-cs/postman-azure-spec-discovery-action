function Assert-NativeGateSucceeded {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Name,

    [Parameter(Mandatory = $true)]
    [int]$ExitCode
  )

  if ($ExitCode -ne 0) {
    throw "gate '$Name' failed with exit code $ExitCode"
  }
}

function Invoke-BoundedGateQueue {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNull()]
    [hashtable[]]$Gates,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 2)]
    [int]$MaxParallel
  )

  if ($null -eq $Gates -or $Gates.Count -eq 0) {
    throw 'Invoke-BoundedGateQueue requires a finite non-empty Gates array.'
  }
  if ($MaxParallel -ne 2) {
    throw 'Invoke-BoundedGateQueue accepts only MaxParallel=2.'
  }

  foreach ($gate in $Gates) {
    if (-not $gate.ContainsKey('Name') -or [string]::IsNullOrWhiteSpace([string]$gate.Name)) {
      throw 'Each gate requires a non-empty Name.'
    }
    if (-not $gate.ContainsKey('ScriptBlock') -or $gate.ScriptBlock -isnot [scriptblock]) {
      throw "Gate '$($gate.Name)' requires a ScriptBlock."
    }
  }

  $running = @()
  $results = [ordered]@{}
  $assertText = ${function:Assert-NativeGateSucceeded}.ToString()
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  try {
    foreach ($gate in $Gates) {
      while ($true) {
        $active = 0
        $nextRunning = @()
        foreach ($job in $running) {
          if ($job.State -eq 'Running' -or $job.State -eq 'NotStarted') {
            $active += 1
            $nextRunning += $job
            continue
          }
          Receive-Job -Job $job -ErrorAction SilentlyContinue | Write-Output
          $results[$job.Name] = if ($job.State -eq 'Completed') { 'pass' } else { 'fail' }
          Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
        }
        $running = $nextRunning
        if ($active -lt $MaxParallel) { break }
        Start-Sleep -Milliseconds 10
      }

      $scriptText = $gate.ScriptBlock.ToString()
      $running += Start-ThreadJob -Name $gate.Name -ThrottleLimit $MaxParallel -ScriptBlock {
        param($AssertText, $ScriptText)
        Set-Item -Path function:Assert-NativeGateSucceeded -Value ([scriptblock]::Create($AssertText))
        & ([scriptblock]::Create($ScriptText))
      } -ArgumentList $assertText, $scriptText
    }

    while ($running.Count -gt 0) {
      $nextRunning = @()
      foreach ($job in $running) {
        if ($job.State -eq 'Running' -or $job.State -eq 'NotStarted') {
          $nextRunning += $job
          continue
        }
        Receive-Job -Job $job -ErrorAction SilentlyContinue | Write-Output
        $results[$job.Name] = if ($job.State -eq 'Completed') { 'pass' } else { 'fail' }
        Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
      }
      $running = $nextRunning
      if ($running.Count -gt 0) { Start-Sleep -Milliseconds 10 }
    }
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }

  $failed = $false
  foreach ($gate in $Gates) {
    $status = $results[$gate.Name]
    if ($null -eq $status) { $status = 'fail' }
    Write-Output "gate:$($gate.Name)=$status"
    if ($status -ne 'pass') { $failed = $true }
  }

  if ($failed) {
    throw 'One or more Windows gates failed.'
  }
}
