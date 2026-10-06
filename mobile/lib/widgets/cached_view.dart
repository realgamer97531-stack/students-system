import 'package:flutter/material.dart';

import '../services/cache.dart';
import '../services/net.dart';
import 'common.dart';

/// بيعرض آخر نسخة محفوظة على طول، وبعدين بيجيب الجديد من السيرفر ويحدّث.
/// لو مفيش نت: بيفضل عارض المحفوظ مع شريط "مفيش نت".
class CachedView<T> extends StatefulWidget {
  const CachedView({
    super.key,
    required this.cacheKey,
    required this.fetch,
    required this.decode,
    required this.builder,
    this.onUnauthorized,
  });

  final String cacheKey;

  /// بيرجع البيانات بشكل ينفع يتحفظ JSON
  final Future<dynamic> Function() fetch;
  final T Function(dynamic json) decode;
  final Widget Function(BuildContext context, T data, Future<void> Function() refresh) builder;
  final VoidCallback? onUnauthorized;

  @override
  State<CachedView<T>> createState() => CachedViewState<T>();
}

class CachedViewState<T> extends State<CachedView<T>> {
  T? _data;
  DateTime? _savedAt;
  bool _stale = false;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    _start();
    Connection.online.addListener(_onConnection);
  }

  @override
  void dispose() {
    Connection.online.removeListener(_onConnection);
    super.dispose();
  }

  void _onConnection() {
    if (Connection.online.value && _stale && mounted) refresh();
  }

  Future<void> _start() async {
    final cached = await Cache.read(widget.cacheKey);
    if (cached != null && mounted) {
      try {
        setState(() {
          _data = widget.decode(cached.data);
          _savedAt = cached.savedAt;
          _stale = true;
        });
      } catch (_) {}
    }
    await refresh();
  }

  Future<void> refresh() async {
    if (mounted) setState(() { _loading = _data == null; _error = null; });
    try {
      final json = await widget.fetch();
      await Cache.write(widget.cacheKey, json);
      if (!mounted) return;
      setState(() {
        _data = widget.decode(json);
        _savedAt = DateTime.now();
        _stale = false;
      });
    } on ApiException catch (e) {
      if (e.unauthorized) {
        widget.onUnauthorized?.call();
        return;
      }
      if (mounted) setState(() { _error = e.message; _stale = true; });
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_data == null) {
      if (_loading) return const Center(child: CircularProgressIndicator());
      return ErrorView(message: _error ?? 'حصلت مشكلة', onRetry: refresh);
    }
    return Column(children: [
      if (_stale && _error != null) OfflineBanner(savedAt: _savedAt),
      Expanded(child: RefreshIndicator(onRefresh: refresh, child: widget.builder(context, _data as T, refresh))),
    ]);
  }
}
