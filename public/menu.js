/* =========================================================
   MENU MODULE
   Handles: menu data load/poll, rendering, search, category
   filter, veg filter, top picks, toast helper (shared global),
   and the Add-on selection modal.
   ========================================================= */

let menuData = [];
const topPicksEl = document.getElementById("topPicks");
const categoriesEl = document.getElementById("menuCategories");
const searchInput = document.getElementById("searchInput");
const filterBtn = document.getElementById("filterBtn");
const filterDropdown = document.getElementById("filterDropdown");
const vegFilterPills = document.getElementById("vegFilterPills");

let selectedCategory = "All";
let selectedVegFilter = "all";
const defaultImage = 'https://via.placeholder.com/150';
const SIZE_ORDER = ['SMALL', 'REGULAR', 'MEDIUM', 'LARGE'];

let menuPollInterval = null;
let isPolling = false;
let toastTimeoutHandle = null;

/* ---------- Shared toast helper (used by both menu.js and cart.js) ---------- */
function showToast(msg, success = true) {
  const toast = document.getElementById("toast");
  if (!toast) return;

  const icon = success ? '<i class="fas fa-check-circle"></i>' : '<i class="fas fa-times-circle"></i>';
  toast.innerHTML = `${icon}<span>${msg}</span>`;
  toast.style.background = success
    ? "linear-gradient(135deg, var(--toast-success-1), var(--toast-success-2))"
    : "linear-gradient(135deg, var(--toast-error-1), var(--toast-error-2))";

  toast.classList.remove("show");
  void toast.offsetWidth;
  toast.classList.add("show");

  if (toastTimeoutHandle) clearTimeout(toastTimeoutHandle);
  toastTimeoutHandle = setTimeout(() => {
    toast.classList.remove("show");
  }, 4800);
}

function setupCategoryAnimations() {
  const headers = document.querySelectorAll('h2');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.3 });
  headers.forEach(header => observer.observe(header));
}

async function loadMenu() {
  try {
    const res = await fetch("/api/menu");
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.data)) throw new Error("Invalid menu data");
    menuData = data.data;
    renderCategories();
    filterMenu();
    setupCategoryAnimations();
  } catch (err) {
    console.error("Menu Load Error:", err);
    showToast(`Error loading menu: ${err.message}`, false);
    topPicksEl.innerHTML = "<p class='no-items-msg'>No top picks available</p>";
    categoriesEl.innerHTML = "<p class='no-items-msg'>No menu items available</p>";
  }
}

async function pollMenuForUpdates() {
  if (isPolling) return;
  isPolling = true;
  try {
    const res = await fetch("/api/menu", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();
    if (!data.success || !Array.isArray(data.data)) throw new Error("Invalid menu data");

    const newDataStr = JSON.stringify(data.data);
    const oldDataStr = JSON.stringify(menuData);

    if (newDataStr !== oldDataStr) {
      menuData = data.data;
      renderCategories();
      filterMenu();
    }
  } catch (err) {
    console.error("Menu auto-refresh error:", err);
  } finally {
    isPolling = false;
  }
}

function startMenuAutoRefresh() {
  if (menuPollInterval) clearInterval(menuPollInterval);
  menuPollInterval = setInterval(pollMenuForUpdates, 1000);
}

function stopMenuAutoRefresh() {
  if (menuPollInterval) {
    clearInterval(menuPollInterval);
    menuPollInterval = null;
  }
}

function renderCategories() {
  if (!Array.isArray(menuData) || menuData.length === 0) {
    filterDropdown.innerHTML = '<div data-category="All" class="selected">All Categories</div>';
    return;
  }
  const categories = [...new Set(menuData.filter(item => item?.category).map(item => item.category))]
    .sort((a, b) => a.localeCompare(b));
  const allOptions = ["All", ...categories];

  if (selectedCategory !== "All" && !categories.includes(selectedCategory)) {
    selectedCategory = "All";
  }

  filterDropdown.innerHTML = allOptions.map(cat => {
    const label = cat === "All" ? "All Categories" : cat;
    const isSelected = cat === selectedCategory ? " selected" : "";
    return `<div data-category="${cat}" class="${isSelected}">${label}</div>`;
  }).join('');

  filterDropdown.querySelectorAll('div').forEach(div => {
    div.addEventListener('click', () => {
      selectedCategory = div.dataset.category;
      filterDropdown.querySelectorAll('div').forEach(d => d.classList.remove('selected'));
      div.classList.add('selected');
      filterDropdown.classList.remove('active');
      filterMenu();
    });
  });
}

function groupSizedItems(items) {
  const grouped = {};
  items.forEach(item => {
    if (!item?.id || !item?.name || !item?.category) return;
    const hasSize = !!item.size;
    const baseName = hasSize
      ? item.name.replace(/\s*(Small|Regular|Medium|Large)$/i, '').trim()
      : item.name;
    const key = `${baseName.toLowerCase()}__${item.category}`;

    if (!grouped[key]) {
      grouped[key] = {
        id: item.id,
        name: baseName,
        description: item.description || "No description available",
        category: item.category,
        is_top_pick: item.is_top_pick,
        image: item.image || defaultImage,
        food_type: item.food_type === "nonveg" ? "nonveg" : "veg",
        sizes: [],
        order_index: item.order_index || item.id
      };
    }

    if (hasSize) {
      grouped[key].sizes.push({
        size: item.size.toUpperCase(),
        price: parseFloat(item.price) || 0,
        original_price: item.original_price != null ? parseFloat(item.original_price) : null,
        saved_price: item.saved_price != null ? parseFloat(item.saved_price) : null,
        id: item.id
      });
    } else {
      grouped[key].price = parseFloat(item.price) || 0;
      grouped[key].original_price = item.original_price != null ? parseFloat(item.original_price) : null;
      grouped[key].saved_price = item.saved_price != null ? parseFloat(item.saved_price) : null;
    }
  });

  return Object.values(grouped).map(item => {
    if (item.sizes.length > 0) {
      item.sizes.sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size));
      const preferred = item.sizes.find(s => s.size === "REGULAR") ||
                         item.sizes.reduce((min, curr) => curr.price < min.price ? curr : min);
      item.price = preferred.price;
      item.original_price = preferred.original_price;
      item.saved_price = preferred.saved_price;
      item.id = preferred.id;
    }
    return item;
  });
}

