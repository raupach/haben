/** Grobe Restzeit des Amazon-Abrufs beim Warten: Amazon erlaubt etwa einen Download je Minute */
export function restMinuten(stand: { nummer: number; gesamt: number; wartenBis: string }, jetzt: number): number {
  return Math.max(1, Math.ceil((Date.parse(stand.wartenBis) - jetzt) / 60_000) + (stand.gesamt - stand.nummer));
}
