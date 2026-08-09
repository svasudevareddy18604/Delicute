/* =========================================================
   CART MODULE
   Handles: cart state, drawer toggle/drag, coupon logic,
   table QR detection, order placement. Now supports
   per-item add-ons (extra toppings, sauces, etc).
   Depends on showToast() and menuData from menu.js (globals).
   ========================================================= */

const cartItemsEl = document.getElementById("cartItems");
const cartSection = document.getElementById("cartSection");
const cartToggle = document.getElementById("cartToggle");

let cart = [];
let appliedCoupon = null;
let renderTimeout = null;

// Set once a QR-scanned table has been verified against the backend.
let scannedTableNumber = null;

/* Effective per-unit price including any selected add-ons */
function itemUnitPrice(item) {
  return (item.price || 0) + (item.addonsTotal || 0);
}

function toggleCart() {
  if (!cartSection) return;
  cartSection.classList.toggle("active");
  const container = document.querySelector('.container');
  if (cartSection.classList.contains("active")) {
    localStorage.setItem("openCart", "true");
    document.body.style.overflow = 'hidden';
    if (container) container.style.touchAction = 'none';
  } else {
    localStorage.removeItem("openCart");
    document.body.style.overflow = 'auto';
    if (container) container.style.touchAction = 'pan-y';
  }
}

function saveCart() {
  try { localStorage.setItem("cart", JSON.stringify(cart)); }
  catch (err) { console.error("Error saving cart:", err); }
}

function loadCart() {
  try {
    const savedCart = localStorage.getItem("cart");
    cart = savedCart ? JSON.parse(savedCart) : [];
    if (!Array.isArray(cart)) cart = [];
    renderCart();
  } catch (err) {
    console.error("Error loading cart:", err);
    cart = [];
    renderCart();
  }
}

function clearCart() {
  if (!confirm("Are you sure you want to clear your cart?")) return;
  cart = [];
  appliedCoupon = null;
  const couponInput = document.getElementById("couponCode");
  if (couponInput) couponInput.value = "";
  localStorage.removeItem("cart");
  localStorage.removeItem("appliedCoupon");
  showToast("Cart cleared!", true);
  renderCart();
}

/* =========================================================
   TABLE DETECTION — hit the moment a customer arrives here
   from a scanned QR (via index.html?table=5 -> forwarded, or
   directly if the QR ever points straight at this page).
   Verifies the table against the backend before trusting it,
   then locks the Table Number field so it can't be edited.
   ========================================================= */

async function detectScannedTable() {
  const urlParams = new URLSearchParams(window.location.search);
  let tableParam = urlParams.get('table');

  if (!tableParam) {
    tableParam = sessionStorage.getItem('delicute_table');
  } else {
    sessionStorage.setItem('delicute_table', tableParam);
  }

  const tableNumInput = document.getElementById('tableNum');
  if (!tableParam || !tableNumInput) return;

  try {
    const res = await fetch(`/api/tables/scan/${encodeURIComponent(tableParam)}`);
    const data = await res.json();

    if (res.ok && data.success) {
      scannedTableNumber = data.table.number;
      tableNumInput.value = scannedTableNumber;
      tableNumInput.readOnly = true;
      showTableBanner(`✓ Table ${scannedTableNumber} detected — you're all set`, true);
    } else {
      showTableBanner(data.message || 'Could not verify this table — please enter it manually', false);
      sessionStorage.removeItem('delicute_table');
    }
  } catch (err) {
    console.error('Table detection error:', err);
  }
}

function showTableBanner(msg, success) {
  const banner = document.getElementById('tableDetectBanner');
  if (!banner) return;
  banner.textContent = msg;
  banner.className = 'table-detect-banner ' + (success ? 'success' : 'error');
}

/* Called from menu.js's addToCartFromCard() / confirmAddonSelection().
   addons: [{ addon_id, name, price }, ...] — empty array if item has no add-ons. */
