import 'package:flutter/material.dart';

import 'auth_wrapper.dart';
import 'config/qnb_functions_base.dart';
import 'services/qnb_api.dart';

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    final api = QnbApi(
      baseListUrl: qnbFunctionUrl('listQnbDocs'),
      baseApproveUrl: qnbFunctionUrl('approveQnbDoc'),
      baseViewUrl: qnbFunctionUrl('viewQnbDoc'),
      baseEnrichUrl: qnbFunctionUrl('enrichInvoiceWithRelatedDespatches'),
      baseRelatedDespatchesUrl: qnbFunctionUrl('getInvoiceRelatedDespatches'),
      baseSyncUrl: qnbFunctionUrl('syncQnbDocs'),
      baseDebugLastInvoiceIrsaliyeUrl: qnbFunctionUrl('debugQnbLastInvoiceIrsaliye'),
      baseFetchAndSaveDespatchUrl: qnbFunctionUrl('fetchAndSaveDespatchByBelgeNo'),
      baseFetchAndSaveInvoiceUrl: qnbFunctionUrl('fetchAndSaveInvoiceByEttn'),
      baseSyncAllDespatchesUrl: qnbFunctionUrl('syncAllDespatches'),
      baseSyncAllInvoicesUrl: qnbFunctionUrl('syncAllInvoices'),
      baseSyncAndEnrichInvoices2026Url: qnbFunctionUrl('syncAndEnrichInvoices2026'),
      baseListGelenBelgeleriExtUrl: qnbFunctionUrl('listGelenBelgeleriExt'),
      baseBackfillInvoicesFullByDateRangeUrl:
          qnbFunctionUrl('backfillInvoicesFullByDateRange'),
      baseBackfillDespatchEttnFromQnbDocsUrl:
          qnbFunctionUrl('backfillDespatchEttnFromQnbDocs'),
      baseEnrichInvoiceDespatchesUblByEttnUrl:
          qnbFunctionUrl('enrichInvoiceDespatchesUblByEttn'),
      baseUpdateQnbInvoiceYonetimOnayUrl:
          qnbFunctionUrl('updateQnbInvoiceYonetimOnay'),
      baseListAraOnayUsersUrl: qnbFunctionUrl('listAraOnayUsers'),
      baseAssignQnbInvoiceAraOnayUrl: qnbFunctionUrl('assignQnbInvoiceAraOnay'),
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
