// الواي فاي اللي الكمبيوتر بيعمله بنفسه: عشان الموبايلات تتوصل بالكمبيوتر من غير راوتر ولا نت ولا هوت سبوت موبايل.
//   - الطريقة الأساسية: Wi-Fi Direct في وضع "legacy" — الكمبيوتر بيطلع شبكة واي فاي عادية (اسم + باسورد)
//     والكمبيوتر نفسه بيفضل متوصل بالواي فاي بتاعه لو فيه. عنوان الكمبيوتر عليها 192.168.137.1
//   - لو كارت الواي فاي مش راضي: "Mobile hotspot" بتاع الويندوز بنفس الاسم والباسورد
// الشغل نفسه في PowerShell (WinRT) — عملية صغيرة بتفضل شغالة طول ما الشبكة شغالة، ولو اتقفلت بنشغلها تاني.
// الاسم والباسورد من مفتاح الشبكة (pcWifiCredentials) فالموبايلات بتعرفهم وبتدخل لوحدها.
// مهم: في Wi-Fi Direct الويندوز مش بيقبل الموبايل لوحده — لازم البرنامج يرد على ConnectionRequested
// ويفتح الجهاز (FromIdAsync) وإلا الموبايل بيدخل وبيتشال قبل ما ياخد عنوان. PowerShell مش بيعرف يسمع
// أحداث WinRT، فبنعمل كلاس C# صغير وقت التشغيل (SfWfdAccept) هو اللي بيقبل.
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

$pub = $null; $tm = $null; $mode = ''; $lastError = ''; $acceptError = ''

$acceptSrc = @'
using System;
using System.Collections.Generic;
using System.Threading;
using Windows.Foundation;
using Windows.Devices.WiFiDirect;
public static class SfWfdAccept {
  static WiFiDirectConnectionListener listener;
  static readonly List<WiFiDirectDevice> devices = new List<WiFiDirectDevice>();
  public static string LastError = "";
  public static void Start() {
    listener = new WiFiDirectConnectionListener();
    listener.ConnectionRequested += OnRequest;
  }
  static void OnRequest(WiFiDirectConnectionListener sender, WiFiDirectConnectionRequestedEventArgs args) {
    try {
      var id = args.GetConnectionRequest().DeviceInformation.Id;
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          var op = WiFiDirectDevice.FromIdAsync(id);
          for (int i = 0; i < 600 && op.Status == AsyncStatus.Started; i++) Thread.Sleep(50);
          if (op.Status != AsyncStatus.Completed) { LastError = "accept: " + op.Status; return; }
          lock (devices) devices.Add(op.GetResults());
        } catch (Exception e) { LastError = e.Message; }
      });
    } catch (Exception e) { LastError = e.Message; }
  }
  public static int Connected() {
    lock (devices) {
      devices.RemoveAll(d => { try { return d.ConnectionStatus != WiFiDirectConnectionStatus.Connected; } catch { return true; } });
      return devices.Count;
    }
  }
}
'@
try {
  $fw = [System.Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()
  $wm = "$env:windir\System32\WinMetadata"
  $cp = New-Object System.CodeDom.Compiler.CompilerParameters
  $cp.GenerateInMemory = $true
  foreach ($r in @('System.dll', "$fw\System.Runtime.WindowsRuntime.dll", "$fw\System.Runtime.dll", "$fw\System.Runtime.InteropServices.WindowsRuntime.dll", "$wm\Windows.Devices.winmd", "$wm\Windows.Foundation.winmd")) { [void]$cp.ReferencedAssemblies.Add($r) }
  $cr = (New-Object Microsoft.CSharp.CSharpCodeProvider).CompileAssemblyFromSource($cp, $acceptSrc)
  if ($cr.Errors.HasErrors) { throw (($cr.Errors | Select-Object -First 1).ToString()) }
  [SfWfdAccept]::Start()
} catch { $acceptError = "$($_.Exception.Message)" }

function Clients {
  $n = 0
  if ($script:pub -and -not $acceptError) { try { $n = [SfWfdAccept]::Connected() } catch {} }
  $ips = @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '192.168.137.*' -and $_.IPAddress -ne '192.168.137.255' -and $_.IPAddress -ne '192.168.137.1' -and "$($_.State)" -in @('Reachable', 'Stale', 'Delay', 'Probe') } | ForEach-Object { $_.IPAddress } | Sort-Object -Unique)
  return @{ n = [Math]::Max($n, $ips.Count); ips = $ips }
}

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

