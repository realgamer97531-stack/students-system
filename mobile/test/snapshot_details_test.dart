import 'package:flutter_test/flutter_test.dart';
import 'package:studyisfunny_app/services/staff_store.dart';

void main() {
  test('offline attendance sheet gets the same details as the online lookup', () {
    final snap = Snapshot({
      'centers': [{'id': 1, 'name': 'سنتر أ'}, {'id': 2, 'name': 'سنتر ب'}],
      'subjects': [{'id': 5, 'name': 'Physics'}],
      'sessions': [],
      'students': [[10, 'STU-00010', 'أحمد', 5, 1, 100, 50, 0, null]],
      'details': {
        'v': 1,
        'history': [[10, 1, 1], [10, 3, 2]],
        'groups': [[1, 5, 1], [1, 5, 2], [1, 5, 3], [2, 5, 4]],
        'exams': [[10, 'امتحان شهر', 18, 20, '2026-10-01']],
        'booklets': [[7, 5, 'بوكليت 1', 120], [8, 5, 'بوكليت 2', 100], [9, 6, 'مادة تانية', 50]],
        'studentBooklets': [[10, 7, 100, 60, 0]],
        'reservations': [[10, 8, 'pending']],
        'followUp': [[10, 'منى']],
      },
    });
    final s = snap.student('10')!;
    final d = snap.lookupDetails(s);
    final summary = (d['summary'] as List).cast<Map>();
    expect(summary.map((r) => r['lessonNumber']), [1, 2, 3]);
    expect(summary.map((r) => r['attended']), [true, false, true]);
    expect(summary[2]['attendedWhere'], 'سنتر ب');
    expect((d['independentExamResults'] as List).single['score'], 18);
    final booklets = (d['bookletStatuses'] as List).cast<Map>();
    expect(booklets.length, 2, reason: 'only the student subject');
    expect(booklets[0]['sellPrice'], 100, reason: 'custom price from the student record');
    expect(booklets[0]['remaining'], 40);
    expect(booklets[1]['remaining'], 100);
    expect(booklets[1]['reservationStatus'], 'pending');
    expect((d['followUpAssistant'] as Map)['name'], 'منى');
  });

  test('old snapshot without details still works (empty extras)', () {
    final snap = Snapshot({'students': [[1, 'STU-00001', 'x', 1, 1, 0, 0, 0, null]]});
    expect(snap.lookupDetails(snap.student('1')!), isEmpty);
  });
}
