import 'package:flutter/material.dart';
import 'package:flutter_math_fork/flutter_math.dart';

/// نص فيه معادلات LaTeX بين \( \) (في السطر) أو \[ \] (سطر لوحدها) — نفس اللي بيكتبه المساعد في الموقع.
final _mathRe = RegExp(r'\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]');
final _placeholderRe = RegExp(r'\\placeholder(\[[^\]]*\])?\{[^{}]*\}');

class MathText extends StatelessWidget {
  const MathText(this.text, {super.key, this.style});
  final String text;
  final TextStyle? style;

  Widget _math(String latex, TextStyle base, {required bool display}) {
    final clean = latex.replaceAll(_placeholderRe, '');
    return Directionality(
      textDirection: TextDirection.ltr,
      // المعادلات العريضة (مصفوفة مثلًا) بتتسحب بالعرض بدل ما تكسر الشاشة
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Math.tex(
          clean,
          mathStyle: display ? MathStyle.display : MathStyle.text,
          textStyle: base,
          onErrorFallback: (_) => Text(clean, style: base.copyWith(fontFamily: 'monospace')),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final base = DefaultTextStyle.of(context).style.merge(style);
    final blocks = <Widget>[];
    final spans = <InlineSpan>[];
    void flush() {
      if (spans.isEmpty) return;
      blocks.add(Text.rich(TextSpan(children: List.of(spans)), style: base));
      spans.clear();
    }

    var last = 0;
    for (final m in _mathRe.allMatches(text)) {
      if (m.start > last) spans.add(TextSpan(text: text.substring(last, m.start)));
      if (m.group(2) != null) {
        flush();
        blocks.add(Padding(
          padding: const EdgeInsets.symmetric(vertical: 6),
          child: Center(child: _math(m.group(2)!, base, display: true)),
        ));
      } else {
        spans.add(WidgetSpan(alignment: PlaceholderAlignment.middle, child: _math(m.group(1)!, base, display: false)));
      }
      last = m.end;
    }
    if (last < text.length) spans.add(TextSpan(text: text.substring(last)));
    flush();
    if (blocks.isEmpty) return const SizedBox.shrink();
    if (blocks.length == 1) return blocks.first;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: blocks);
  }
}