function addToCart(id, name, price, size = null, foodType = "veg", addons = []) {
  if (!id || !name || isNaN(price)) {
    showToast("Invalid item data", false);
    return;
  }

  const safeAddons = Array.isArray(addons) ? addons : [];
  const addonsTotal = safeAddons.reduce((sum, a) => sum + (Number(a.price) || 0), 0);
  const addonSignature = safeAddons.map(a => a.addon_id).sort().join('_');
  const cartId = `${id}${size ? '-' + size : ''}${addonSignature ? '-' + addonSignature : ''}`;

  const existing = cart.find(i => i.cartId === cartId);
  if (existing) {
    existing.qty++;
  } else {
    const menuItem = menuData.find(m => m.id === id) || {};
    cart.push({
      id,
      cartId,
      name,
      price,
      addons: safeAddons,
      addonsTotal,
      qty: 1,
      size,
      image: menuItem.image || defaultImage,
      food_type: foodType === "nonveg" ? "nonveg" : "veg"
    });
  }
  saveCart();
  showToast(`${name} added to cart!`, true);
  renderCart();
}

function changeQty(cartId, change) {
  const item = cart.find(i => i.cartId === cartId);
  if (!item) {
    showToast("Item not found in cart", false);
    return;
  }
  item.qty += change;
  if (item.qty <= 0) {
    cart = cart.filter(i => i.cartId !== cartId);
    showToast(`${item.name} removed from cart`, true);
  }
  saveCart();
  renderCart();
}

function getQualifyingTier(rawTiers, subtotal) {
  let tiers = [];
  try { tiers = typeof rawTiers === "string" ? JSON.parse(rawTiers) : (rawTiers || []); }
  catch { tiers = []; }
  if (!Array.isArray(tiers) || tiers.length === 0) return null;

  const normalized = tiers
    .map(t => ({ amount: Number(t.amount ?? t.min_cart_amount), discount: Number(t.discount) }))
    .filter(t => Number.isFinite(t.amount) && Number.isFinite(t.discount))
    .sort((a, b) => a.amount - b.amount);

  if (normalized.length === 0) return null;
  const qualifying = normalized.filter(t => subtotal >= t.amount);
  if (qualifying.length === 0) return null;
  return qualifying[qualifying.length - 1];
}

function lowestTierAmount(rawTiers) {
  let tiers = [];
  try { tiers = typeof rawTiers === "string" ? JSON.parse(rawTiers) : (rawTiers || []); }
  catch { tiers = []; }
  if (!Array.isArray(tiers) || tiers.length === 0) return null;
  const amounts = tiers.map(t => Number(t.amount ?? t.min_cart_amount)).filter(Number.isFinite);
  return amounts.length ? Math.min(...amounts) : null;
}

async function calculateDiscount(subtotal) {
  if (!appliedCoupon || !subtotal) return 0;
  try {
    const menuRes = await fetch("/api/menu");
    if (!menuRes.ok) throw new Error(`HTTP error! status: ${menuRes.status}`);
    const menuRespData = await menuRes.json();
    if (!menuRespData.success || !Array.isArray(menuRespData.data)) throw new Error("Invalid menu data");

    const catIds = appliedCoupon.category
      ? menuRespData.data.filter(item => item?.category === appliedCoupon.category).map(item => item.id)
      : [];
    const eligibleItems = cart.filter(i => i && catIds.includes(i.id));
    const categoryQty = eligibleItems.reduce((sum, i) => sum + (i.qty || 0), 0);
    const categorySubtotal = eligibleItems.reduce((sum, i) => sum + (itemUnitPrice(i) * (i.qty || 0)), 0);

    if (appliedCoupon.type === "cart_tier") {
      const tier = getQualifyingTier(appliedCoupon.tiers, subtotal);
      if (!tier) return 0;
      return (subtotal * tier.discount) / 100;
    } else if (appliedCoupon.type === "min_cart_amount") {
      if (subtotal >= (appliedCoupon.min_cart_amount || 0)) {
        return (subtotal * (appliedCoupon.discount || 0)) / 100;
      }
      return 0;
    } else if (appliedCoupon.type === "buy_x") {
      if (categoryQty >= (appliedCoupon.buy_x || 0)) {
        return (categorySubtotal * (appliedCoupon.discount || 0)) / 100;
      }
      return 0;
    } else if (appliedCoupon.type === "date_range") {
      if (categorySubtotal > 0) {
        return (categorySubtotal * (appliedCoupon.discount || 0)) / 100;
      }
      return 0;
    } else if (appliedCoupon.type === "bogo") {
      if (categoryQty >= 2) {
        const pairs = Math.floor(categoryQty / 2);
        const sortedItems = eligibleItems
          .flatMap(item => Array(item.qty).fill(item))
          .sort((a, b) => itemUnitPrice(a) - itemUnitPrice(b));
        let bogoDiscount = 0;
        for (let i = 0; i < pairs; i++) bogoDiscount += itemUnitPrice(sortedItems[i]) || 0;
        return bogoDiscount;
      }
      return 0;
    }
    return 0;
  } catch (err) {
    console.error("Discount calculation error:", err);
    showToast(`Error calculating discount: ${err.message}`, false);
    return 0;
  }
}