$wasUp = $false; $nextTry = [DateTime]::MinValue; $lastClients = ''; $ip = ''
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
      $lastClients = ''
    } elseif ($wasUp) { Say @{ state = 'error'; message = 'الواي فاي وقف — بنشغله تاني' } }
    $wasUp = $up
  }
  if ($up) {
    # كام موبايل داخل الواي فاي دلوقتي + عناوينهم (الكمبيوتر بيبعتلهم مباشرة — الموبايلات كتير بتتجاهل الـ broadcast)
    if (-not $ip) { $ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -like '192.168.137.*' } | Select-Object -First 1).IPAddress }
    $c = Clients
    $key = "$ip|$($c.n)|$($c.ips -join ',')"
    if ($key -ne $lastClients) {
      Say @{ state = 'on'; mode = $mode; ip = "$ip"; clients = $c.n; ips = @($c.ips); acceptError = $acceptError }
      $lastClients = $key
    }
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
    this.status = { state: 'off', mode: '', ip: '', message: '', clients: 0, ips: [], acceptError: '' };
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
          this.status = {
            state: msg.state || 'error', mode: msg.mode || this.status.mode, ip: msg.ip || '', message: msg.message || '',
            clients: Number(msg.clients) || 0, ips: Array.isArray(msg.ips) ? msg.ips.filter(ip => /^192\.168\.137\.\d+$/.test(ip)) : [], acceptError: msg.acceptError || '',
          };
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

  /** عناوين الموبايلات اللي داخلة واي فاي الكمبيوتر (الاكتشاف بيبعتلهم مباشرة) */
  clientIps() { return this.status.state === 'on' ? this.status.ips : []; }

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

// الفايروول: الويندوز بيسأل "السماح بالوصول" أول مرة، ولو اتقفل أو اختاروا "إلغاء" بيعمل قاعدة حظر للبرنامج
// والموبايلات مش بتعرف تكلم الكمبيوتر. ده بيطلب صلاحية أدمن مرة واحدة (رسالة الويندوز) ويسمح للبرنامج
// ولبورت الاكتشاف، ويقفل قواعد الحظر اللي على البرنامج.
const FIREWALL_RULE = 'Shady Elsharkawy - device network';

function allowInFirewall(exePath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({ success: false, message: 'ويندوز بس' }); return; }
    const exe = String(exePath).replace(/'/g, "''");
    const inner = [
      `$exe = '${exe}'; $name = '${FIREWALL_RULE}'`,
      'Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule',
      'New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Program $exe -Profile Any | Out-Null',
      'New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47821 -Profile Any | Out-Null',
      "Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { \"$($_.Action)\" -eq 'Block' } | Disable-NetFirewallRule",
    ].join('\n');
    const innerEncoded = Buffer.from(inner, 'utf16le').toString('base64');
    const outer = `try { $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${innerEncoded}'; exit $p.ExitCode } catch { exit 5 }`;
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ success: false, message: error.message });
      return;
    }
    child.on('error', error => resolve({ success: false, message: error.message }));
    child.on('exit', code => resolve(code === 0
      ? { success: true }
      : { success: false, message: code === 5 ? 'اتلغى — لازم توافق على رسالة الويندوز (Yes)' : `ماتمش (كود ${code})` }));
  });
}

module.exports = { PcHotspot, allowInFirewall };
