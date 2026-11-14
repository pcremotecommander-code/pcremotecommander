'use strict';

async function showLocalPrice() {
  const prices = document.querySelectorAll('[data-pro-price]');
  if (!prices.length) return;
  try {
    const response = await fetch('/billing/pricing-config', {cache: 'no-store', credentials: 'omit'});
    if (!response.ok) throw Error('Price preview unavailable');
    const config = await response.json();
    if (!window.Paddle) {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.append(script);
      });
    }
    if (!document.querySelector('script[data-pcrc-checkout]')) {
      if (config.environment === 'sandbox') Paddle.Environment.set('sandbox');
      Paddle.Initialize({token: config.token});
    }
    // Omit currency/location overrides so Paddle uses its current visitor-localized quote.
    const preview = await Paddle.PricePreview({items: [{priceId: config.priceId, quantity: 1}]});
    const item = preview.data.details.lineItems.find(item => item.price.id === config.priceId);
    const amount = item?.formattedTotals?.total;
    if (typeof amount !== 'string' || !amount || amount.length > 100) throw Error('Invalid price preview');
    for (const price of prices) price.textContent = amount + '/month';
    for (const note of document.querySelectorAll('[data-price-note]')) {
      note.textContent = 'Current Paddle estimate including applicable tax. Final amount and renewal terms are confirmed at checkout.';
    }
  } catch {
    for (const note of document.querySelectorAll('[data-price-note]')) {
      note.textContent = 'Base price: USD 15/month plus applicable tax. Local price preview unavailable; checkout confirms your currency and total.';
    }
  }
}

document.addEventListener('DOMContentLoaded', showLocalPrice, {once: true});