async function renderCart() {
  if (!cartItemsEl || !cartToggle || !document.getElementById("subtotal")) return;
  const subtotalEl = document.getElementById("subtotal");
  const discountEl = document.getElementById("discount");
  const totalEl = document.getElementById("total");

  if (renderTimeout) clearTimeout(renderTimeout);

  renderTimeout = setTimeout(async () => {
    if (!Array.isArray(cart) || cart.length === 0) {
      cartItemsEl.innerHTML = "<p class='no-items-msg'>Your cart is empty</p>";
      subtotalEl.innerText = "₹0";
      discountEl.innerText = "₹0";
      totalEl.innerText = "₹0";
      cartToggle.setAttribute("data-count", "0");
      cartToggle.classList.remove("has-items");
      return;
    }

    const emptyMsg = cartItemsEl.querySelector('.no-items-msg');
    if (emptyMsg) emptyMsg.remove();

    let subtotal = 0;
    const existingItems = new Map();
    cartItemsEl.querySelectorAll('.cart-item').forEach(item => {
      const cartId = item.dataset.cartId;
      if (cartId) existingItems.set(cartId, item);
    });

    for (const item of cart) {
      if (!item?.id || !item.price || !item.qty || !item.image) continue;
      const unitPrice = itemUnitPrice(item);
      subtotal += unitPrice * item.qty;
      const cartId = item.cartId;
      let cartItem = existingItems.get(cartId);

      if (cartItem) {
        const qtySpan = cartItem.querySelector('.qty-controls span');
        const totalSpan = cartItem.querySelector('.line-total');
        if (qtySpan) qtySpan.textContent = item.qty;
        if (totalSpan) totalSpan.textContent = `₹${(unitPrice * item.qty).toFixed(2)}`;
      } else {
        const addonsLine = (item.addons && item.addons.length)
          ? `<div class="cart-item-addons">+ ${item.addons.map(a => a.name).join(', ')}</div>`
          : '';

        const newItem = document.createElement('div');
        newItem.className = 'cart-item';
        newItem.dataset.cartId = cartId;
        newItem.innerHTML = `
          <img src="${item.image}" alt="${item.name}" loading="lazy" onerror="this.src='${defaultImage}'">
          <div class="cart-item-info">
            <h4>${foodMarkHTML(item.food_type)} ${item.name}</h4>
            ${addonsLine}
            <div class="qty-controls">
              <button onclick="changeQty('${encodeURIComponent(cartId)}', -1)">-</button>
              <span>${item.qty}</span>
              <button onclick="changeQty('${encodeURIComponent(cartId)}', 1)">+</button>
            </div>
          </div>
          <span class="line-total">₹${(unitPrice * item.qty).toFixed(2)}</span>
        `;
        cartItemsEl.appendChild(newItem);
        existingItems.set(cartId, newItem);
      }
    }

    existingItems.forEach((el, cartId) => {
      if (!cart.find(i => i.cartId === cartId)) el.remove();
    });

    const discount = await calculateDiscount(subtotal);
    let total = subtotal - discount;
    if (total < 0) total = 0;
    cartToggle.setAttribute("data-count", cart.reduce((sum, item) => sum + (item?.qty || 0), 0));
    cartToggle.classList.toggle("has-items", cart.length > 0);
    subtotalEl.innerText = "₹" + subtotal.toFixed(2);
    discountEl.innerText = "₹" + discount.toFixed(2);
    totalEl.innerText = "₹" + total.toFixed(2);
  }, 100);
}

