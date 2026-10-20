// الواي فاي اللي الكمبيوتر بيعمله بنفسه: عشان الموبايلات تتوصل بالكمبيوتر من غير راوتر ولا نت ولا هوت سبوت موبايل.
//   - الطريقة الأساسية: Wi-Fi Direct في وضع "legacy" — الكمبيوتر بيطلع شبكة واي فاي عادية (اسم + باسورد)
//     والكمبيوتر نفسه بيفضل متوصل بالواي فاي بتاعه لو فيه. عنوان الكمبيوتر عليها 192.168.137.1
//   - لو كارت الواي فاي مش راضي: "Mobile hotspot" بتاع الويندوز بنفس الاسم والباسورد
// الشغل نفسه في PowerShell (WinRT) — عملية صغيرة بتفضل شغالة طول ما الشبكة شغالة، ولو اتقفلت بنشغلها تاني.
// الاسم والباسورد من مفتاح الشبكة (pcWifiCredentials) فالموبايلات بتعرفهم وبتدخل لوحدها.
const { spawn } = require('child_process');

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ssid = '__SSID__'; $pass = '__PASS__'; $parentPid = __PID__
function Say($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask1 = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation${'`'}1' } | Select-Object -First 1
$asTask0 = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' } | Select-Object -First 1
function AwaitOp($op, $type) { $t = $asTask1.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(30000); $t.Result }
function AwaitAction($op) { $t = $asTask0.Invoke($null, @($op)); [void]$t.Wait(30000) }

$pub = $null; $tm = $null; $mode = ''; $lastError = ''

function Start-Wfd {
  $null = [Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher, Windows.Devices.WiFiDirect, ContentType = WindowsRuntime]
  $null = [Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType = WindowsRuntime]
  $p = New-Object Windows.Devices.WiFiDirect.WiFiDirectAdvertisementPublisher
  $p.Advertisement.IsAutonomousGroupOwnerEnabled = $true
  $p.Advertisement.LegacySettings.IsEnabled = $true
  $p.Advertisement.LegacySettings.Ssid = $ssid
  $c = New-Object Windows.Security.Credentials.PasswordCredential
  $c.Password = $pass
  $p.Advertisement.LegacySettings.Passphrase = $c
  $p.Start()
  for ($i = 0; $i -lt 20 -and "$($p.Status)" -eq 'Created'; $i++) { Start-Sleep -Milliseconds 250 }
  if ("$($p.Status)" -ne 'Started') { $s = "$($p.Status)"; try { $p.Stop() } catch {}; throw "Wi-Fi Direct: $s" }
  return $p
}

function Start-Tether {
  $null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]
  $null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
  $prof = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()
  if (-not $prof) { $prof = [Windows.Networking.Connectivity.NetworkInformation]::GetConnectionProfiles() | Select-Object -First 1 }
  if (-not $prof) { throw 'Mobile hotspot: no network adapter' }
  $m = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]::CreateFromConnectionProfile($prof)
  $cfg = $m.GetCurrentAccessPointConfiguration()
  if ($cfg.Ssid -ne $ssid -or $cfg.Passphrase -ne $pass) {
    $cfg.Ssid = $ssid; $cfg.Passphrase = $pass
    AwaitAction ($m.ConfigureAccessPointAsync($cfg))
  }
  if ("$($m.TetheringOperationalState)" -ne 'On') {
    $r = AwaitOp ($m.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
    if (-not $r -or "$($r.Status)" -ne 'Success') { throw "Mobile hotspot: $($r.Status) $($r.AdditionalErrorMessage)" }
  }
  return $m
}

function Bring-Up {
  try { $script:pub = Start-Wfd; $script:mode = 'wifi-direct'; return $true } catch { $script:lastError = "$($_.Exception.Message)" }
  try { $script:tm = Start-Tether; $script:mode = 'mobile-hotspot'; return $true } catch { $script:lastError = "$script:lastError | $($_.Exception.Message)" }
  return $false
}

function Is-Up {
  if ($script:pub) { return "$($script:pub.Status)" -eq 'Started' }
  if ($script:tm) { return "$($script:tm.TetheringOperationalState)" -eq 'On' }
  return $false
}