function renderMenu(data) {
  if (!Array.isArray(data) || data.length === 0) {
    topPicksEl.innerHTML = "<p class='no-items-msg'>No top picks available</p>";
    categoriesEl.innerHTML = "<p class='no-items-msg'>No menu items available</p>";
    return;
  }

  const groupedData = groupSizedItems(data);
  const sortedData = groupedData.sort((a, b) => (a.order_index || a.id) - (b.order_index || b.id));

  const topPicks = sortedData.filter(item => item?.is_top_pick);
  topPicksEl.innerHTML = topPicks.length > 0 && selectedCategory === "All"
    ? topPicks.map(item => buildCard(item, true)).join("")
    : "<p class='no-items-msg'>No top picks available</p>";

  const groupedByCategory = {};
  sortedData.forEach(item => {
    if (!item?.category) return;
    if (!groupedByCategory[item.category]) groupedByCategory[item.category] = [];
    groupedByCategory[item.category].push(item);
  });

  /* ===== CATEGORIES SORTED ALPHABETICALLY (A → Z) ===== */
  const sortedCategories = Object.keys(groupedByCategory).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  );

  categoriesEl.innerHTML = "";
  if (sortedCategories.length === 0 || (selectedCategory !== "All" && !sortedCategories.includes(selectedCategory))) {
    categoriesEl.innerHTML = "<p class='no-items-msg'>No menu items available</p>";
  } else {
    const categoriesToShow = selectedCategory === "All" ? sortedCategories : [selectedCategory];
    categoriesToShow.forEach(cat => {
      const items = groupedByCategory[cat].sort((a, b) => (a.order_index || a.id) - (b.order_index || b.id));
      const firstRow = items.slice(0, 9);
      const secondRow = items.slice(9, 18);
      categoriesEl.innerHTML += `
        <h2>${cat}</h2>
        <div class="category-row-container">
          <div class="category-row">
            ${firstRow.map(item => buildCard(item, false)).join("")}
          </div>
          ${secondRow.length > 0 ? `<div class="category-row">${secondRow.map(item => buildCard(item, false)).join("")}</div>` : ""}
        </div>
      `;
    });
  }
  setupCategoryAnimations();
}

function foodMarkHTML(foodType, extraClass = "") {
  const isVeg = foodType !== "nonveg";
  return `<span class="food-mark ${extraClass}" style="color:${isVeg ? 'var(--veg)' : 'var(--nonveg)'}" title="${isVeg ? 'Veg' : 'Non-Veg'}"></span>`;
}

