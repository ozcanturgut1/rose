import 'package:flutter/material.dart';

import 'auth_wrapper.dart';
import 'services/qnb_api.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    final api = QnbApi(
      baseListUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/listQnbDocs',
      baseApproveUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/approveQnbDoc',
      baseViewUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/viewQnbDoc',
      baseEnrichUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/enrichInvoiceWithRelatedDespatches',
      baseRelatedDespatchesUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/getInvoiceRelatedDespatches',
      baseSyncUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/syncQnbDocs',
      baseDebugLastInvoiceIrsaliyeUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/debugQnbLastInvoiceIrsaliye',
      baseFetchAndSaveDespatchUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/fetchAndSaveDespatchByBelgeNo',
      baseFetchAndSaveInvoiceUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/fetchAndSaveInvoiceByEttn',
      baseSyncAllDespatchesUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/syncAllDespatches',
      baseSyncAllInvoicesUrl: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/syncAllInvoices',
      baseSyncAndEnrichInvoices2026Url: 'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/syncAndEnrichInvoices2026',
      baseListGelenBelgeleriExtUrl:
          'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/listGelenBelgeleriExt',
      baseBackfillInvoicesFullByDateRangeUrl:
          'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/backfillInvoicesFullByDateRange',
      baseBackfillDespatchEttnFromQnbDocsUrl:
          'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/backfillDespatchEttnFromQnbDocs',
      baseEnrichInvoiceDespatchesUblByEttnUrl:
          'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/enrichInvoiceDespatchesUblByEttn',
      baseUpdateQnbInvoiceYonetimOnayUrl:
          'https://europe-west1-curious-nucleus-392008.cloudfunctions.net/updateQnbInvoiceYonetimOnay',
    );

    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: 'TEKNIK',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: AuthWrapper(api: api),
    );
  }
}




