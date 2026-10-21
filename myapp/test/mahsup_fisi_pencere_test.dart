import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:myapp/widgets/muhasebe_fisi_dialog.dart';

void main() {
  testWidgets('pencere acikken alttaki liste kayar ve basliktan suruklenir', (tester) async {
    final kaydirma = ScrollController();
    addTearDown(kaydirma.dispose);
    late StateSetter yenile;
    var sol = 480.0;
    var ust = 8.0;

    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: StatefulBuilder(
            builder: (context, setState) {
              yenile = setState;
              return Stack(
                children: [
                  Positioned.fill(
                    child: ListView.builder(
                      controller: kaydirma,
                      itemCount: 40,
                      itemBuilder: (_, i) => SizedBox(
                        height: 72,
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text('Satir $i'),
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    left: sol,
                    top: ust,
                    width: 280,
                    height: 220,
                    child: MahsupFisiYuzerPencere(
                      fis: null,
                      belgeNo: 'TEST1',
                      onKapat: () {},
                      onSurukle: (delta) {
                        yenile(() {
                          sol += delta.dx;
                          ust += delta.dy;
                        });
                      },
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );

    expect(find.text('Mahsup Fişi'), findsOneWidget);
    final once = kaydirma.offset;
    await tester.dragFrom(const Offset(24, 200), const Offset(0, -240));
    await tester.pumpAndSettle();
    expect(kaydirma.offset, greaterThan(once));

    final baslikOnce = tester.getTopLeft(find.text('Mahsup Fişi'));
    await tester.drag(find.text('Mahsup Fişi'), const Offset(-50, 36));
    await tester.pumpAndSettle();
    final baslikSonra = tester.getTopLeft(find.text('Mahsup Fişi'));
    expect(baslikSonra.dx, lessThan(baslikOnce.dx - 20));
    expect(baslikSonra.dy, greaterThan(baslikOnce.dy + 10));
  });
}
