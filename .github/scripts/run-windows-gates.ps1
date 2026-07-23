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

  $running = [System.Collections.Generic.List[object]]::new()
  $results = [ordered]@{}
  $assertText = ${function:Assert-NativeGateSucceeded}.ToString()
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'

  function Drain-FinishedJobs {
    $i = 0
    while ($i -lt $running.Count) {
      $job = $running[$i]
      if ($job.State -eq 'Running' -or $job.State -eq 'NotStarted') {
        $i += 1
        continue
      }
      Receive-Job -Job $job -ErrorAction SilentlyContinue | Write-Output
      $results[$job.Name] = if ($job.State -eq 'Completed') { 'pass' } else { 'fail' }
      Remove-Job -Job $job -Force -ErrorAction SilentlyContinue
      $running.RemoveAt($i)
    }
  }

  try {
    foreach ($gate in $Gates) {
      while ($running.Count -ge $MaxParallel) {
        Drain-FinishedJobs
        if ($running.Count -ge $MaxParallel) {
          Start-Sleep -Milliseconds 5
        }
      }

      $scriptText = $gate.ScriptBlock.ToString()
      $running.Add((Start-ThreadJob -Name $gate.Name -ThrottleLimit $MaxParallel -ScriptBlock {
        param($AssertText, $ScriptText)
        Set-Item -Path function:Assert-NativeGateSucceeded -Value ([scriptblock]::Create($AssertText))
        & ([scriptblock]::Create($ScriptText))
      } -ArgumentList $assertText, $scriptText))
    }

    while ($running.Count -gt 0) {
      Drain-FinishedJobs
      if ($running.Count -gt 0) {
        Start-Sleep -Milliseconds 5
      }
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
