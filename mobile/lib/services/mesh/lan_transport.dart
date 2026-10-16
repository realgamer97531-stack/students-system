// النقل بالواي فاي (راوتر السنتر أو هوت سبوت): عشان الموبايل يتكلم مع برنامج الكمبيوتر ومع الموبايلات التانية
// اللي على نفس الواي فاي. نفس البروتوكول اللي في desktop/runtime/mesh/lan.js بالظبط:
//   اكتشاف: UDP على 47821 {"t":"?","adv":...,"tcp":port} والرد مباشرة {"t":"!",...}
//   الاتصال: TCP، كل رسالة = 4 بايت طولها (big-endian) + البيانات، وأول رسالة من اللي بدأ = اسمه (adv)
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'mesh_core.dart';

class LanTransport implements MeshTransport {
  LanTransport({this.discoveryPort = 47821, List<int>? probePorts, this.targets, this.probeEvery = const Duration(seconds: 4)})
      : probePorts = probePorts ?? [discoveryPort];

  final int discoveryPort;
  final List<int> probePorts;
  final List<String>? targets;
  final Duration probeEvery;

  final _events = StreamController<MeshEvent>.broadcast();
  RawDatagramSocket? _udp;
  ServerSocket? _server;
  Timer? _timer;
  String _advert = '';
  final Map<String, Socket> _sockets = {};
  final Map<String, (InternetAddress, int, DateTime)> _found = {};

  @override
  int get maxBytes => 1024 * 1024;
  @override
  Stream<MeshEvent> get events => _events.stream;
  int get tcpPort => _server?.port ?? 0;

  void _emit(MeshEvent e) {
    if (!_events.isClosed) _events.add(e);
  }

