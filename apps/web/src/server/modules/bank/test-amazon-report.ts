/*
 * Kleiner Settlement Report (Format V2) für Tests, in der Schreibweise von Seller Central und der SP-API (am echten
 * Konto geprüft: deutsche Beträge, TT.MM.JJJJ): eine Bestellung mit Erlös 119,00 und Gebühr 14,27, Auszahlung 104,73.
 * Ergibt drei Umsätze. Kennungen erfunden.
 */

const HEADER = [
  "settlement-id",
  "settlement-start-date",
  "settlement-end-date",
  "deposit-date",
  "total-amount",
  "currency",
  "transaction-type",
  "order-id",
  "merchant-order-id",
  "adjustment-id",
  "shipment-id",
  "marketplace-name",
  "amount-type",
  "amount-description",
  "amount",
  "fulfillment-id",
  "posted-date",
  "posted-date-time",
  "order-item-code",
  "merchant-order-item-id",
  "merchant-adjustment-item-id",
  "sku",
  "quantity-purchased",
  "promotion-id",
].join("\t");

export function amazonReport(o: { settlementId?: string; marketplace?: string; currency?: string; order?: string } = {}): Uint8Array {
  const id = o.settlementId ?? "10000000001";
  const marketplace = o.marketplace ?? "Amazon.de";
  const order = o.order ?? "302-0000000-0000001";
  const zeile = (werte: Record<number, string>) => {
    const c: string[] = Array(24).fill("");
    c[0] = id;
    for (const [i, v] of Object.entries(werte)) c[Number(i)] = v;
    return c.join("\t");
  };
  const position = (amountType: string, description: string, amount: string) =>
    zeile({
      6: "Order",
      7: order,
      8: order,
      11: marketplace,
      12: amountType,
      13: description,
      14: amount,
      15: "AFN",
      16: "03.11.2026",
      17: "03.11.2026 12:00:00 UTC",
    });
  return new TextEncoder().encode(
    [
      HEADER,
      zeile({ 1: "01.11.2026 21:09:34 UTC", 2: "15.11.2026 21:09:34 UTC", 3: "17.11.2026 21:09:34 UTC", 4: "104,73", 5: o.currency ?? "EUR" }),
      position("ItemPrice", "Principal", "119,00"),
      position("ItemFees", "Commission", "-14,27"),
    ].join("\n"),
  );
}
