/* =========================================================
   MENU MODULE
   Handles: menu data load/poll, rendering, search, category
   filter, veg filter, top picks, toast helper (shared global).
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
      // Items within a category still follow order_index/id (kitchen-defined order)
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

/* Calls addToCart() which lives in cart.js — safe since both scripts
   are loaded and parsed before any user interaction can trigger this. */
function addToCartFromCard(button, hasSizes, name, category) {
  if (hasSizes) {
    const select = button.previousElementSibling;
    if (!select || select.value === "") {
      showToast("Please select a size", false);
      return;
    }
    const selectedOption = select.options[select.selectedIndex];
    const itemId = parseInt(select.value);
    const price = parseFloat(selectedOption.dataset.price);
    const size = selectedOption.text.split(' - ')[0];
    if (!itemId || isNaN(price)) {
      showToast("Invalid item data", false);
      return;
    }
    const rawItem = menuData.find(m => m.id === itemId) || {};
    addToCart(itemId, `${name} (${size})`, price, size, rawItem.food_type);
  } else {
    const item = menuData.find(m => m.name === name && m.category === category);
    if (item) {
      addToCart(item.id, name, parseFloat(item.price), null, item.food_type);
    } else {
      showToast("Item not found", false);
    }
  }
}

function filterMenu() {
  if (!searchInput) return;
  const query = searchInput.value.toLowerCase().trim();
  let filtered = menuData;

  if (selectedCategory !== "All") {
    filtered = filtered.filter(item => item?.category === selectedCategory);
  }
  if (selectedVegFilter !== "all") {
    filtered = filtered.filter(item => (item?.food_type || "veg") === selectedVegFilter);
  }
  if (query) {
    filtered = filtered.filter(item => item?.name.toLowerCase().includes(query));
  }
  renderMenu(filtered);
}

function toggleFilterDropdown() {
  if (filterDropdown) filterDropdown.classList.toggle('active');
}

vegFilterPills.addEventListener("click", (e) => {
  const pill = e.target.closest(".veg-pill");
  if (!pill) return;
  vegFilterPills.querySelectorAll(".veg-pill").forEach(p => p.classList.remove("active"));
  pill.classList.add("active");
  selectedVegFilter = pill.dataset.veg;
  filterMenu();
});

document.addEventListener('click', (e) => {
  if (filterDropdown && filterBtn && !filterDropdown.contains(e.target) && !filterBtn.contains(e.target)) {
    filterDropdown.classList.remove('active');
  }
});

searchInput.addEventListener("input", filterMenu);
if (filterBtn) filterBtn.addEventListener("click", toggleFilterDropdown);

window.addEventListener("load", () => {
  loadMenu().then(() => {
    startMenuAutoRefresh();
  });
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopMenuAutoRefresh();
  } else {
    pollMenuForUpdates();
    startMenuAutoRefresh();
  }
});