async function applyCoupon(code = null) {
  const couponInput = document.getElementById("couponCode");
  if (!couponInput) return;
  const couponCode = code || couponInput.value.trim();
  if (!couponCode) {
    showToast("Please enter a coupon code", false);
    return;
  }
  if (!Array.isArray(cart) || cart.length === 0) {
    showToast("Cart is empty!", false);
    couponInput.value = "";
    localStorage.removeItem("appliedCoupon");
    return;
  }
  try {
    const couponRes = await fetch("/api/coupons");
    if (!couponRes.ok) throw new Error(`HTTP error! status: ${couponRes.status}`);
    const couponData = await couponRes.json();
    if (!couponData.success || !Array.isArray(couponData.data)) {
      showToast("Failed to fetch coupons", false);
      couponInput.value = "";
      localStorage.removeItem("appliedCoupon");
      return;
    }
    const coupon = couponData.data.find(c => c?.code === couponCode);
    if (!coupon) {
      showToast(`Invalid coupon code: ${couponCode}`, false);
      couponInput.value = "";
      localStorage.removeItem("appliedCoupon");
      return;
    }
    const subtotal = cart.reduce((sum, i) => sum + (itemUnitPrice(i) * (i?.qty || 0)), 0);

    if (coupon.type === "cart_tier") {
      const tier = getQualifyingTier(coupon.tiers, subtotal);
      if (!tier) {
        const minNeeded = lowestTierAmount(coupon.tiers);
        if (minNeeded != null) {
          const shortBy = Math.max(0, minNeeded - subtotal);
          showToast(`Add ₹${shortBy.toFixed(2)} more to unlock this coupon (min ₹${minNeeded})`, false);
        } else {
          showToast(`Coupon ${couponCode} is invalid`, false);
        }
        couponInput.value = "";
        localStorage.removeItem("appliedCoupon");
        return;
      }
      appliedCoupon = coupon;
      couponInput.value = couponCode;
      localStorage.setItem("appliedCoupon", couponCode);
      showToast(`Coupon ${couponCode} applied! ${tier.discount}% off`, true);
      renderCart();
    } else if (coupon.type === "min_cart_amount") {
      if (subtotal < (coupon.min_cart_amount || 0)) {
        showToast(`Coupon requires minimum ₹${coupon.min_cart_amount} (current: ₹${subtotal.toFixed(2)})`, false);
        couponInput.value = "";
        localStorage.removeItem("appliedCoupon");
        return;
      }
      appliedCoupon = coupon;
      couponInput.value = couponCode;
      localStorage.setItem("appliedCoupon", couponCode);
      showToast(`Coupon ${couponCode} applied! ${coupon.discount}% off`, true);
      renderCart();
    } else if (coupon.type === "buy_x" || coupon.type === "date_range" || coupon.type === "bogo") {
      const menuRes = await fetch("/api/menu");
      if (!menuRes.ok) throw new Error(`HTTP error! status: ${menuRes.status}`);
      const menuRespData = await menuRes.json();
      if (!menuRespData.success || !Array.isArray(menuRespData.data)) {
        showToast("Failed to fetch menu", false);
        couponInput.value = "";
        localStorage.removeItem("appliedCoupon");
        return;
      }
      if (!coupon.category) {
        showToast(`Coupon ${couponCode} is invalid`, false);
        couponInput.value = "";
        localStorage.removeItem("appliedCoupon");
        return;
      }
      const catIds = menuRespData.data.filter(item => item?.category === coupon.category).map(item => item.id);
      const eligibleItems = cart.filter(i => i && catIds.includes(i.id));
      const categorySubtotal = eligibleItems.reduce((sum, i) => sum + (itemUnitPrice(i) * (i?.qty || 0)), 0);
      const categoryQty = eligibleItems.reduce((sum, i) => sum + (i?.qty || 0), 0);
      if (categorySubtotal === 0) {
        showToast(`Coupon valid only for ${coupon.category}`, false);
        couponInput.value = "";
        localStorage.removeItem("appliedCoupon");
        return;
      }
      if (coupon.type === "buy_x" && categoryQty < (coupon.buy_x || 0)) {
        showToast(`Coupon requires ${coupon.buy_x} ${coupon.category} items`, false);
        couponInput.value = "";
        localStorage.removeItem("appliedCoupon");
        return;
      }
      if (coupon.type === "bogo" && categoryQty < 2) {
        showToast(`Coupon requires at least 2 ${coupon.category} items`, false);
        couponInput.value = "";
        localStorage.removeItem("appliedCoupon");
        return;
      }
      appliedCoupon = coupon;
      couponInput.value = couponCode;
      localStorage.setItem("appliedCoupon", couponCode);
      showToast(`Coupon ${couponCode} applied for ${coupon.category}!`, true);
      renderCart();
    } else {
      showToast(`Coupon ${couponCode} is invalid`, false);
      couponInput.value = "";
      localStorage.removeItem("appliedCoupon");
    }
  } catch (err) {
    showToast(`Error applying coupon: ${err.message}`, false);
    couponInput.value = "";
    localStorage.removeItem("appliedCoupon");
    console.error("Coupon error:", err);
  }
}

