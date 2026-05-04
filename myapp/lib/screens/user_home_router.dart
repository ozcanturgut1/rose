import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import '../services/qnb_api.dart';
import 'son_10_fatura_screen.dart';

/// Firestore `user_profiles/{uid}` → `role` zorunlu; tanımsız / boş / desteklenmeyen rol → erişim yok.
///
/// - **admin** → portal + tarih + Sorgula + tüm araçlar
/// - **ara_onay** / **nihai_onay** → yalnızca Firestore listesi (tarih/sorgu yok; tüm uygun faturalar)
/// - **muhasebe** → yalnızca `onayDurumu == onaylandı` faturalar (Firestore, tarih/sorgu yok)
/// - **depo** → son 10 portal faturası listesi (salt okuma API ile aynı ekran)
class UserHomeRouter extends StatelessWidget {
  const UserHomeRouter({super.key, required this.api, required this.user});

  final QnbApi api;
  final User user;

  static String? _normalizeRole(String? raw) {
    if (raw == null) return null;
    final s = raw.trim();
    if (s.isEmpty) return null;
    return s.toLowerCase().replaceAll(RegExp(r'\s+'), '_');
  }

  static bool _isAllowedRole(String? normalized) {
    return normalized == 'admin' ||
        normalized == 'ara_onay' ||
        normalized == 'nihai_onay' ||
        normalized == 'muhasebe' ||
        normalized == 'depo';
  }

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<DocumentSnapshot<Map<String, dynamic>>>(
      stream: FirebaseFirestore.instance
          .collection('user_profiles')
          .doc(user.uid)
          .snapshots(),
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return _BlockedAccessScreen(
            message:
                'Profil okunamadı. Firestore kurallarını kontrol edin veya yöneticiye bildirin.\n\n${snapshot.error}',
          );
        }
        if (snapshot.connectionState == ConnectionState.waiting && !snapshot.hasData) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }

        final doc = snapshot.data;
        if (doc == null || !doc.exists) {
          return _BlockedAccessScreen(
            message:
                'Hesabınızda rol tanımlı değil.\n\nFirestore\'da `user_profiles/${user.uid}` belgesi ve `role` alanı oluşturulmalı.',
          );
        }

        final data = doc.data();
        final roleRaw = data?['role'] as String?;
        final normalized = _normalizeRole(roleRaw);

        if (normalized == null) {
          return _BlockedAccessScreen(
            message:
                'Hesabınızda geçerli bir rol tanımlı değil (`role` boş olamaz).\n\nYönetici, `user_profiles/${user.uid}` belgesine uygun `role` yazmalıdır.',
          );
        }

        if (!_isAllowedRole(normalized)) {
          return _BlockedAccessScreen(
            message:
                'Desteklenmeyen rol: ${roleRaw ?? normalized}\n\nYalnızca admin, ara_onay, nihai_onay, muhasebe veya depo kullanılabilir.',
          );
        }

        switch (normalized) {
          case 'depo':
            return Son10FaturaScreen(
              api: api,
              userRole: roleRaw ?? normalized,
              profileBirim: data?['birim']?.toString(),
            );
          case 'admin':
          case 'ara_onay':
          case 'nihai_onay':
          case 'muhasebe':
            return Son10FaturaScreen(
              api: api,
              userRole: roleRaw ?? normalized,
              profileBirim: data?['birim']?.toString(),
            );
          default:
            return _BlockedAccessScreen(message: 'Beklenmeyen rol: $normalized');
        }
      },
    );
  }
}

class _BlockedAccessScreen extends StatelessWidget {
  const _BlockedAccessScreen({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Erişim engellendi'),
        automaticallyImplyLeading: false,
        actions: [
          IconButton(
            tooltip: 'Çıkış',
            onPressed: () => FirebaseAuth.instance.signOut(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      ),
    );
  }
}

class _PlaceholderRoleScreen extends StatelessWidget {
  const _PlaceholderRoleScreen({
    required this.title,
    required this.message,
  });

  final String title;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        actions: [
          IconButton(
            tooltip: 'Çıkış',
            onPressed: () => FirebaseAuth.instance.signOut(),
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyLarge,
          ),
        ),
      ),
    );
  }
}
