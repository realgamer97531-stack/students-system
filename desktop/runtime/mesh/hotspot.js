// الواي فاي اللي الكمبيوتر بيعمله بنفسه: عشان الموبايلات تتوصل بالكمبيوتر من غير راوتر ولا نت ولا هوت سبوت موبايل.
//   - الطريقة الأساسية: "Mobile hotspot" بتاع الويندوز على 2.4GHz (كل الموبايلات بتشوفها). بيشتغل من غير نت كمان:
//     بنديله أي شبكة متسجلة على الجهاز. عنوان الكمبيوتر عليها 192.168.137.1
//   - لو مرضيش: Wi-Fi Direct في وضع "legacy" بنفس الاسم والباسورد (مبيختارش الباند — كروت كتير بتطلعه 5GHz
//     والموبايلات مش بتشوفه، وده اللي كان بيحصل)
//   - الشبكة "شغالة" بس لما الكمبيوتر يبقى واخد 192.168.137.x فعلًا — الكارت ممكن يقول Up وهو واقف
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
  public static int Requests;
  public static int Accepted;
  public static void Start() {
    listener = new WiFiDirectConnectionListener();
    listener.ConnectionRequested += OnRequest;
  }
  static void OnRequest(WiFiDirectConnectionListener sender, WiFiDirectConnectionRequestedEventArgs args) {
    try {
      Interlocked.Increment(ref Requests);
      var id = args.GetConnectionRequest().DeviceInformation.Id;
      ThreadPool.QueueUserWorkItem(_ => {
        try {
          var op = WiFiDirectDevice.FromIdAsync(id);
          for (int i = 0; i < 600 && op.Status == AsyncStatus.Started; i++) Thread.Sleep(50);
          if (op.Status != AsyncStatus.Completed) { LastError = "accept: " + op.Status; return; }
          lock (devices) devices.Add(op.GetResults());
          Interlocked.Increment(ref Accepted);
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
  $req = 0; $acc = 0; $err = ''
  if (-not $acceptError) { try { $req = [SfWfdAccept]::Requests; $acc = [SfWfdAccept]::Accepted; $err = [SfWfdAccept]::LastError } catch {} }
  return @{ n = [Math]::Max($n, $ips.Count); ips = $ips; req = $req; acc = $acc; err = "$err" }
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

$band = ''
function Start-Tether {
  $null = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]
  $null = [Windows.Networking.NetworkOperators.TetheringWiFiBand, Windows.Networking.NetworkOperators, ContentType = WindowsRuntime]
  $null = [Windows.Networking.Connectivity.NetworkInformation, Windows.Networking.Connectivity, ContentType = WindowsRuntime]
  $NI = [Windows.Networking.Connectivity.NetworkInformation]
  $TM = [Windows.Networking.NetworkOperators.NetworkOperatorTetheringManager]
  # الشبكة اللي عليها نت الأول، ومن غير نت أي شبكة متسجلة (الويندوز بيشغل الهوت سبوت عادي من غير نت)
  $profiles = @()
  $inet = $NI::GetInternetConnectionProfile()
  if ($inet) { $profiles += $inet }
  $profiles += @($NI::GetConnectionProfiles() | Where-Object { -not $inet -or $_.ProfileName -ne $inet.ProfileName })
  $last = 'no network adapter'
  # كل محاولة تشغيل بتقفل وتفتح الراديو — كتير منها بيعلّق درايفر الواي فاي (Intel 8265 حصل له كده). فبنحاول 3 شبكات بالكتير
  foreach ($prof in ($profiles | Select-Object -First 3)) {
    try {
      if ("$($TM::GetTetheringCapabilityFromConnectionProfile($prof))" -ne 'Enabled') { continue }
      $m = $TM::CreateFromConnectionProfile($prof)
      $bands = @('Auto')
      try { if ($m.GetCurrentAccessPointConfiguration().IsBandSupported([Windows.Networking.NetworkOperators.TetheringWiFiBand]::TwoPointFourGigahertz)) { $bands = @('TwoPointFourGigahertz', 'Auto') } } catch {}
      foreach ($b in $bands) {
        $cfg = $m.GetCurrentAccessPointConfiguration()
        $same = $cfg.Ssid -eq $ssid -and $cfg.Passphrase -eq $pass -and "$($cfg.Band)" -eq $b
        if ("$($m.TetheringOperationalState)" -eq 'On') {
          if ($same) { $script:band = $b; return $m }
          AwaitOp ($m.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]) | Out-Null
        }
        if (-not $same) {
          $cfg.Ssid = $ssid; $cfg.Passphrase = $pass
          try { $cfg.Band = [Windows.Networking.NetworkOperators.TetheringWiFiBand]::$b } catch {}
          AwaitAction ($m.ConfigureAccessPointAsync($cfg))
        }
        $r = AwaitOp ($m.StartTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult])
        if ($r -and "$($r.Status)" -eq 'Success') { $script:band = $b; return $m }
        $last = "$($r.Status) $($r.AdditionalErrorMessage)".Trim()
        # الكارت نفسه مش بيرد: مفيش فايدة من باقي الشبكات/الباندات
        if ("$($r.Status)" -eq 'WiFiDeviceOff') { throw "Mobile hotspot: $last" }
      }
    } catch { $last = "$($_.Exception.Message)"; if ($last -match 'WiFiDeviceOff') { break } }
  }
  throw "Mobile hotspot: $last"
}

function Bring-Up {
  $script:lastError = ''
  try { $script:tm = Start-Tether; $script:mode = 'mobile-hotspot'; return $true } catch { $script:lastError = "$($_.Exception.Message)" }
  try { $script:pub = Start-Wfd; $script:mode = 'wifi-direct'; $script:band = ''; return $true } catch { $script:lastError = "$script:lastError | $($_.Exception.Message)" }
  return $false
}

# الشبكة شغالة بجد = الكمبيوتر واخد 192.168.137.x. الويندوز بيقفلها لوحده كل ما الواي فاي العادي يفصل أو يغيّر شبكة،
# وساعات الكارت بيفضل "Up" والـ publisher بيقول Started وهي واقفة (ده اللي حصل) — فبنبص على العنوان نفسه:
# لو مش موجود 12 ثانية (وقت التشغيل) يبقى وقعت ونشغلها تاني.
$downSince = $null
function Has-PcIp {
  try { return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -like '192.168.137.*' }).Count -gt 0 } catch { return $true }
}