function buildCard(item, isTopPick) {
  if (!item?.name || item.price == null || !item.id) return "";
  const imageSrc = item.image || defaultImage;
  const hasSizes = Array.isArray(item.sizes) && item.sizes.length > 0;

  const sizeOptions = hasSizes
    ? item.sizes.map(s => `<option value="${s.id}" data-price="${s.price.toFixed(2)}">${s.size} - ₹${s.price.toFixed(2)}</option>`).join('')
    : '';

  return `
    <div class="card ${isTopPick ? 'top-pick' : ''}">
      <div class="card-img-wrap">
        <span class="food-badge">${foodMarkHTML(item.food_type)}</span>
        <img src="${imageSrc}" alt="${item.name}" loading="lazy" onerror="this.src='${defaultImage}'">
      </div>
      <div class="card-body">
        <h3>${item.name}</h3>
        <p class="desc">${item.description || "No description available"}</p>
        <p>
          <span class="price">₹${item.price.toFixed(2)}</span>
          ${item.original_price ? `<span class="old-price">₹${item.original_price.toFixed(2)}</span>` : ""}
        </p>
        ${hasSizes ? `<select class="size-select" data-base-name="${item.name.replace(/'/g, "\\'")}" data-category="${item.category.replace(/'/g, "\\'")}">
          <option value="" disabled selected>Select a size</option>
          ${sizeOptions}
        </select>` : ''}
        <button class="add-btn" onclick="addToCartFromCard(this, ${hasSizes}, '${item.name.replace(/'/g, "\\'")}', '${item.category.replace(/'/g, "\\'")}')"><i class="fas fa-cart-plus"></i> Add to Cart</button>
      </div>
    </div>
  `;
}

/* =========================================================
   SEARCH + CATEGORY + VEG FILTER
   Filters menuData down to what should be displayed, then
   hands off to renderMenu(). This is the piece that was
   being called but never defined in the original file.
   ========================================================= */
function filterMenu() {
  if (!Array.isArray(menuData)) {
    renderMenu([]);
    return;
  }

  const searchTerm = (searchInput?.value || "").trim().toLowerCase();

  const filtered = menuData.filter(item => {
    if (!item?.name || !item?.category) return false;

    const matchesCategory = selectedCategory === "All" || item.category === selectedCategory;

    const itemFoodType = item.food_type === "nonveg" ? "nonveg" : "veg";
    const matchesVeg = selectedVegFilter === "all" || itemFoodType === selectedVegFilter;

    const matchesSearch = !searchTerm ||
      item.name.toLowerCase().includes(searchTerm) ||
      (item.description || "").toLowerCase().includes(searchTerm);

    return matchesCategory && matchesVeg && matchesSearch;
  });

  renderMenu(filtered);
}

/* =========================================================
   ADD TO CART — now checks for add-on groups before adding.
   If the item has assigned add-on groups, opens the modal
   instead of adding directly. Calls addToCart() in cart.js.
   ========================================================= */
async function addToCartFromCard(button, hasSizes, name, category) {
  let itemId, price, size = null, rawItem;

  if (hasSizes) {
    const select = button.previousElementSibling;
    if (!select || select.value === "") {
      showToast("Please select a size", false);
      return;
    }
    const selectedOption = select.options[select.selectedIndex];
    itemId = parseInt(select.value);
    price = parseFloat(selectedOption.dataset.price);
    size = selectedOption.text.split(' - ')[0];
    if (!itemId || isNaN(price)) {
      showToast("Invalid item data", false);
      return;
    }
    rawItem = menuData.find(m => m.id === itemId) || {};
  } else {
    rawItem = menuData.find(m => m.name === name && m.category === category);
    if (!rawItem) {
      showToast("Item not found", false);
      return;
    }
    itemId = rawItem.id;
    price = parseFloat(rawItem.price);
  }

  const displayName = size ? `${name} (${size})` : name;

  try {
    const res = await fetch(`/api/menu-items/${itemId}/addon-groups`);
    const groups = res.ok ? await res.json() : [];

    if (Array.isArray(groups) && groups.length > 0) {
      openAddonModal(itemId, displayName, price, size, rawItem.food_type, groups);
    } else {
      addToCart(itemId, displayName, price, size, rawItem.food_type, []);
    }
  } catch (err) {
    console.error("Addon fetch error:", err);
    // If add-ons fail to load, don't block ordering — add without add-ons.
    addToCart(itemId, displayName, price, size, rawItem.food_type, []);
  }
}

/* =========================================================
   ADD-ON MODAL
   ========================================================= */
let currentAddonContext = null;      // { itemId, name, price, size, foodType, groups }
let currentAddonSelections = {};     // groupId -> [addonId, ...]

function openAddonModal(itemId, name, price, size, foodType, groups) {
  currentAddonContext = { itemId, name, price, size, foodType, groups };
  currentAddonSelections = {};
  groups.forEach(g => { currentAddonSelections[g.id] = []; });

  document.getElementById('addonModalTitle').textContent = name;
  renderAddonModalBody();
  updateAddonModalTotal();
  document.getElementById('addonModalOverlay').classList.add('show');
  document.body.style.overflow = 'hidden';
}