function removeCoupon() {
  appliedCoupon = null;
  const couponInput = document.getElementById("couponCode");
  if (couponInput) couponInput.value = "";
  localStorage.removeItem("appliedCoupon");
  showToast("Coupon removed", true);
  renderCart();
}

async function placeOrder() {
  if (!Array.isArray(cart) || cart.length === 0) {
    showToast("Cart is empty!", false);
    return;
  }
  const custNameInput = document.getElementById("custName");
  const tableNumInput = document.getElementById("tableNum");
  if (!custNameInput || !tableNumInput) return;
  const customer_name = custNameInput.value.trim();
  const table_number = tableNumInput.value.trim();
  if (!customer_name || !table_number) {
    showToast("Enter name and table number", false);
    return;
  }
  const subtotal = cart.reduce((s, i) => s + (itemUnitPrice(i) * (i?.qty || 0)), 0);
  const discount = await calculateDiscount(subtotal);
  let total = subtotal - discount;
  if (total < 0) total = 0;
  const body = {
    customer_name,
    table_number: parseInt(table_number),
    items: cart.map(item => ({
      id: item.id,
      name: item.name,
      price: item.price,
      qty: item.qty,
      size: item.size,
      addons: item.addons || []
    })),
    coupon_code: appliedCoupon ? appliedCoupon.code : null,
    subtotal,
    discount,
    total,
    instructions: document.getElementById("instructions")?.value.trim() || ""
  };
  try {
    const res = await fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();
    if (data.success) {
      showToast(`Thank you, ${customer_name}! Order #${data.orderId || 'N/A'} placed!`, true);
      cart = [];
      appliedCoupon = null;
      if (custNameInput) custNameInput.value = "";
      if (!scannedTableNumber && tableNumInput) tableNumInput.value = "";
      if (document.getElementById("instructions")) document.getElementById("instructions").value = "";
      if (document.getElementById("couponCode")) document.getElementById("couponCode").value = "";
      localStorage.removeItem("cart");
      localStorage.removeItem("appliedCoupon");
      localStorage.removeItem("openCart");
      renderCart();
      toggleCart();
    } else {
      showToast(`Failed: ${data.message || "Unknown error"}`, false);
    }
  } catch (err) {
    showToast(`Error placing order: ${err.message}`, false);
    console.error("Order error:", err);
  }
}

(function setupCartDrag() {
  const handle = document.getElementById('cartHandle');
  if (!handle || !cartSection) return;

  let startY = 0;
  let currentY = 0;
  let dragging = false;
  const CLOSE_THRESHOLD = 110;

  function getY(e) { return e.touches ? e.touches[0].clientY : e.clientY; }

  function onStart(e) {
    dragging = true;
    startY = getY(e);
    currentY = startY;
    cartSection.classList.add('dragging');
  }
  function onMove(e) {
    if (!dragging) return;
    currentY = getY(e);
    let delta = currentY - startY;
    if (delta < 0) delta = 0;
    cartSection.style.transform = `translateY(${delta}px)`;
  }
  function onEnd() {
    if (!dragging) return;
    dragging = false;
    cartSection.classList.remove('dragging');
    const delta = currentY - startY;
    cartSection.style.transform = '';
    if (delta > CLOSE_THRESHOLD) toggleCart();
    startY = 0;
    currentY = 0;
  }

  handle.addEventListener('touchstart', onStart, { passive: true });
  handle.addEventListener('touchmove', onMove, { passive: true });
  handle.addEventListener('touchend', onEnd);
  handle.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', (e) => { if (dragging) onMove(e); });
  document.addEventListener('mouseup', onEnd);
})();

window.addEventListener("load", () => {
  loadCart();
  detectScannedTable();
  const openCart = localStorage.getItem("openCart");
  const couponCode = localStorage.getItem("appliedCoupon");
  if (openCart === "true" && cartSection) {
    cartSection.classList.add("active");
    localStorage.removeItem("openCart");
    if (couponCode && document.getElementById("couponCode")) {
      document.getElementById("couponCode").value = couponCode;
      applyCoupon(couponCode);
    }
  }
});