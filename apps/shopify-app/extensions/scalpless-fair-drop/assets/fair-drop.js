/* Scalpless fair drop — reads the drop straight from Sui (GraphQL, CORS-open) in the shopper's
   browser, keeps the numbers live, and replaces the theme's buy buttons on fair-drop products. */
(function () {
  var TIERS = ['Any verified human', 'Selfie Check', 'Passport / NFC', 'Proof of Human'];
  var REFRESH_MS = 15000;

  function sui(mist) {
    var v = Number(mist) / 1e9;
    return (v >= 1 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, '') + ' SUI';
  }

  function left(ms) {
    if (ms <= 0) return null;
    var m = Math.floor(ms / 60000);
    var h = Math.floor(m / 60);
    var d = Math.floor(h / 24);
    if (d > 0) return d + 'd ' + (h % 24) + 'h';
    if (h > 0) return h + 'h ' + (m % 60) + 'm';
    return m + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
  }

  function fetchDrop(url, id) {
    return fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query($id: SuiAddress!) { object(address: $id) { asMoveObject { contents { json } } } }',
        variables: { id: id },
      }),
    })
      .then(function (r) { return r.json(); })
      .then(function (b) {
        var o = b && b.data && b.data.object;
        if (!o) throw new Error('drop not found');
        return o.asMoveObject.contents.json;
      });
  }

  function disableCart(root) {
    // Theme-agnostic: hide the buy buttons of the product form(s) on this page.
    var forms = document.querySelectorAll('form[action*="/cart/add"]');
    forms.forEach(function (form) {
      form.querySelectorAll('button[type="submit"], [name="add"], .shopify-payment-button, shopify-accelerated-checkout, shopify-buy-it-now-button').forEach(function (el) {
        el.style.display = 'none';
      });
      if (!form.querySelector('.scalpless-drop__nocart')) {
        var note = document.createElement('div');
        note.className = 'scalpless-drop__nocart';
        note.textContent = 'Add to cart unavailable · fair drop item';
        form.appendChild(note);
      }
    });
    // Accelerated checkout buttons some themes render outside the form.
    document.querySelectorAll('.shopify-payment-button, shopify-accelerated-checkout').forEach(function (el) {
      if (!root.contains(el)) el.style.display = 'none';
    });
  }

  function mount(root) {
    var id = root.getAttribute('data-scalpless-drop');
    var appUrl = (root.getAttribute('data-app-url') || '').replace(/\/$/, '');
    var gql = root.getAttribute('data-graphql-url') || 'https://graphql.testnet.sui.io/graphql';
    var $ = function (k) { return root.querySelector('[data-sd="' + k + '"]'); };
    var drop = null;

    if (root.getAttribute('data-disable-cart') !== 'false') disableCart(root);

    function render() {
      if (!drop) return;
      var deadline = Number(drop.entry_deadline_ms);
      var open = drop.status === 0;
      var remaining = left(deadline - Date.now());
      var winners = (drop.entries || []).filter(function (e) { return e.round_won > 0; }).length;

      $('entries').textContent = (drop.entries || []).length.toLocaleString();
      $('units').textContent = Number(drop.total_units).toLocaleString();
      $('requires').textContent = TIERS[drop.min_tier] || 'Verified human';

      var cta = $('cta');
      cta.href = appUrl + '/?drop=' + id;
      if (open && remaining) {
        $('status').textContent = 'Closes in ' + remaining;
        cta.textContent = 'Enter with World ID';
        cta.classList.remove('is-secondary');
      } else if (open) {
        $('status').textContent = 'Entries closed · draw pending';
        cta.textContent = 'View drop on Scalpless';
        cta.classList.add('is-secondary');
      } else {
        $('status').textContent = 'Drawn · ' + winners + ' winner' + (winners === 1 ? '' : 's');
        cta.textContent = 'View results on Scalpless';
        cta.classList.add('is-secondary');
      }

      var face = Number(drop.face_price_mist);
      $('fine').textContent =
        sui(drop.deposit_mist) + ' refundable deposit (10%) · Winners can pay in full, in installments or with a loan backed by their World ID, or resell at up to ' +
        sui(Math.floor(face * 1.1)) + '. One entry per verified human; drawn on-chain with Sui randomness.';
    }

    function load() {
      fetchDrop(gql, id)
        .then(function (d) { drop = d; render(); })
        .catch(function () { $('status').textContent = 'Drop unavailable'; });
    }

    load();
    setInterval(load, REFRESH_MS);
    setInterval(render, 1000);
  }

  function init() {
    document.querySelectorAll('[data-scalpless-drop]').forEach(function (root) {
      if (root.__scalpless) return;
      root.__scalpless = true;
      mount(root);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  // Theme editor re-renders sections in place.
  document.addEventListener('shopify:section:load', init);
})();
