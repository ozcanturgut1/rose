import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';

/// Kullanıcı adı + şifre ile giriş veya kayıt.
///
/// Firebase yalnızca e-posta/şifre sağlayıcısını desteklediği için kullanıcı adı,
/// dahili olarak `kullaniciadi@<sabitDomain>` biçimine çevrilir (kullanıcıya gösterilmez).
/// Firebase Console’da E-posta-Şifre girişi açık olmalı.
class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});

  /// Sentetik e-posta alanı; gerçek bir posta sunucusu ile ilişkili olması gerekmez.
  static const syntheticEmailDomain = 'app.teknapp.local';

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _username = TextEditingController();
  final _password = TextEditingController();
  final _formKey = GlobalKey<FormState>();
  bool _loading = false;
  bool _obscure = true;
  bool _registerMode = false;
  String? _error;

  static final _usernamePattern = RegExp(r'^[a-zA-Z0-9._-]{2,64}$');

  @override
  void dispose() {
    _username.dispose();
    _password.dispose();
    super.dispose();
  }

  /// Firebase `signInWithEmailAndPassword` için tek biçimli adres.
  String _usernameToSyntheticEmail(String raw) {
    final u = raw.trim().toLowerCase();
    return '$u@${SignInScreen.syntheticEmailDomain}';
  }

  String? _validateUsername(String? v) {
    final s = v?.trim() ?? '';
    if (s.isEmpty) return 'Kullanıcı adı gerekli';
    if (!_usernamePattern.hasMatch(s)) {
      return '2–64 karakter; harf, rakam, . _ - kullanılabilir';
    }
    return null;
  }

  String _trAuthError(FirebaseAuthException e) {
    switch (e.code) {
      case 'user-not-found':
      case 'wrong-password':
      case 'invalid-credential':
        return 'Kullanıcı adı veya şifre hatalı.';
      case 'invalid-email':
        return 'Kullanıcı adı geçersiz karakter içeriyor.';
      case 'user-disabled':
        return 'Bu hesap devre dışı.';
      case 'email-already-in-use':
        return 'Bu kullanıcı adı zaten kayıtlı.';
      case 'weak-password':
        return 'Şifre en az 6 karakter olmalı.';
      case 'too-many-requests':
        return 'Çok fazla deneme. Lütfen sonra tekrar deneyin.';
      case 'operation-not-allowed':
        return 'E-posta/şifre girişi Firebase’de etkin değil.';
      default:
        return e.message ?? e.code;
    }
  }

  Future<void> _submit() async {
    setState(() => _error = null);
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _loading = true);
    try {
      final email = _usernameToSyntheticEmail(_username.text);
      final password = _password.text;
      if (_registerMode) {
        await FirebaseAuth.instance.createUserWithEmailAndPassword(
          email: email,
          password: password,
        );
      } else {
        await FirebaseAuth.instance.signInWithEmailAndPassword(
          email: email,
          password: password,
        );
      }
    } on FirebaseAuthException catch (e) {
      setState(() => _error = _trAuthError(e));
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 400),
            child: SingleChildScrollView(
              padding: const EdgeInsets.all(24),
              child: Form(
                key: _formKey,
                child: Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'TEKNIK',
                      style: Theme.of(context).textTheme.headlineMedium,
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _registerMode ? 'Yeni hesap oluştur' : 'Giriş yap',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 28),
                    TextFormField(
                      controller: _username,
                      decoration: const InputDecoration(
                        labelText: 'Kullanıcı adı',
                        border: OutlineInputBorder(),
                      ),
                      keyboardType: TextInputType.text,
                      autocorrect: false,
                      textInputAction: TextInputAction.next,
                      validator: _validateUsername,
                    ),
                    const SizedBox(height: 12),
                    TextFormField(
                      controller: _password,
                      obscureText: _obscure,
                      decoration: InputDecoration(
                        labelText: 'Şifre',
                        border: const OutlineInputBorder(),
                        suffixIcon: IconButton(
                          icon: Icon(_obscure ? Icons.visibility : Icons.visibility_off),
                          onPressed: () => setState(() => _obscure = !_obscure),
                        ),
                      ),
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _submit(),
                      validator: (v) =>
                          (v == null || v.isEmpty) ? 'Şifre gerekli' : null,
                    ),
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(
                        _error!,
                        style: TextStyle(color: Theme.of(context).colorScheme.error),
                      ),
                    ],
                    const SizedBox(height: 20),
                    FilledButton(
                      onPressed: _loading ? null : _submit,
                      child: _loading
                          ? const SizedBox(
                              height: 22,
                              width: 22,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : Text(_registerMode ? 'Kayıt ol' : 'Giriş yap'),
                    ),
                    TextButton(
                      onPressed: _loading
                          ? null
                          : () => setState(() {
                                _registerMode = !_registerMode;
                                _error = null;
                              }),
                      child: Text(
                        _registerMode ? 'Zaten hesabım var — giriş' : 'Hesap oluştur',
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
