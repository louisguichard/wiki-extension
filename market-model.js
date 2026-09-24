(() => {
  const asPositive = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  };

  function normalizeAuction(raw) {
    if (!raw || !raw.id || !raw.card_id) return null;
    const currentPrice = asPositive(raw.effective_bid)
      ?? asPositive(raw.current_bid)
      ?? asPositive(raw.base_amount);
    if (currentPrice == null) return null;

    return {
      id: String(raw.id),
      cardId: String(raw.card_id),
      title: String(raw.card?.wikipedia_title || 'Carte sans titre'),
      rarity: String(raw.snapshot_rarity || raw.card?.rarity || ''),
      currentPrice,
      basePrice: asPositive(raw.base_amount),
      currentBid: asPositive(raw.current_bid),
      endAt: raw.end_at || null,
      status: raw.status || null,
      imageUrl: raw.card?.image_url || null,
      shiny: Boolean(raw.is_shiny),
      owned: Boolean(raw.owned),
      atk: Number.isFinite(Number(raw.snapshot_atk)) ? Number(raw.snapshot_atk) : null,
      def: Number.isFinite(Number(raw.snapshot_def)) ? Number(raw.snapshot_def) : null,
      pageviews: Number.isFinite(Number(raw.card?.pageviews)) ? Number(raw.card.pageviews) : null,
      qualityScore: Number.isFinite(Number(raw.card?.q_score)) ? Number(raw.card.q_score) : null,
      category: raw.card?.category || null
    };
  }

  function averageFor(averages, rarity) {
    const exact = asPositive(averages?.[rarity]);
    if (exact != null) return exact;
    const values = Object.values(averages || {}).map(asPositive).filter((value) => value != null);
    return values.length === 1 ? values[0] : null;
  }

  function metrics(auction, average) {
    if (!auction || average == null || average <= 0 || auction.currentPrice <= 0) return null;
    return {
      ratio: average / auction.currentPrice,
      gap: average - auction.currentPrice,
      discountPercent: (1 - auction.currentPrice / average) * 100
    };
  }

  function isActive(auction, now = Date.now()) {
    return auction?.status === 'active' &&
      (!auction.endAt || Date.parse(auction.endAt) > now);
  }

  function isDeal(auction, average) {
    return isActive(auction) && (metrics(auction, average)?.ratio ?? 0) >= 2;
  }

  const model = { normalizeAuction, averageFor, metrics, isActive, isDeal };
  if (typeof module !== 'undefined' && module.exports) module.exports = model;
  if (typeof window !== 'undefined') window.WMMAModel = model;
})();
