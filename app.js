console.log("APP JS LOADED");

const API_BASE_URL = 'http://localhost:5000/api';

/* =========================
AUTH HELPERS
========================= */
function getCurrentUser() {
  return JSON.parse(localStorage.getItem('currentUser') || 'null');
}

function setCurrentUser(user) {
  localStorage.setItem('currentUser', JSON.stringify(user));
}

function logout() {
  localStorage.removeItem('currentUser');
  window.location.href = 'login.html';
}

/* =========================
LOGIN
========================= */
function initLoginForm() {
  const form = document.getElementById('loginForm');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    try {
      const res = await fetch(`${API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.message || "Login failed");
        return;
      }

      setCurrentUser(data.user);

      // ROLE REDIRECT
      if (data.user.role === 'admin') {
        window.location.href = 'admin-dashboard.html';
      } else if (data.user.role === 'seller') {
        window.location.href = 'seller-dashboard.html';
      } else {
        window.location.href = 'buyer-dashboard.html';
      }

    } catch (err) {
      console.log("Login error:", err);
      alert("Server error");
    }
  });
}

/* =========================
ADMIN DASHBOARD
========================= */
async function loadAdminDashboard() {
  try {
    const [usersRes, wasteRes, reqRes] = await Promise.all([
      fetch(`${API_BASE_URL}/admin/users`),
      fetch(`${API_BASE_URL}/admin/waste`),
      fetch(`${API_BASE_URL}/requests`)
    ]);

    const usersData = await usersRes.json();
    const waste = await wasteRes.json();
    const requests = await reqRes.json();

    const admins = usersData.admins || [];
    const buyers = usersData.buyers || [];
    const sellers = usersData.sellers || [];

    document.getElementById('totalUsers').innerText =
      admins.length + buyers.length + sellers.length;
    document.getElementById('totalWaste').innerText = waste.length || 0;
    document.getElementById('totalRequests').innerText = requests.length || 0;

    /* helper to render one role table */
    function renderUserTable(tbodyId, list) {
      const tbody = document.getElementById(tbodyId);
      if (!tbody) return;

      tbody.innerHTML = list.map(u => `
        <tr>
          <td>${u.custom_id || u.id}</td>
          <td>${u.full_name}</td>
          <td>${u.email}</td>
          <td>${u.phone || '-'}</td>
        </tr>
      `).join('');
    }

    renderUserTable('adminUsersTable', admins);
    renderUserTable('buyerUsersTable', buyers);
    renderUserTable('sellerUsersTable', sellers);

    /* WASTE TABLE */
    const wasteTable = document.getElementById('adminWasteTable');
    if (wasteTable) {
      wasteTable.innerHTML = waste.map(w => `
        <tr>
          <td>${w.name}</td>
          <td>${w.type}</td>
          <td>${w.quantity}</td>
          <td>${w.seller_id}</td>
        </tr>
      `).join('');
    }

  } catch (err) {
    console.log("Admin dashboard error:", err);
  }
}

/* =========================
SELLER DASHBOARD
========================= */
async function loadSellerDashboard() {
  const user = getCurrentUser();
  if (!user) return;

  try {
    const res = await fetch(`${API_BASE_URL}/seller/dashboard/${user.id}`);
    const data = await res.json();

    document.getElementById("totalPosts").innerText = data.totalPosts || 0;
    document.getElementById("pendingRequests").innerText = data.totalRequests || 0;

  } catch (err) {
    console.log("Seller dashboard error:", err);
  }
}

/* =========================
AUTO INIT
========================= */
document.addEventListener('DOMContentLoaded', () => {

  // LOGIN PAGE
  if (document.getElementById('loginForm')) {
    initLoginForm();
  }

  // ADMIN DASHBOARD PAGE
  if (document.getElementById('totalUsers')) {
    loadAdminDashboard();
  }

  // SELLER DASHBOARD PAGE
  if (document.getElementById('totalPosts')) {
    loadSellerDashboard();
  }
});