function Tear-Down {
  if ($script:pub) { try { $script:pub.Stop() } catch {}; $script:pub = $null }
  if ($script:tm) { try { AwaitOp ($script:tm.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]) | Out-Null } catch {}; $script:tm = $null }
}

# أي حاجة على stdin (أو قفله) = اقفل
$stdin = [Console]::OpenStandardInput()
$buf = New-Object byte[] 1
$stopTask = $stdin.ReadAsync($buf, 0, 1)

$wasUp = $false; $nextTry = [DateTime]::MinValue
while ($true) {
  if ($stopTask.IsCompleted) { break }
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  $up = Is-Up
  if (-not $up -and [DateTime]::Now -ge $nextTry) {
    Tear-Down
    $up = Bring-Up
    if (-not $up) { Say @{ state = 'error'; message = $lastError }; $nextTry = [DateTime]::Now.AddSeconds(15) }
  }
  if ($up -ne $wasUp) {
    if ($up) {
      $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '192.168.137.*' } | Select-Object -First 1).IPAddress
      Say @{ state = 'on'; mode = $mode; ip = "$ip" }
    } elseif ($wasUp) { Say @{ state = 'error'; message = 'الواي فاي وقف — بنشغله تاني' } }
    $wasUp = $up
  }
  Start-Sleep -Milliseconds 1500
}
Tear-Down
Say @{ state = 'off' }
`;

class PcHotspot {
  constructor() {
    this.child = null;
    this.wanted = null; // { ssid, password }
    this.status = { state: 'off', mode: '', ip: '', message: '' };
    this.restartTimer = null;
  }

  get supported() { return process.platform === 'win32'; }

  view() {
    return { ...this.status, ssid: this.wanted ? this.wanted.ssid : '', password: this.wanted ? this.wanted.password : '', supported: this.supported };
  }

  start(creds) {
    if (!this.supported || !creds) return;
    if (this.wanted && this.wanted.ssid === creds.ssid && this.wanted.password === creds.password && this.child) return;
    this.stop();
    this.wanted = creds;
    this.spawn();
  }

  spawn() {
    clearTimeout(this.restartTimer);
    if (!this.wanted || this.child) return;
    const script = SCRIPT
      .replace('__SSID__', this.wanted.ssid.replace(/[^A-Za-z0-9-]/g, ''))
      .replace('__PASS__', this.wanted.password.replace(/[^A-Za-z0-9]/g, ''))
      .replace('__PID__', String(process.pid));
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    this.status = { state: 'starting', mode: '', ip: '', message: '' };
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      this.status = { state: 'error', mode: '', ip: '', message: error.message };
      return;
    }
    this.child = child;
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim();
        out = out.slice(i + 1);
        if (!line.startsWith('{')) continue;
        try {
          const msg = JSON.parse(line);
          this.status = { state: msg.state || 'error', mode: msg.mode || this.status.mode, ip: msg.ip || '', message: msg.message || '' };
        } catch (e) { /* سطر ناقص */ }
      }
    });
    let errText = '';
    child.stderr.on('data', (chunk) => { errText = (errText + chunk.toString('utf8')).slice(-2000); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => { this.status = { state: 'error', mode: '', ip: '', message: error.message }; });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      if (!this.wanted) { this.status = { state: 'off', mode: '', ip: '', message: '' }; return; }
      // اتقفل لوحده: نشغله تاني بعد شوية
      if (this.status.state !== 'error') this.status = { state: 'error', mode: '', ip: '', message: errText.trim().split('\n').pop() || 'وقف' };
      this.restartTimer = setTimeout(() => this.spawn(), 15 * 1000);
      if (this.restartTimer.unref) this.restartTimer.unref();
    });
  }

  stop() {
    clearTimeout(this.restartTimer);
    this.wanted = null;
    const child = this.child;
    this.child = null;
    this.status = { state: 'off', mode: '', ip: '', message: '' };
    if (!child) return;
    try { child.stdin.end('x'); } catch (e) { /* مقفول */ }
    const killer = setTimeout(() => { try { child.kill(); } catch (e) { /* خلص */ } }, 6000);
    if (killer.unref) killer.unref();
    child.once('exit', () => clearTimeout(killer));
  }
}

module.exports = { PcHotspot };
