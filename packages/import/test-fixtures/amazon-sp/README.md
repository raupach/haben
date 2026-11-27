# Antworten der SP-API von Amazon (#1947)

`getreports-seite-1.json` und `getreports-seite-2.json` sind eine echte Antwort von `GET /reports/2021-06-30/reports`
(`reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`) eines Verkäuferkontos in der Region EU vom 26.11.2026, auf zwei
Seiten verteilt.

- **Echt:** Aufbau, Felder, `processingStatus`, Zeitpunkte und die Liste `marketplaceIds`. Jeder Report nennt dieselben 18
  Marktplätze; welcher Marktplatz es ist, steht erst in der Datei (`marketplace-name`). Die ersten drei Reports wurden am
  19.11.2026 erzeugt, ihre Abrechnungszeiträume liegen im Dezember 2025 bis Februar 2026: Amazon erzeugt alte Abrechnungen
  neu, etwa nach einem Download in Seller Central.
- **Ersetzt:** `reportId` (100000000001 …) und `reportDocumentId`; `nextToken` (echt: 672 Zeichen) durch `BEISPIELNEXTTOKEN`.

Die Report-Datei selbst war am echten Konto Byte für Byte im Format des Downloads aus Seller Central (deutsche Beträge,
`TT.MM.JJJJ`, UTF-8 ohne BOM, nicht komprimiert); dafür steht `../amazon-settlement.txt`.
