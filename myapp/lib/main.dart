import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/material.dart';

import 'myapp.dart';


void main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await Firebase.initializeApp(
   options: FirebaseOptions(
         apiKey: "AIzaSyCzX3tGsTWHkbYMJSd4MVIJuq6SWhYwxE0",
          appId: "1:741263300188:web:c0a3233b0d8667a9667899",
          messagingSenderId: "741263300188",
          projectId: "curious-nucleus-392008",
          storageBucket: "curious-nucleus-392008.appspot.com",

    )
  );
  // ESET SSL taraması açık Firestore kanalını düşürür. Web uzun yoklama kullanır.
  FirebaseFirestore.instance.settings = const Settings(
    webExperimentalForceLongPolling: true,
  );
  runApp(MyApp());

}




