import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

import 'screens/sign_in_screen.dart';
import 'screens/user_home_router.dart';
import 'services/qnb_api.dart';

/// Oturum yoksa [SignInScreen], varsa [UserHomeRouter] (role ile alt ekran).
class AuthWrapper extends StatelessWidget {
  const AuthWrapper({super.key, required this.api});

  final QnbApi api;

  @override
  Widget build(BuildContext context) {
    return StreamBuilder<User?>(
      stream: FirebaseAuth.instance.authStateChanges(),
      builder: (context, snapshot) {
        if (snapshot.connectionState == ConnectionState.waiting) {
          return const Scaffold(
            body: Center(child: CircularProgressIndicator()),
          );
        }
        final user = snapshot.data;
        if (user == null) {
          return const SignInScreen();
        }
        return UserHomeRouter(api: api, user: user);
      },
    );
  }
}
