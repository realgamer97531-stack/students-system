import 'package:flutter/material.dart';

/// نفس ألوان السيستم والموقع
class AppColors {
  static const primary = Color(0xFF4338CA);
  static const primaryDark = Color(0xFF312E81);
  static const accent = Color(0xFF14B8A6);
  static const warning = Color(0xFFF59E0B);
  static const danger = Color(0xFFE11D48);
  static const bg = Color(0xFFF4F5FC);
  static const text = Color(0xFF181527);
  static const muted = Color(0xFF6B7280);
  static const successSoft = Color(0xFFD1FAE5);
  static const successText = Color(0xFF047857);
  static const warningSoft = Color(0xFFFEF3C7);
  static const warningText = Color(0xFF92400E);
  static const dangerSoft = Color(0xFFFEE2E2);
  static const dangerText = Color(0xFFB91C1C);
  static const neutralSoft = Color(0xFFF3F4F6);
}

ThemeData buildTheme() {
  final scheme = ColorScheme.fromSeed(seedColor: AppColors.primary, primary: AppColors.primary, secondary: AppColors.accent, surface: Colors.white);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: 'Cairo',
    scaffoldBackgroundColor: AppColors.bg,
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.primaryDark,
      foregroundColor: Colors.white,
      centerTitle: true,
      titleTextStyle: TextStyle(fontFamily: 'Cairo', fontSize: 18, fontWeight: FontWeight.w700, color: Colors.white),
    ),
    cardTheme: CardThemeData(
      color: Colors.white,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16)),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: Colors.white,
      border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Color(0xFFE2E4F3))),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: Color(0xFFE2E4F3))),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: AppColors.primary, width: 2)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(50),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        textStyle: const TextStyle(fontFamily: 'Cairo', fontSize: 16, fontWeight: FontWeight.w700),
      ),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: Colors.white,
      indicatorColor: AppColors.primary.withValues(alpha: 0.12),
      labelTextStyle: WidgetStateProperty.all(const TextStyle(fontFamily: 'Cairo', fontSize: 12, fontWeight: FontWeight.w600)),
    ),
  );
}
