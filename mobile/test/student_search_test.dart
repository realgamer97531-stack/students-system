import 'package:flutter_test/flutter_test.dart';
import 'package:studyisfunny_app/screens/staff/student_search.dart';
import 'package:studyisfunny_app/services/staff_store.dart';

void main() {
  // حصة 100 = سنتر 1 + مادة 5
  final snap = Snapshot({
    'centers': [{'id': 1, 'name': 'سنتر أ'}, {'id': 2, 'name': 'سنتر ب'}],
    'subjects': [{'id': 5, 'name': 'Physics'}, {'id': 6, 'name': 'Chemistry'}],
    'sessions': [{'id': 100, 'lesson_number': 3, 'CenterId': 1, 'SubjectId': 5}],
    'students': [
      [1, 'STU-00001', 'مادة تانية', 6, 1, 0, 0, 0, null, '01011112222', '01200000000', 0],
      [2, 'STU-00002', 'نفس المادة', 5, 2, 0, 0, 0, null, '01033334444', '01211112222', 0],
      [3, 'STU-00003', 'نفس المجموعة', 5, 1, 0, 0, 0, null, '01055556666', '01011112299', 0],
      [4, 'STU-00004', 'رقم مختلف', 5, 1, 0, 0, 0, null, '01099999999', null, 0],
    ],
    'attendance': [[3, 100]],
  });

  test('exact code wins and is not mixed with phone matches', () {
    final r = searchLocal(snap, '4', 100);
    expect(r.exactCode, 'STU-00004');
    expect(r.hits.map((h) => h.code), ['STU-00004']);
  });

  test('part of a phone: student phone or parent phone, same group first then same subject', () {
    final r = searchLocal(snap, '11112', 100);
    expect(r.exactCode, isNull);
    expect(r.hits.map((h) => h.name), ['نفس المجموعة', 'نفس المادة', 'مادة تانية']);
    expect(r.hits.map((h) => h.match), [0, 1, 2]);
    expect(r.hits.first.present, isTrue);
  });

  test('one match only', () {
    final r = searchLocal(snap, '0105555', 100);
    expect(r.hits.single.code, 'STU-00003');
  });

  test('full number with +20, arabic digits and spaces', () {
    expect(searchLocal(snap, '+20 1099999999', 100).hits.single.code, 'STU-00004');
    expect(searchLocal(snap, '٠١٠٩٩٩٩٩٩٩٩', 100).hits.single.code, 'STU-00004');
  });

  test('a code that does not exist is not searched as a phone, short input is not either', () {
    expect(searchLocal(snap, 'STU-01111', 100).hits, isEmpty);
    expect(searchLocal(snap, '09', 100).hits, isEmpty); // مش كود موجود وأقل من 3 أرقام
  });
}
