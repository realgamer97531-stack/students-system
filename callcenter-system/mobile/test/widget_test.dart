import 'package:callcenter_app/config.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('call center URL is https on the production host', () {
    final uri = Uri.parse(AppConfig.callCenterUrl);
    expect(uri.scheme, 'https');
    expect(uri.host, 'callcenter-system-production.up.railway.app');
  });
}