  @override
  Future<void> start(String advertName) async {
    _advert = advertName;
    _server = await ServerSocket.bind(InternetAddress.anyIPv4, 0);
    _server!.listen(_accept, onError: (_) {});
    try {
      _udp = await RawDatagramSocket.bind(InternetAddress.anyIPv4, discoveryPort, reuseAddress: true);
    } catch (_) {
      _udp = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0); // البورت مشغول: الردود المباشرة لسه بتوصل
    }
    _udp!.broadcastEnabled = true;
    _udp!.listen((event) {
      if (event != RawSocketEvent.read) return;
      final dg = _udp?.receive();
      if (dg != null) _onDatagram(dg);
    });
    await _probe();
    _timer = Timer.periodic(probeEvery, (_) => _probe());
  }

  Future<List<String>> _targets() async {
    if (targets != null) return targets!;
    final out = <String>{'255.255.255.255'};
    try {
      for (final ni in await NetworkInterface.list(type: InternetAddressType.IPv4)) {
        for (final a in ni.addresses) {
          final p = a.address.split('.');
          if (p.length == 4 && !a.isLoopback) out.add('${p[0]}.${p[1]}.${p[2]}.255'); // أغلب الشبكات /24
        }
      }
    } catch (_) {}
    return out.toList();
  }

  Future<void> _probe() async {
    final udp = _udp;
    if (udp == null) return;
    final msg = utf8.encode(jsonEncode({'t': '?', 'adv': _advert, 'tcp': tcpPort}));
    for (final t in await _targets()) {
      for (final port in probePorts) {
        try {
          udp.send(msg, InternetAddress(t), port);
        } catch (_) {}
      }
    }
    final now = DateTime.now();
    for (final e in _found.entries.toList()) {
      if (now.difference(e.value.$3).inSeconds > 30) {
        _found.remove(e.key);
        _emit(MeshEvent('lost', id: e.key));
      }
    }
  }

  void _onDatagram(Datagram dg) {
    Map msg;
    try {
      msg = jsonDecode(utf8.decode(dg.data)) as Map;
    } catch (_) {
      return;
    }
    final t = msg['t'];
    final adv = msg['adv'];
    if ((t != '?' && t != '!') || adv is! String || adv == _advert) return;
    if (t == '?') {
      try {
        _udp?.send(utf8.encode(jsonEncode({'t': '!', 'adv': _advert, 'tcp': tcpPort})), dg.address, dg.port);
      } catch (_) {}
    }
    final port = (msg['tcp'] as num?)?.toInt() ?? 0;
    if (port == 0) return;
    final id = 'lan@${dg.address.address}:$port';
    final first = !_found.containsKey(id);
    _found[id] = (dg.address, port, DateTime.now());
    if (first) _emit(MeshEvent('found', id: id, name: adv));
  }

  void _accept(Socket socket) {
    final id = 'lan<${socket.remoteAddress.address}:${socket.remotePort}';
    var named = false;
    _wire(socket, id, (frame) {
      if (!named) {
        named = true;
        _sockets[id] = socket;
        _emit(MeshEvent('initiated', id: id, name: utf8.decode(frame), incoming: true));
        _emit(MeshEvent('result', id: id, ok: true));
        return;
      }
      _emit(MeshEvent('payload', id: id, data: frame));
    });
  }

  @override
  Future<bool> connect(String endpointId) async {
    final f = _found[endpointId];
    if (f == null) return false;
    try {
      final socket = await Socket.connect(f.$1, f.$2, timeout: const Duration(seconds: 8));
      _sockets[endpointId] = socket;
      _writeFrame(socket, Uint8List.fromList(utf8.encode(_advert)));
      _wire(socket, endpointId, (frame) => _emit(MeshEvent('payload', id: endpointId, data: frame)));
      _emit(MeshEvent('initiated', id: endpointId, name: '', incoming: false));
      _emit(MeshEvent('result', id: endpointId, ok: true));
      return true;
    } catch (_) {
      return false;
    }
  }

  void _wire(Socket socket, String id, void Function(Uint8List) onFrame) {
    try {
      socket.setOption(SocketOption.tcpNoDelay, true);
    } catch (_) {}
    var buffer = BytesBuilder(copy: false);
    var pending = Uint8List(0);
    socket.listen((chunk) {
      buffer.add(pending);
      buffer.add(chunk);
      var data = buffer.takeBytes();
      var offset = 0;
      while (data.length - offset >= 4) {
        final len = ByteData.sublistView(data, offset, offset + 4).getUint32(0);
        if (len > 4 * 1024 * 1024) {
          socket.destroy();
          return;
        }
        if (data.length - offset < 4 + len) break;
        onFrame(Uint8List.fromList(data.sublist(offset + 4, offset + 4 + len)));
        offset += 4 + len;
      }
      pending = Uint8List.fromList(data.sublist(offset));
    }, onDone: () => _closed(id, socket), onError: (_) => _closed(id, socket), cancelOnError: true);
  }

  void _closed(String id, Socket socket) {
    if (identical(_sockets[id], socket)) {
      _sockets.remove(id);
      _emit(MeshEvent('disconnected', id: id));
    }
  }

  void _writeFrame(Socket socket, Uint8List data) {
    final header = ByteData(4)..setUint32(0, data.length);
    socket.add(header.buffer.asUint8List());
    socket.add(data);
  }

  @override
  Future<bool> send(String endpointId, Uint8List data) async {
    final socket = _sockets[endpointId];
    if (socket == null) return false;
    try {
      _writeFrame(socket, data);
      return true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<void> disconnect(String endpointId) async {
    _sockets[endpointId]?.destroy();
  }

  @override
  Future<void> restart() async {
    _found.clear();
    await _probe();
  }

  @override
  Future<void> stop() async {
    _timer?.cancel();
    final sockets = _sockets.values.toList(); // destroy() بيشيل الاتصال من القايمة
    _sockets.clear();
    for (final s in sockets) {
      s.destroy();
    }
    _found.clear();
    await _server?.close();
    _udp?.close();
    _server = null;
    _udp = null;
  }
}

/// بيجمع أكتر من نقل (بلوتوث + واي فاي) في واحد: كل جهاز بيتعرف برقمه فمش بيتوصل بنفس الجهاز مرتين
class CombinedTransport implements MeshTransport {
  CombinedTransport(this.parts);
  final Map<String, MeshTransport> parts; // prefix -> transport
  final _events = StreamController<MeshEvent>.broadcast();
  final List<StreamSubscription<MeshEvent>> _subs = [];

  @override
  Stream<MeshEvent> get events => _events.stream;
  @override
  int get maxBytes => parts.values.map((t) => t.maxBytes).reduce((a, b) => a < b ? a : b);

  (MeshTransport, String) _split(String id) {
    final i = id.indexOf('|');
    return (parts[id.substring(0, i)]!, id.substring(i + 1));
  }

  @override
  Future<void> start(String advertName) async {
    Object? firstError;
    var started = 0;
    for (final entry in parts.entries) {
      _subs.add(entry.value.events.listen((e) => _events.add(MeshEvent(e.type,
          id: e.id.isEmpty ? '' : '${entry.key}|${e.id}', name: e.name, data: e.data, quality: e.quality, ok: e.ok, incoming: e.incoming, message: e.message))));
      try {
        await entry.value.start(advertName);
        started++;
      } catch (e) {
        firstError ??= e;
        _events.add(MeshEvent('error', message: '${entry.key}: $e'));
      }
    }
    if (started == 0 && firstError != null) throw firstError;
  }

  @override
  Future<void> restart() async {
    for (final t in parts.values) {
      try {
        await t.restart();
      } catch (_) {}
    }
  }

  @override
  Future<void> stop() async {
    for (final s in _subs) {
      await s.cancel();
    }
    _subs.clear();
    for (final t in parts.values) {
      try {
        await t.stop();
      } catch (_) {}
    }
  }

  @override
  Future<bool> connect(String endpointId) {
    final (t, id) = _split(endpointId);
    return t.connect(id);
  }

  @override
  Future<void> disconnect(String endpointId) {
    final (t, id) = _split(endpointId);
    return t.disconnect(id);
  }

  @override
  Future<bool> send(String endpointId, Uint8List data) {
    final (t, id) = _split(endpointId);
    return t.send(id, data);
  }
}