function closeAddonModal() {
  document.getElementById('addonModalOverlay').classList.remove('show');
  document.body.style.overflow = 'auto';
  currentAddonContext = null;
  currentAddonSelections = {};
}

function renderAddonModalBody() {
  const body = document.getElementById('addonModalBody');
  const { groups } = currentAddonContext;

  body.innerHTML = groups.map(g => {
    const selected = currentAddonSelections[g.id] || [];
    const availableAddons = (g.addons || []).filter(a => a.is_available);

    return `
      <div class="addon-group-block">
        <div class="addon-group-title">
          ${g.name}
          <span class="addon-group-sub">${g.is_required ? 'Required' : 'Optional'} · Select ${g.min_selection}-${g.max_selection}</span>
        </div>
        <div class="addon-option-list">
          ${availableAddons.map(a => {
            const isChecked = selected.includes(String(a.id));
            const atMax = selected.length >= g.max_selection && !isChecked;
            return `
              <label class="addon-option-row ${atMax ? 'disabled' : ''}">
                <input type="checkbox" data-group="${g.id}" data-price="${a.price}" value="${a.id}"
                  ${isChecked ? 'checked' : ''} ${atMax ? 'disabled' : ''}
                  onchange="toggleAddonOption(this)">
                <span class="addon-option-mark ${a.is_veg ? '' : 'nonveg'}"></span>
                <span class="addon-option-name">${a.name}</span>
                <span class="addon-option-price">+₹${Number(a.price).toFixed(0)}</span>
              </label>
            `;
          }).join('') || `<p style="font-size:0.8rem;color:var(--muted);">No options available right now.</p>`}
        </div>
      </div>
    `;
  }).join('');
}

function toggleAddonOption(input) {
  const groupId = input.dataset.group;
  const addonId = input.value;
  let selected = currentAddonSelections[groupId] || [];

  if (input.checked) {
    selected.push(addonId);
  } else {
    selected = selected.filter(id => id !== addonId);
  }
  currentAddonSelections[groupId] = selected;

  renderAddonModalBody();
  updateAddonModalTotal();
}

function updateAddonModalTotal() {
  const { groups, price } = currentAddonContext;
  let addonsTotal = 0;

  groups.forEach(g => {
    const selected = currentAddonSelections[g.id] || [];
    selected.forEach(id => {
      const addon = (g.addons || []).find(a => String(a.id) === String(id));
      if (addon) addonsTotal += Number(addon.price);
    });
  });

  document.getElementById('addonModalTotal').textContent = `₹${(price + addonsTotal).toFixed(2)}`;
}

function confirmAddonSelection() {
  const { groups, itemId, name, price, size, foodType } = currentAddonContext;

  for (const g of groups) {
    const selected = currentAddonSelections[g.id] || [];
    if (g.is_required && selected.length < g.min_selection) {
      showToast(`Please select at least ${g.min_selection} option(s) for "${g.name}"`, false);
      return;
    }
  }

  const addons = [];
  groups.forEach(g => {
    const selected = currentAddonSelections[g.id] || [];
    selected.forEach(id => {
      const addon = (g.addons || []).find(a => String(a.id) === String(id));
      if (addon) addons.push({ addon_id: addon.id, name: addon.name, price: Number(addon.price) });
    });
  });

  addToCart(itemId, name, price, size, foodType, addons);
  closeAddonModal();
}

// Close the modal when clicking the dark backdrop, but not the modal box itself
document.getElementById('addonModalOverlay').addEventListener('click', (e) => {
  if (e.target.id === 'addonModalOverlay') {
    closeAddonModal();
  }
});

/* =========================================================
   SEARCH / FILTER DROPDOWN / VEG PILL EVENT WIRING
   ========================================================= */
if (searchInput) {
  searchInput.addEventListener('input', () => {
    filterMenu();
  });
}

if (filterBtn && filterDropdown) {
  filterBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    filterDropdown.classList.toggle('active');
  });

  document.addEventListener('click', (e) => {
    if (!filterDropdown.contains(e.target) && e.target !== filterBtn) {
      filterDropdown.classList.remove('active');
    }
  });
}

if (vegFilterPills) {
  vegFilterPills.querySelectorAll('[data-veg]').forEach(pill => {
    pill.addEventListener('click', () => {
      selectedVegFilter = pill.dataset.veg; // expects "all" | "veg" | "nonveg"
      vegFilterPills.querySelectorAll('[data-veg]').forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
      filterMenu();
    });
  });
}

/* =========================================================
   INIT
   ========================================================= */
document.addEventListener('DOMContentLoaded', () => {
  loadMenu();
  startMenuAutoRefresh();
});