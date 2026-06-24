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
          <td>${w.seller_custom_id || w.seller_id}</td>
          <td><span class="status-badge status-${w.status}">${w.status}</span></td>
          <td>
            ${w.status !== 'approved' ? `<button class="btn-approve" onclick="updateWasteStatus(${w.id}, 'approved')">✅ Approve</button>` : ''}
            ${w.status !== 'rejected' ? `<button class="btn-reject" onclick="updateWasteStatus(${w.id}, 'rejected')">❌ Reject</button>` : ''}
          </td>
        </tr>
      `).join('');
    }

  } catch (err) {
    console.log("Admin dashboard error:", err);
  }
}

/* =========================
ADMIN - APPROVE / REJECT WASTE POST
========================= */
async function updateWasteStatus(id, status) {
  try {
    const res = await fetch(`${API_BASE_URL}/admin/waste/${id}/status`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });

    if (!res.ok) {
      alert('Failed to update status');
      return;
    }

    loadAdminDashboard(); // refresh table after update

  } catch (err) {
    console.log("Update waste status error:", err);
    alert("Server error");
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
GLOBAL REAL-TIME NOTIFICATIONS
(runs on every page that includes app.js, if user is logged in)
========================= */
function initGlobalNotifications() {
  const user = getCurrentUser();
  if (!user) return; // not logged in, skip

  // Dynamically load the socket.io client library (so we don't need
  // to add a <script> tag to every single HTML page)
  const script = document.createElement('script');
  script.src = 'https://cdn.socket.io/4.7.2/socket.io.min.js';

  script.onload = () => {
    const socket = io('http://localhost:5000');

    // Join our personal notification room
    socket.emit('register_user', user.id);
socket.on('new_message_notification', (data) => {
      showToast(data);
    });

    socket.on('delivery_update', (data) => {
      showDeliveryToast(data);

      // If we're currently on a page showing requests/deliveries, refresh it
      if (typeof loadRequests === 'function') loadRequests();
      if (typeof loadMyRequests === 'function') loadMyRequests(user.id);
    });
    
  };

  document.head.appendChild(script);
}

/* DELIVERY TOAST POPUP UI */
function showDeliveryToast(data) {
  const labels = {
    scheduled: '📅 Delivery scheduled',
    out_for_delivery: '🚚 Out for delivery',
    delivered: '✅ Delivered',
    cancelled: '❌ Delivery cancelled'
  };

  const toast = document.createElement('div');
  toast.className = 'global-toast';

  toast.innerHTML = `
    <strong>${labels[data.status] || 'Delivery update'}</strong>
    <p>${data.waste_name || 'Your request'}</p>
  `;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => toast.remove(), 400);
  }, 5000);
}

/* TOAST POPUP UI */
function showToast(data) {
  const toast = document.createElement('div');
  toast.className = 'global-toast';

  toast.innerHTML = `
    <strong>💬 ${data.sender_name}</strong>
    <p>${data.message}</p>
    <span class="toast-sub">re: ${data.waste_name || 'your request'}</span>
  `;

  toast.onclick = () => {
    window.location.href = `chat.html?request_id=${data.request_id}&otherName=${encodeURIComponent(data.sender_name)}`;
  };

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('toast-hide');
    setTimeout(() => toast.remove(), 400);
  }, 5000);
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

  // GLOBAL NOTIFICATIONS (every page, if logged in)
  initGlobalNotifications();
});