function Is-Up {
  $ok = $false
  if ($script:tm) { $ok = "$($script:tm.TetheringOperationalState)" -eq 'On' }
  elseif ($script:pub) { $ok = "$($script:pub.Status)" -eq 'Started' }
  else { return $false }
  if (-not $ok) { return $false }
  if (Has-PcIp) { $script:downSince = $null; return $true }
  if (-not $script:downSince) { $script:downSince = [DateTime]::Now }
  return ([DateTime]::Now - $script:downSince).TotalSeconds -lt 12
}

function Tear-Down {
  $script:downSince = $null
  if ($script:pub) { try { $script:pub.Stop() } catch {}; $script:pub = $null }
  if ($script:tm) { try { AwaitOp ($script:tm.StopTetheringAsync()) ([Windows.Networking.NetworkOperators.NetworkOperatorTetheringOperationResult]) | Out-Null } catch {}; $script:tm = $null }
}

# أي حاجة على stdin (أو قفله) = اقفل
$stdin = [Console]::OpenStandardInput()
$buf = New-Object byte[] 1
$stopTask = $stdin.ReadAsync($buf, 0, 1)

$wasUp = $false; $nextTry = [DateTime]::MinValue; $lastClients = ''; $ip = ''; $fails = 0
while ($true) {
  if ($stopTask.IsCompleted) { break }
  if (-not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  $up = Is-Up
  if (-not $up -and [DateTime]::Now -ge $nextTry) {
    Tear-Down
    $up = Bring-Up
    if ($up) { $fails = 0 } else {
      $fails++
      # بعد كذا محاولة: غالبًا الواي فاي بتاع الويندوز علّق (حصل فعلًا) — زرار الإصلاح بيعمل restart للخدمة
      Say @{ state = 'error'; message = $lastError; stuck = ($fails -ge 3) }
      # كل ما يفشل نستنى أكتر (8 → 15 → 30 → 60 ثانية) عشان منضغطش على الدرايفر
      $wait = @(8, 15, 30, 60)[[Math]::Min($fails - 1, 3)]
      $nextTry = [DateTime]::Now.AddSeconds($wait)
    }
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
    $key = "$ip|$($c.n)|$($c.ips -join ',')|$($c.req)|$($c.acc)|$($c.err)"
    if ($key -ne $lastClients) {
      Say @{ state = 'on'; mode = $mode; band = $band; ip = "$ip"; clients = $c.n; ips = @($c.ips); acceptError = $acceptError; requests = $c.req; accepted = $c.acc; joinError = $c.err }
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
    this.status = { state: 'off', mode: '', ip: '', message: '', clients: 0, ips: [], acceptError: '', requests: 0, accepted: 0, joinError: '' };
    this.restartTimer = null;
    this.repairing = false;
  }

  get supported() { return process.platform === 'win32'; }

  view() {
    return { ...this.status, repairing: this.repairing, ssid: this.wanted ? this.wanted.ssid : '', password: this.wanted ? this.wanted.password : '', supported: this.supported };
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
      // -MTA: طلب دخول الموبايل (حدث WinRT) بيوصل على thread تاني. في STA (الافتراضي) ومع Start-Sleep
      // مفيش حد بيستقبل الرسايل، فالطلب ممكن مايوصلش خالص والويندوز يرفض الموبايل
      child = spawn('powershell.exe', ['-MTA', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
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
            state: msg.state || 'error', mode: msg.mode || this.status.mode, band: msg.band || '', stuck: msg.stuck === true, ip: msg.ip || '', message: msg.message || '',
            clients: Number(msg.clients) || 0, ips: Array.isArray(msg.ips) ? msg.ips.filter(ip => /^192\.168\.137\.\d+$/.test(ip)) : [], acceptError: msg.acceptError || '',
            requests: Number(msg.requests) || 0, accepted: Number(msg.accepted) || 0, joinError: msg.joinError || '',
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

  /** إصلاح: بنقفل الشبكة ونستنى لحد ما تقفل فعلًا، وبعدين (بصلاحية أدمن) نعمل restart لكارت الواي فاي
   *  (بيرجّع الدرايفر لو علّق) ولخدمة الواي فاي (WlanSvc)، وبعدين نشغل الشبكة من الأول.
   *  كل خطوة ليها وقت أقصى، والإصلاح كله بيستسلم بعد 75 ثانية، و"وقّف الإصلاح" بيلغيه فورًا —
   *  قبل كده كان بيستنى للأبد لو الدرايفر مش بيرد، والجهاز علّق */
  async repair() {
    if (this.repairing) return { success: false, message: 'الإصلاح شغال بالفعل' };
    const wanted = this.wanted;
    this.repairing = true;
    let cancel;
    const cancelled = new Promise((resolve) => { cancel = resolve; });
    this.cancelRepair = () => cancel({ success: false, message: 'اتوقف الإصلاح' });
    try {
      await this.stopAndWait();
      return await Promise.race([
        runElevated(REPAIR_SCRIPT, { timeoutMs: 75 * 1000 }),
        cancelled,
      ]);
    } finally {
      this.cancelRepair = null;
      this.repairing = false;
      if (wanted && !this.wanted) this.start(wanted);
    }
  }

  /** "⛔ وقّف الإصلاح": منستناش الإصلاح، والشبكة بتشتغل تاني على طول */
  cancel() {
    if (this.cancelRepair) { this.cancelRepair(); return true; }
    return false;
  }

  /** زي stop بس بيستنى لحد ما عملية الشبكة تقفل فعلًا (عشان منعملش restart للواي فاي وهي لسه شغالة) */
  stopAndWait(maxMs = 10 * 1000) {
    const child = this.child;
    this.stop();
    if (!child || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* خلص */ } resolve(); }, maxMs);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
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
  const exe = String(exePath).replace(/'/g, "''");
  return runElevated([
    `$exe = '${exe}'; $name = '${FIREWALL_RULE}'`,
    'Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule',
    'New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Program $exe -Profile Any | Out-Null',
    'New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol UDP -LocalPort 47821 -Profile Any | Out-Null',
    "Get-NetFirewallApplicationFilter -Program $exe -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { \"$($_.Action)\" -eq 'Block' } | Disable-NetFirewallRule",
  ].join('\n'));
}

// الإصلاح (بيشتغل بصلاحية أدمن). كل خطوة جوه job ليها وقت أقصى: لو الدرايفر مش بيرد منعلقش — بنخرج بكود 7
const REPAIR_SCRIPT = String.raw`
function Within($sec, [scriptblock]$b) {
  $j = Start-Job -ScriptBlock $b
  if (Wait-Job $j -Timeout $sec) { Remove-Job $j -Force -ErrorAction SilentlyContinue; return $true }
  Stop-Job $j -ErrorAction SilentlyContinue; return $false
}
$ok = Within 25 { Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object { $_.InterfaceDescription -match 'Wireless|Wi-Fi|WiFi|WLAN|802\.11' } | Restart-NetAdapter -Confirm:$false -ErrorAction SilentlyContinue }
if (-not $ok) { exit 7 }
Start-Sleep -Seconds 3
$ok = Within 25 { Restart-Service WlanSvc -Force -ErrorAction Stop }
if (-not $ok) { exit 7 }
Start-Sleep -Seconds 4
exit 0
`;

// أمر PowerShell بصلاحية أدمن (رسالة الويندوز: Yes). timeoutMs: منستناش أكتر من كده (العملية نفسها بتقفل لوحدها)
function runElevated(inner, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve({ success: false, message: 'ويندوز بس' }); return; }
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    if (timeoutMs) {
      const t = setTimeout(() => finish({ success: false, message: 'الإصلاح طوّل ووقفناه — غالبًا درايفر الواي فاي علّق: اعمل Restart للكمبيوتر' }), timeoutMs);
      if (t.unref) t.unref();
    }
    const innerEncoded = Buffer.from(inner, 'utf16le').toString('base64');
    const outer = `try { $p = Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${innerEncoded}'; exit $p.ExitCode } catch { exit 5 }`;
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(outer, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    } catch (error) {
      resolve({ success: false, message: error.message });
      return;
    }
    child.on('error', error => finish({ success: false, message: error.message }));
    child.on('exit', code => finish(code === 0
      ? { success: true }
      : { success: false, message: code === 5 ? 'اتلغى — لازم توافق على رسالة الويندوز (Yes)'
        : code === 7 ? 'كارت الواي فاي مش بيرد (الدرايفر علّق) — اعمل Restart للكمبيوتر'
        : `ماتمش (كود ${code})` }));
  });
}

module.exports = { PcHotspot, allowInFirewall };
