(() => {
  "use strict";

  const TOKEN_KEY = "evsuEnrollmentToken";
  const ADMIN_KEY = "evsuEnrollmentAdmin";
  const API_BASE_URL = "http://127.0.0.1:8000";
  const OVERVIEW_ITEM_LIMIT = 5;
  const AUDIT_PAGE_SIZE = 20;
  const ACCOUNT_TYPE_KEY = "evsuEnrollmentAccountType";

  const elements = {
    authScreen: document.getElementById("auth-screen"),
    appShell: document.getElementById("app-shell"),
    authAlert: document.getElementById("auth-alert"),
    loginForm: document.getElementById("login-form"),
    pageAlert: document.getElementById("page-alert"),
    adminTableBody: document.getElementById("admin-table-body"),
    auditTableBody: document.getElementById("audit-table-body"),
  };

  let adminCache = [];
  let facultyCache = [];
  let auditOffset = 0;
  let auditHasNext = false;
  let auditFilters = { adminId: "", action: "" };
  let currentPage = "overview";
  let loginAccountType = "admin";
  let subjectCache = [];
  let classScheduleOptions = { sections: [], subjects: [], instructors: [] };
  let sectionCache = [];
  let classScheduleCache = [];

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function getAdmin() {
    try {
      return JSON.parse(localStorage.getItem(ADMIN_KEY) || "null");
    } catch (error) {
      console.error("Could not read the saved administrator profile.", error);
      return null;
    }
  }

  function isSuperAdmin() {
    return localStorage.getItem(ACCOUNT_TYPE_KEY) === "admin" && getAdmin()?.role === "super_admin";
  }

  function isDepartmentHead() {
    return localStorage.getItem(ACCOUNT_TYPE_KEY) === "faculty" && getAdmin()?.role === "department_head";
  }

  function isInstructor() {
    return localStorage.getItem(ACCOUNT_TYPE_KEY) === "faculty" && getAdmin()?.role === "instructor";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[character]);
  }

  function fullName(admin) {
    return [admin.fname, admin.mname, admin.lname].filter(Boolean).join(" ");
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "A";
  }

  function formatDate(value, includeTime = false) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat(undefined, includeTime
      ? { dateStyle: "medium", timeStyle: "short" }
      : { dateStyle: "medium" }).format(date);
  }

  function toDateTimeLocal(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Manila",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date).reduce((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  }

  function fromDateTimeLocal(value) {
    const timeWithSeconds = value.length === 16 ? `${value}:00` : value;
    const date = new Date(`${timeWithSeconds}+08:00`);
    if (Number.isNaN(date.getTime())) throw new Error("Enter a valid enrollment date and time.");
    return date.toISOString();
  }

  function responseMessage(payload, fallback) {
    if (typeof payload?.detail === "string") return payload.detail;
    if (Array.isArray(payload?.detail)) {
      return payload.detail.map((item) => item.msg || "Invalid input").join(" ");
    }
    if (typeof payload?.message === "string") return payload.message;
    return fallback;
  }

  async function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
    if (options.auth !== false && getToken()) headers.set("Authorization", `Bearer ${getToken()}`);
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/api/v1${path}`, { ...options, headers });
    } catch (error) {
      throw new Error(`Cannot reach the API at ${API_BASE_URL}. Check that the backend is running.`);
    }

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (response.status === 401 && options.auth !== false) {
      signOut(false);
      throw new Error("Your session has expired. Please sign in again.");
    }
    if (!response.ok) throw new Error(responseMessage(payload, `Request failed (${response.status}).`));
    return payload;
  }

  function showAlert(element, message, type = "danger") {
    element.className = `alert alert-${type}`;
    element.textContent = message;
    element.classList.remove("d-none");
  }

  function clearAlert(element) {
    element.textContent = "";
    element.classList.add("d-none");
  }

  function setLoading(button, loading, label) {
    button.disabled = loading;
    const labelElement = button.querySelector(".button-label");
    const spinner = button.querySelector(".spinner-border");
    if (labelElement && label) labelElement.textContent = label;
    if (spinner) spinner.classList.toggle("d-none", !loading);
  }

  function saveSession(token, admin) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ADMIN_KEY, JSON.stringify(admin));
    localStorage.setItem(ACCOUNT_TYPE_KEY, loginAccountType);
  }

  function signOut(showMessage = true) {
    const accountType = localStorage.getItem(ACCOUNT_TYPE_KEY);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ADMIN_KEY);
    localStorage.removeItem(ACCOUNT_TYPE_KEY);
    loginAccountType = "admin";
    adminCache = [];
    facultyCache = [];
    subjectCache = [];
    classScheduleOptions = { sections: [], subjects: [], instructors: [] };
    elements.appShell.classList.add("d-none");
    elements.authScreen.classList.remove("d-none");
    elements.loginForm.reset();
    if (accountType === "faculty") {
      window.location.href = "./faculty-login.html";
      return;
    }
    if (showMessage) showAlert(elements.authAlert, "You have been signed out.", "info");
  }

  function showApplication(admin, accountType = localStorage.getItem(ACCOUNT_TYPE_KEY) || "admin") {
    elements.authScreen.classList.add("d-none");
    elements.appShell.classList.remove("d-none");
    const name = fullName(admin) || admin.email || "Administrator";
    document.getElementById("topbar-user-name").textContent = name;
    document.getElementById("topbar-user-role").textContent = admin.role || "Admin";
    document.getElementById("create-admin-button").classList.toggle("d-none", accountType !== "admin" || admin.role !== "super_admin");
    document.getElementById("faculty-nav-link").classList.toggle("d-none", accountType !== "admin" || admin.role !== "super_admin");
    document.getElementById("admins-nav-link").classList.toggle("d-none", accountType !== "admin");
    document.getElementById("audit-nav-link").classList.toggle("d-none", accountType !== "admin" && !isDepartmentHead());
    document.getElementById("audit-admin-filter-group").classList.toggle("d-none", isDepartmentHead());
    document.getElementById("audit-description").textContent = isDepartmentHead()
      ? "Review actions recorded for your account."
      : "Review administrator actions recorded by the system.";
    document.getElementById("overview-nav-link").classList.toggle("d-none", accountType !== "admin");
    document.getElementById("profile-nav-link").classList.toggle("d-none", accountType !== "admin");
    document.getElementById("create-subject-button").classList.toggle("d-none", !isDepartmentHead());
    document.getElementById("subject-actions-heading").classList.toggle("d-none", !isDepartmentHead());
    document.getElementById("sections-nav-link").classList.toggle("d-none", !isDepartmentHead());
    document.getElementById("create-section-button").classList.toggle("d-none", !isDepartmentHead());
    document.getElementById("enrollment-config-nav-link").classList.toggle("d-none", !isDepartmentHead());
    document.getElementById("class-scheduling-nav-link").classList.toggle("d-none", !isDepartmentHead() && !isInstructor());
    document.getElementById("class-scheduling-nav-label").textContent = isInstructor() ? "My classes" : "Class scheduling";
    document.getElementById("class-scheduling-title").textContent = isInstructor() ? "My classes" : "Class scheduling";
    document.getElementById("class-scheduling-description").textContent = isInstructor()
      ? "View your assigned subjects, sections, rooms, and meeting times."
      : "Assign an existing section, subject, instructor, room, and meeting time.";
    document.getElementById("create-class-schedule-button").classList.toggle("d-none", !isDepartmentHead());
    document.querySelector(".password-card").classList.toggle("d-none", accountType !== "admin");
    document.getElementById("user-avatar").textContent = initials(name);
    document.getElementById("welcome-name").textContent = admin.fname || "Admin";
    document.getElementById("profile-avatar").textContent = initials(name);
    document.getElementById("profile-full-name").textContent = name;
    document.getElementById("profile-role").textContent = admin.role || "admin";
    document.getElementById("profile-id-number").textContent = admin.id_number || "—";
    document.getElementById("profile-email").textContent = admin.email || "—";
    document.getElementById("profile-status").innerHTML = admin.is_active
      ? '<span class="status-badge active">Active</span>'
      : '<span class="status-badge inactive">Inactive</span>';
    document.getElementById("profile-id").textContent = admin.id ?? "—";
    document.getElementById("profile-created").textContent = formatDate(admin.created_at);
    if (accountType === "admin") {
      navigateTo("overview");
      refreshOverview();
    } else if (isInstructor()) {
      navigateTo("class-scheduling");
    } else {
      navigateTo("subjects");
    }
    checkHealth();
  }

  async function checkHealth() {
    const dot = document.querySelector(".api-indicator .status-dot");
    try {
      const response = await fetch(`${API_BASE_URL}/`);
      if (!response.ok) throw new Error(`Health check failed (${response.status}).`);
      const health = await response.json();
      document.getElementById("topbar-api-status").textContent = health.status === "ok" ? "API connected" : "API response received";
      document.getElementById("sidebar-api-status").textContent = "API connected";
      dot.classList.remove("offline");
      document.querySelector(".sidebar-api-state .status-dot").classList.remove("offline");
    } catch (error) {
      document.getElementById("topbar-api-status").textContent = "API unavailable";
      document.getElementById("sidebar-api-status").textContent = "API unavailable";
      dot.classList.add("offline");
      document.querySelector(".sidebar-api-state .status-dot").classList.add("offline");
    }
  }

  function navigateTo(page) {
    if (page === "enrollment-config" && !isDepartmentHead()) return;
    currentPage = page;
    document.querySelectorAll(".page-section").forEach((section) => section.classList.add("d-none"));
    document.getElementById(`page-${page}`).classList.remove("d-none");
    document.querySelectorAll(".sidebar-nav .nav-link").forEach((link) => {
      link.classList.toggle("active", link.dataset.page === page);
    });
    const titles = { overview: "Overview", admins: "Administrators", faculty: "Faculty", subjects: "Subjects", sections: "Sections", "class-scheduling": isInstructor() ? "My classes" : "Class scheduling", "enrollment-config": "Enrollment configuration", audit: "Audit activity", profile: "My account" };
    document.getElementById("page-breadcrumb").textContent = titles[page];
    document.getElementById("sidebar").classList.remove("sidebar-open");
    clearAlert(elements.pageAlert);
    if (page === "admins") loadAdmins();
    if (page === "faculty" && isSuperAdmin()) loadFaculty();
    if (page === "subjects") loadSubjects();
    if (page === "sections" && isDepartmentHead()) loadSections();
    if (page === "class-scheduling" && (isDepartmentHead() || isInstructor())) loadClassSchedules();
    if (page === "enrollment-config" && isDepartmentHead()) loadEnrollmentConfiguration();
    if (page === "audit") loadAuditLogs();
  }

  async function refreshOverview() {
    clearAlert(elements.pageAlert);
    document.getElementById("metric-admins").textContent = "…";
    document.getElementById("metric-active").textContent = "…";
    document.getElementById("metric-activity").textContent = "…";
    try {
      const [admins, logs] = await Promise.all([
        apiRequest("/admins/"),
        apiRequest(`/audit-logs/?limit=${OVERVIEW_ITEM_LIMIT}&offset=0`),
      ]);
      if (!Array.isArray(admins) || !Array.isArray(logs)) throw new Error("The API returned an unexpected response.");
      adminCache = admins;
      document.getElementById("metric-admins").textContent = admins.length;
      document.getElementById("metric-active").textContent = admins.filter((admin) => admin.is_active).length;
      document.getElementById("metric-activity").textContent = logs.length;
      renderOverviewAdmins(admins.slice(0, OVERVIEW_ITEM_LIMIT));
      renderOverviewAudit(logs.slice(0, OVERVIEW_ITEM_LIMIT));
    } catch (error) {
      document.getElementById("metric-admins").textContent = "—";
      document.getElementById("metric-active").textContent = "—";
      document.getElementById("metric-activity").textContent = "—";
      document.getElementById("overview-admins").innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
      document.getElementById("overview-audit").innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
      showAlert(elements.pageAlert, error.message);
    }
  }

  function renderOverviewAdmins(admins) {
    const host = document.getElementById("overview-admins");
    if (!admins.length) {
      host.innerHTML = '<div class="empty-state"><p>No administrator accounts yet.</p></div>';
      return;
    }
    host.innerHTML = admins.map((admin) => {
      const name = fullName(admin);
      return `<div class="compact-admin">
        <div class="avatar">${escapeHtml(initials(name))}</div>
        <div class="compact-admin-info"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(admin.id_number || "No ID number")} · ${escapeHtml(admin.email)}</span></div>
        <span class="status-badge ${admin.is_active ? "active" : "inactive"}">${admin.is_active ? "Active" : "Inactive"}</span>
      </div>`;
    }).join("");
  }

  function auditIcon(action) {
    const normalized = String(action || "").toUpperCase();
    if (normalized.includes("LOGIN")) return "bi-box-arrow-in-right";
    if (normalized.includes("REGISTER")) return "bi-person-plus";
    if (normalized.includes("CREATE") || normalized.includes("CREATED")) return "bi-plus-circle";
    if (normalized.includes("DELETE") || normalized.includes("DELETED")) return "bi-trash";
    if (normalized.includes("PASSWORD")) return "bi-shield-lock";
    if (normalized.includes("DEACTIVATE")) return "bi-person-dash";
    if (normalized.includes("UPDATE")) return "bi-pencil-square";
    return "bi-activity";
  }

  function formatAuditAction(action) {
    const rawAction = String(action || "");
    const [code, detail] = rawAction.split(":", 2);
    if (!detail) return rawAction || "Unknown action";
    const labels = {
      LOGIN: "Signed in",
      REGISTER: "Created administrator account",
      CHANGE_PASSWORD: "Changed password",
      UPDATE_ADMIN: "Updated administrator account",
      DEACTIVATE_ADMIN: "Deactivated administrator account",
      CREATE_FACULTY: "Created faculty account",
      UPDATE_FACULTY: "Updated faculty account",
      DEACTIVATE_FACULTY: "Deactivated faculty account",
      CREATE_SUBJECT: "Created subject",
      UPDATE_SUBJECT: "Updated subject",
      DELETE_SUBJECT: "Deleted subject",
    };
    const label = labels[code] || code.replaceAll("_", " ").toLowerCase()
      .replace(/(^\w|\s\w)/g, (character) => character.toUpperCase());
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(detail || "");
    return detail && !isUuid ? `${label} (${detail})` : label;
  }

  function renderOverviewAudit(logs) {
    const host = document.getElementById("overview-audit");
    if (!logs.length) {
      host.innerHTML = '<div class="empty-state"><p>No recorded activity yet.</p></div>';
      return;
    }
    host.innerHTML = logs.map((log) => `<div class="activity-item">
      <div class="activity-icon"><i class="bi ${auditIcon(log.action)}"></i></div>
      <div class="activity-copy"><strong>${escapeHtml(formatAuditAction(log.action))}</strong><span>${escapeHtml(log.actor_name || "Unknown actor")} · ${escapeHtml(formatDate(log.created_at, true))}</span></div>
    </div>`).join("");
  }

  async function loadAdmins() {
    const body = elements.adminTableBody;
    body.innerHTML = '<tr><td colspan="7"><div class="loading-state"><span class="spinner-border spinner-border-sm"></span> Loading administrator accounts</div></td></tr>';
    document.getElementById("admin-empty").classList.add("d-none");
    const status = document.getElementById("admin-status-filter").value;
    const query = status === "all" ? "" : `?is_active=${encodeURIComponent(status)}`;
    try {
      const admins = await apiRequest(`/admins/${query}`);
      if (!Array.isArray(admins)) throw new Error("The API returned an unexpected response.");
      adminCache = admins;
      renderAdmins(admins);
    } catch (error) {
      body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>${escapeHtml(error.message)}</p></div></td></tr>`;
    }
  }

  function renderAdmins(admins) {
    const body = elements.adminTableBody;
    const canManageAdmins = isSuperAdmin();
    document.getElementById("admin-actions-heading").classList.toggle("d-none", !canManageAdmins);
    document.getElementById("admin-result-count").textContent = `${admins.length} account${admins.length === 1 ? "" : "s"} found`;
    document.getElementById("admin-empty").classList.toggle("d-none", admins.length > 0);
    if (!admins.length) {
      body.innerHTML = "";
      return;
    }
    const self = getAdmin();
    body.innerHTML = admins.map((admin) => {
      const name = fullName(admin);
      const isSelf = self && self.public_id === admin.public_id;
      return `<tr>
        <td><div class="person-cell"><div class="avatar">${escapeHtml(initials(name))}</div><div class="person-cell-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(admin.public_id)}</span></div></div></td>
        <td>${escapeHtml(admin.id_number)}</td>
        <td>${escapeHtml(admin.email)}</td>
        <td><span class="role-label">${escapeHtml(admin.role || "admin")}</span></td>
        <td><span class="status-badge ${admin.is_active ? "active" : "inactive"}">${admin.is_active ? "Active" : "Inactive"}</span></td>
        <td>${escapeHtml(formatDate(admin.created_at))}</td>
        ${canManageAdmins ? `<td><div class="row-actions"><button class="row-action" data-edit-admin="${escapeHtml(admin.public_id)}" title="Edit administrator" aria-label="Edit ${escapeHtml(name)}"><i class="bi bi-pencil"></i></button>${admin.is_active ? `<button class="row-action danger" data-deactivate-admin="${escapeHtml(admin.public_id)}" title="${isSelf ? "You cannot deactivate your own account" : "Deactivate administrator"}" aria-label="Deactivate ${escapeHtml(name)}" ${isSelf ? "disabled" : ""}><i class="bi bi-person-dash"></i></button>` : ""}</div></td>` : ""}
      </tr>`;
    }).join("");
  }

  async function loadFaculty() {
    if (!isSuperAdmin()) return;
    const body = document.getElementById("faculty-table-body");
    body.innerHTML = '<tr><td colspan="7"><div class="loading-state"><span class="spinner-border spinner-border-sm"></span> Loading faculty accounts</div></td></tr>';
    document.getElementById("faculty-empty").classList.add("d-none");
    const params = new URLSearchParams();
    const status = document.getElementById("faculty-status-filter").value;
    const role = document.getElementById("faculty-role-filter").value;
    if (status !== "all") params.set("is_active", status);
    if (role !== "all") params.set("role", role);
    try {
      const query = params.size ? `?${params.toString()}` : "";
      const faculty = await apiRequest(`/faculty/${query}`);
      if (!Array.isArray(faculty)) throw new Error("The API returned an unexpected response.");
      facultyCache = faculty;
      renderFaculty(faculty);
    } catch (error) {
      body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><p>${escapeHtml(error.message)}</p></div></td></tr>`;
    }
  }

  function renderFaculty(faculty) {
    const body = document.getElementById("faculty-table-body");
    document.getElementById("faculty-result-count").textContent = `${faculty.length} account${faculty.length === 1 ? "" : "s"} found`;
    document.getElementById("faculty-empty").classList.toggle("d-none", faculty.length > 0);
    if (!faculty.length) {
      body.innerHTML = "";
      return;
    }
    body.innerHTML = faculty.map((member) => {
      const name = fullName(member);
      const role = member.role === "department_head" ? "Department head" : "Instructor";
      return `<tr>
        <td><div class="person-cell"><div class="avatar">${escapeHtml(initials(name))}</div><div class="person-cell-copy"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(member.public_id)}</span></div></div></td>
        <td>${escapeHtml(member.id_number)}</td>
        <td>${escapeHtml(member.email)}</td>
        <td><span class="role-label">${role}</span></td>
        <td><span class="status-badge ${member.is_active ? "active" : "inactive"}">${member.is_active ? "Active" : "Inactive"}</span></td>
        <td>${escapeHtml(formatDate(member.created_at))}</td>
        <td><div class="row-actions"><button class="row-action" data-edit-faculty="${escapeHtml(member.public_id)}" title="Edit faculty member" aria-label="Edit ${escapeHtml(name)}"><i class="bi bi-pencil"></i></button>${member.is_active ? `<button class="row-action danger" data-deactivate-faculty="${escapeHtml(member.public_id)}" title="Deactivate faculty member" aria-label="Deactivate ${escapeHtml(name)}"><i class="bi bi-person-dash"></i></button>` : ""}</div></td>
      </tr>`;
    }).join("");
  }

  function openCreateFaculty() {
    if (!isSuperAdmin()) return;
    clearAlert(document.getElementById("faculty-form-alert"));
    document.getElementById("faculty-form").reset();
    document.getElementById("faculty-public-id").value = "";
    document.getElementById("faculty-modal-title").textContent = "Add faculty";
    document.getElementById("faculty-modal-eyebrow").textContent = "NEW FACULTY ACCOUNT";
    document.getElementById("faculty-password-field").classList.remove("d-none");
    document.getElementById("faculty-password").required = true;
    document.getElementById("faculty-active-field").classList.add("d-none");
    document.getElementById("faculty-submit").querySelector(".button-label").textContent = "Create account";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("faculty-modal")).show();
  }

  function openEditFaculty(publicId) {
    if (!isSuperAdmin()) return;
    const member = facultyCache.find((item) => item.public_id === publicId);
    if (!member) {
      showAlert(elements.pageAlert, "That faculty account could not be found. Refresh the list and try again.");
      return;
    }
    clearAlert(document.getElementById("faculty-form-alert"));
    document.getElementById("faculty-form").reset();
    document.getElementById("faculty-public-id").value = member.public_id;
    document.getElementById("faculty-fname").value = member.fname || "";
    document.getElementById("faculty-mname").value = member.mname || "";
    document.getElementById("faculty-lname").value = member.lname || "";
    document.getElementById("faculty-id-number").value = member.id_number || "";
    document.getElementById("faculty-email").value = member.email || "";
    document.getElementById("faculty-role").value = member.role;
    document.getElementById("faculty-password").value = "";
    document.getElementById("faculty-modal-title").textContent = "Edit faculty";
    document.getElementById("faculty-modal-eyebrow").textContent = "FACULTY ACCOUNT DETAILS";
    document.getElementById("faculty-password-field").classList.add("d-none");
    document.getElementById("faculty-password").required = false;
    document.getElementById("faculty-active").checked = Boolean(member.is_active);
    document.getElementById("faculty-active-field").classList.remove("d-none");
    document.getElementById("faculty-submit").querySelector(".button-label").textContent = "Save changes";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("faculty-modal")).show();
  }

  async function deactivateFaculty(publicId, button) {
    if (!isSuperAdmin()) return;
    const member = facultyCache.find((item) => item.public_id === publicId);
    if (!member || !window.confirm(`Deactivate ${fullName(member)}? They will no longer be able to sign in.`)) return;
    button.disabled = true;
    try {
      const result = await apiRequest(`/faculty/${encodeURIComponent(publicId)}`, { method: "DELETE" });
      showToast(result.message || "Faculty account deactivated.");
      await loadFaculty();
    } catch (error) {
      showAlert(elements.pageAlert, error.message);
      button.disabled = false;
    }
  }

  async function loadSubjects() {
    const body = document.getElementById("subject-table-body");
    body.innerHTML = '<tr><td colspan="9"><div class="loading-state"><span class="spinner-border spinner-border-sm"></span> Loading subjects</div></td></tr>';
    document.getElementById("subject-empty").classList.add("d-none");
    const params = new URLSearchParams();
    const year = document.getElementById("subject-year-filter").value;
    const semester = document.getElementById("subject-semester-filter").value;
    if (year !== "all") params.set("year_level", year);
    if (semester !== "all") params.set("semester", semester);
    try {
      const query = params.size ? `?${params.toString()}` : "";
      const subjects = await apiRequest(`/subjects/${query}`);
      if (!Array.isArray(subjects)) throw new Error("The API returned an unexpected response.");
      subjectCache = subjects;
      renderSubjects(subjects);
    } catch (error) {
      body.innerHTML = `<tr><td colspan="9"><div class="empty-state"><p>${escapeHtml(error.message)}</p></div></td></tr>`;
    }
  }

  function renderSubjects(subjects) {
    const body = document.getElementById("subject-table-body");
    const canManage = isDepartmentHead();
    document.getElementById("subject-actions-heading").classList.toggle("d-none", !canManage);
    document.getElementById("subject-result-count").textContent = `${subjects.length} subject${subjects.length === 1 ? "" : "s"} found`;
    document.getElementById("subject-empty").classList.toggle("d-none", subjects.length > 0);
    if (!subjects.length) {
      body.innerHTML = "";
      return;
    }
    body.innerHTML = subjects.map((subject) => {
      const semester = { 1: "First", 2: "Second", 3: "Midyear" }[subject.semester] || subject.semester;
      return `<tr>
        <td><strong class="text-dark fw-semibold">${escapeHtml(subject.course_no)}</strong></td>
        <td>${escapeHtml(subject.title)}</td>
        <td>${escapeHtml(subject.lec_units)}</td>
        <td>${escapeHtml(subject.lab_units)}</td>
        <td>${escapeHtml(subject.total_units)}</td>
        <td>${escapeHtml(subject.pre_requisite)}</td>
        <td>${escapeHtml(subject.year_level)}</td>
        <td>${escapeHtml(semester)}</td>
        ${canManage ? `<td><div class="row-actions"><button class="row-action" data-edit-subject="${escapeHtml(subject.public_id)}" title="Edit subject" aria-label="Edit ${escapeHtml(subject.course_no)}"><i class="bi bi-pencil"></i></button><button class="row-action danger" data-delete-subject="${escapeHtml(subject.public_id)}" title="Delete subject" aria-label="Delete ${escapeHtml(subject.course_no)}"><i class="bi bi-trash"></i></button></div></td>` : ""}
      </tr>`;
    }).join("");
  }

  async function loadSections() {
    const body = document.getElementById("section-table-body");
    body.innerHTML = '<tr><td colspan="6"><div class="loading-state"><span class="spinner-border spinner-border-sm"></span> Loading sections</div></td></tr>';
    document.getElementById("section-empty").classList.add("d-none");
    try {
      const sections = await apiRequest("/sections/");
      if (!Array.isArray(sections)) throw new Error("The API returned an unexpected response.");
      sectionCache = sections;
      document.getElementById("section-result-count").textContent = `${sections.length} section${sections.length === 1 ? "" : "s"} found`;
      document.getElementById("section-empty").classList.toggle("d-none", sections.length > 0);
      body.innerHTML = sections.map((section) => {
        const semester = { 1: "First", 2: "Second", 3: "Midyear" }[section.semester] || section.semester;
        const year = { 1: "First", 2: "Second", 3: "Third", 4: "Fourth" }[section.year_level] || section.year_level;
        return `<tr>
          <td><strong class="text-dark fw-semibold">${escapeHtml(section.section_name)}</strong></td>
          <td>${escapeHtml(year)} year</td>
          <td>${escapeHtml(section.capacity)}</td>
          <td>${escapeHtml(semester)}</td>
          <td>${escapeHtml(formatDate(section.created_at))}</td>
          <td><div class="row-actions"><button class="row-action" data-edit-section="${escapeHtml(section.public_id)}" title="Edit section" aria-label="Edit ${escapeHtml(section.section_name)}"><i class="bi bi-pencil"></i></button><button class="row-action danger" data-delete-section="${escapeHtml(section.public_id)}" title="Delete section" aria-label="Delete ${escapeHtml(section.section_name)}"><i class="bi bi-trash"></i></button></div></td>
        </tr>`;
      }).join("");
    } catch (error) {
      body.innerHTML = `<tr><td colspan="6"><div class="empty-state"><p>${escapeHtml(error.message)}</p></div></td></tr>`;
    }
  }

  function openCreateSection() {
    if (!isDepartmentHead()) return;
    clearAlert(document.getElementById("section-form-alert"));
    document.getElementById("section-form").reset();
    document.getElementById("section-public-id").value = "";
    document.getElementById("section-capacity").value = "40";
    document.getElementById("section-modal-title").textContent = "Create section";
    document.getElementById("section-submit").querySelector(".button-label").textContent = "Create section";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("section-modal")).show();
  }

  function openEditSection(publicId) {
    if (!isDepartmentHead()) return;
    const section = sectionCache.find((item) => item.public_id === publicId);
    if (!section) {
      showAlert(elements.pageAlert, "That section could not be found. Refresh the list and try again.");
      return;
    }
    clearAlert(document.getElementById("section-form-alert"));
    document.getElementById("section-form").reset();
    document.getElementById("section-public-id").value = section.public_id;
    document.getElementById("section-name").value = section.section_name;
    document.getElementById("section-year-level").value = section.year_level;
    document.getElementById("section-capacity").value = section.capacity;
    document.getElementById("section-semester").value = section.semester;
    document.getElementById("section-modal-title").textContent = "Edit section";
    document.getElementById("section-submit").querySelector(".button-label").textContent = "Save changes";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("section-modal")).show();
  }

  async function loadClassSchedules() {
    const body = document.getElementById("class-schedule-table-body");
    const isInstructorView = isInstructor();
    const columnCount = isInstructorView ? 6 : 8;
    body.innerHTML = `<tr><td colspan="${columnCount}"><div class="loading-state"><span class="spinner-border spinner-border-sm"></span> Loading schedules</div></td></tr>`;
    document.getElementById("class-schedule-empty").classList.add("d-none");
    document.getElementById("class-schedule-instructor-heading").classList.toggle("d-none", isInstructorView);
    try {
      let schedules;
      let options;
      if (isInstructorView) {
        const [assignedSchedules, sections, subjects] = await Promise.all([
          apiRequest("/class-schedules/"),
          apiRequest("/sections/"),
          apiRequest("/subjects/"),
        ]);
        schedules = assignedSchedules;
        options = { sections, subjects, instructors: [] };
      } else {
        [schedules, options] = await Promise.all([
          apiRequest("/class-schedules/"),
          apiRequest("/class-schedules/options"),
        ]);
      }
      if (!Array.isArray(schedules) || !Array.isArray(options.sections) || !Array.isArray(options.subjects) || !Array.isArray(options.instructors)) {
        throw new Error("The API returned an unexpected response.");
      }
      classScheduleOptions = options;
      classScheduleCache = schedules;
      renderClassSchedules(schedules);
    } catch (error) {
      body.innerHTML = `<tr><td colspan="${columnCount}"><div class="empty-state"><p>${escapeHtml(error.message)}</p></div></td></tr>`;
    }
  }

  async function loadEnrollmentConfiguration() {
    const form = document.getElementById("enrollment-config-form");
    const updatedLabel = document.getElementById("enrollment-config-updated");
    if (!isDepartmentHead()) return;
    clearAlert(elements.pageAlert);
    updatedLabel.textContent = "Loading current configuration…";
    try {
      const settings = await apiRequest("/enrollment-config/current");
      if (!settings || typeof settings !== "object") {
        throw new Error("The API returned an unexpected enrollment configuration.");
      }
      document.getElementById("active-school-year").value = settings.active_school_year;
      document.getElementById("active-semester").value = settings.active_semester;
      document.getElementById("enrollment-start").value = toDateTimeLocal(settings.enrollment_start);
      document.getElementById("enrollment-end").value = toDateTimeLocal(settings.enrollment_end);
      updatedLabel.textContent = `Last updated ${formatDate(settings.updated_at, true)}`;
    } catch (error) {
      updatedLabel.textContent = "";
      showAlert(elements.pageAlert, error.message);
    }
  }

  function renderClassSchedules(schedules) {
    const body = document.getElementById("class-schedule-table-body");
    const canManage = isDepartmentHead();
    const instructorView = isInstructor();
    document.getElementById("class-schedule-actions-heading").classList.toggle("d-none", !canManage);
    document.getElementById("class-schedule-instructor-heading").classList.toggle("d-none", instructorView);
    document.getElementById("class-schedule-empty-title").textContent = instructorView ? "No classes assigned" : "No schedules found";
    document.getElementById("class-schedule-empty-description").textContent = instructorView
      ? "Your assigned classes will appear here."
      : "Create a schedule to assign a subject and instructor to an existing section.";
    const sectionsById = new Map(classScheduleOptions.sections.map((section) => [section.id, section]));
    const subjectsById = new Map(classScheduleOptions.subjects.map((subject) => [subject.id, subject]));
    const instructorsById = new Map(classScheduleOptions.instructors.map((instructor) => [instructor.id, instructor]));
    document.getElementById("class-schedule-result-count").textContent = `${schedules.length} schedule${schedules.length === 1 ? "" : "s"} found`;
    document.getElementById("class-schedule-empty").classList.toggle("d-none", schedules.length > 0);
    if (!schedules.length) {
      body.innerHTML = "";
      return;
    }
    body.innerHTML = schedules.map((schedule) => {
      const section = sectionsById.get(schedule.section_id);
      const subject = subjectsById.get(schedule.subject_id);
      const instructor = instructorsById.get(schedule.instructor_id);
      const semester = { 1: "First", 2: "Second", 3: "Midyear" }[section?.semester] || section?.semester || "—";
      const days = formatScheduleDays(schedule.days);
      const startTime = String(schedule.start_time || "").slice(0, 5);
      const endTime = String(schedule.end_time || "").slice(0, 5);
      return `<tr>
        <td><strong class="text-dark fw-semibold">${escapeHtml(section?.section_name || "Section unavailable")}</strong></td>
        <td>${subject
          ? instructorView
            ? `<button type="button" class="btn btn-link p-0 text-start fw-semibold" data-show-enrollments="${escapeHtml(schedule.public_id)}" aria-label="View students enrolled in ${escapeHtml(subject.course_no)} — ${escapeHtml(subject.title)}">${escapeHtml(subject.course_no)} — ${escapeHtml(subject.title)}</button>`
            : `${escapeHtml(subject.course_no)} — ${escapeHtml(subject.title)}`
          : "Subject unavailable"}</td>
        ${instructorView ? "" : `<td>${instructor ? escapeHtml(fullName(instructor)) : "Instructor unavailable"}</td>`}
        <td>${escapeHtml(days)}</td>
        <td>${escapeHtml(`${startTime}–${endTime}`)}</td>
        <td>${escapeHtml(schedule.room)}</td>
        <td>${escapeHtml(semester)}</td>
        ${canManage ? `<td><div class="row-actions"><button class="row-action" data-edit-class-schedule="${escapeHtml(schedule.public_id)}" title="Edit schedule" aria-label="Edit schedule for ${escapeHtml(section?.section_name || "section")}"><i class="bi bi-pencil"></i></button><button class="row-action danger" data-delete-class-schedule="${escapeHtml(schedule.public_id)}" title="Delete schedule" aria-label="Delete schedule for ${escapeHtml(section?.section_name || "section")}"><i class="bi bi-trash"></i></button></div></td>` : ""}
      </tr>`;
    }).join("");
  }

  async function openScheduleEnrollments(publicId) {
    if (!isInstructor()) return;
    const schedule = classScheduleCache.find((item) => item.public_id === publicId);
    const section = schedule && classScheduleOptions.sections.find((item) => item.id === schedule.section_id);
    const subject = schedule && classScheduleOptions.subjects.find((item) => item.id === schedule.subject_id);
    if (!schedule || !section || !subject) {
      showAlert(elements.pageAlert, "That assigned class could not be found. Refresh My classes and try again.");
      return;
    }

    const modalElement = document.getElementById("schedule-enrollments-modal");
    const alertElement = document.getElementById("schedule-enrollments-alert");
    const tableWrap = document.getElementById("schedule-enrollments-table-wrap");
    const emptyState = document.getElementById("schedule-enrollments-empty");
    const body = document.getElementById("schedule-enrollments-body");
    document.getElementById("schedule-enrollments-title").textContent =
      `${subject.course_no} — ${subject.title}`;
    document.getElementById("schedule-enrollments-subtitle").textContent =
      `Students enrolled in ${section.section_name}`;
    document.getElementById("schedule-enrollments-count").textContent = "Loading students…";
    alertElement.classList.add("d-none");
    tableWrap.classList.remove("d-none");
    emptyState.classList.add("d-none");
    body.innerHTML = '<tr><td colspan="5"><div class="loading-state"><span class="spinner-border spinner-border-sm"></span> Loading enrolled students</div></td></tr>';
    bootstrap.Modal.getOrCreateInstance(modalElement).show();

    try {
      const students = await apiRequest(`/class-schedules/${encodeURIComponent(publicId)}/enrollments`);
      if (!Array.isArray(students)) {
        throw new Error("The API returned an unexpected enrolled-student list.");
      }
      document.getElementById("schedule-enrollments-count").textContent =
        `${students.length} student${students.length === 1 ? "" : "s"} enrolled`;
      body.innerHTML = students.map((student) => {
        const name = fullName(student) || "Name unavailable";
        const statusClass = student.enrollment_status === "APPROVED"
          ? "text-bg-success"
          : "text-bg-warning";
        const semester = { 1: "First", 2: "Second", 3: "Midyear" }[student.semester] || student.semester;
        return `<tr>
          <td>${escapeHtml(student.id_number)}</td>
          <td>${escapeHtml(name)}</td>
          <td>${escapeHtml(`Year ${student.year_level}`)}</td>
          <td>${escapeHtml(semester)}</td>
          <td><span class="badge ${statusClass}">${escapeHtml(student.enrollment_status)}</span></td>
        </tr>`;
      }).join("");
      tableWrap.classList.toggle("d-none", students.length === 0);
      emptyState.classList.toggle("d-none", students.length !== 0);
    } catch (error) {
      tableWrap.classList.add("d-none");
      emptyState.classList.add("d-none");
      alertElement.textContent = error.message;
      alertElement.classList.remove("d-none");
      document.getElementById("schedule-enrollments-count").textContent = "Could not load students";
    }
  }

  function formatScheduleDays(value) {
    const dayNames = { M: "Mon", T: "Tue", W: "Wed", TH: "Thu", F: "Fri", S: "Sat", SU: "Sun" };
    const normalized = String(value || "").toUpperCase().replace(/\s/g, "");
    let days;
    if (normalized.includes(",")) {
      days = normalized.split(",");
    } else {
      days = [];
      let index = 0;
      const tokens = ["TH", "SU", "M", "T", "W", "F", "S"];
      while (index < normalized.length) {
        const day = tokens.find((token) => normalized.startsWith(token, index));
        if (!day) return normalized;
        days.push(day);
        index += day.length;
      }
    }
    return days.filter(Boolean).map((day) => dayNames[day] || day).join(", ");
  }

  function populateClassScheduleOptions(options) {
    const sectionSelect = document.getElementById("class-schedule-section");
    const subjectSelect = document.getElementById("class-schedule-subject");
    const instructorSelect = document.getElementById("class-schedule-instructor");
    sectionSelect.innerHTML = '<option value="">Select a section</option>' + options.sections.map((section) =>
      `<option value="${escapeHtml(section.id)}">${escapeHtml(section.section_name)} — Year ${escapeHtml(section.year_level)}, semester ${escapeHtml(section.semester)}</option>`
    ).join("");
    subjectSelect.innerHTML = '<option value="">Select a subject</option>' + options.subjects.map((subject) =>
      `<option value="${escapeHtml(subject.id)}">${escapeHtml(subject.course_no)} — ${escapeHtml(subject.title)}</option>`
    ).join("");
    const activeInstructors = options.instructors.filter((instructor) => instructor.is_active);
    instructorSelect.innerHTML = '<option value="">Select an instructor</option>' + activeInstructors.map((instructor) =>
      `<option value="${escapeHtml(instructor.id)}">${escapeHtml(fullName(instructor))} (${escapeHtml(instructor.id_number)})</option>`
    ).join("");
    return activeInstructors;
  }

  async function openCreateClassSchedule() {
    if (!isDepartmentHead()) return;
    clearAlert(document.getElementById("class-schedule-form-alert"));
    const button = document.getElementById("create-class-schedule-button");
    button.disabled = true;
    try {
      const options = await apiRequest("/class-schedules/options");
      if (!Array.isArray(options.sections) || !Array.isArray(options.subjects) || !Array.isArray(options.instructors)) {
        throw new Error("The API returned an unexpected response.");
      }
      classScheduleOptions = options;
      const activeInstructors = populateClassScheduleOptions(options);
      if (!options.sections.length || !options.subjects.length || !activeInstructors.length) {
        showAlert(
          document.getElementById("class-schedule-form-alert"),
          !options.sections.length
            ? "Create at least one section before creating a schedule."
            : !options.subjects.length
            ? "Create at least one subject before creating a class section."
            : "There are no active instructors available to assign.",
        );
      }
      document.getElementById("class-schedule-form").reset();
      document.getElementById("class-schedule-public-id").value = "";
      document.getElementById("class-schedule-room").value = "TBA";
      document.getElementById("class-schedule-modal-title").textContent = "Create schedule";
      document.getElementById("class-schedule-submit").querySelector(".button-label").textContent = "Create schedule";
      bootstrap.Modal.getOrCreateInstance(document.getElementById("class-schedule-modal")).show();
    } catch (error) {
      showAlert(elements.pageAlert, error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteSection(publicId, button) {
    const section = sectionCache.find((item) => item.public_id === publicId);
    if (!section || !isDepartmentHead()) return;
    if (!window.confirm(`Delete ${section.section_name}? This also permanently deletes every class schedule linked to this section.`)) return;
    button.disabled = true;
    try {
      await apiRequest(`/sections/${encodeURIComponent(publicId)}`, { method: "DELETE" });
      showToast("Section and its linked class schedules deleted.");
      await Promise.all([loadSections(), loadClassSchedules()]);
    } catch (error) {
      showAlert(elements.pageAlert, error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function deleteClassSchedule(publicId, button) {
    const schedule = classScheduleCache.find((item) => item.public_id === publicId);
    if (!schedule || !isDepartmentHead()) return;
    if (!window.confirm("Delete this class schedule? This will not delete its section or subject.")) return;
    button.disabled = true;
    try {
      await apiRequest(`/class-schedules/${encodeURIComponent(publicId)}`, { method: "DELETE" });
      showToast("Class schedule deleted.");
      await loadClassSchedules();
    } catch (error) {
      showAlert(elements.pageAlert, error.message);
    } finally {
      button.disabled = false;
    }
  }

  function openEditClassSchedule(publicId) {
    if (!isDepartmentHead()) return;
    const schedule = classScheduleCache.find((item) => item.public_id === publicId);
    if (!schedule) {
      showAlert(elements.pageAlert, "That schedule could not be found. Refresh the list and try again.");
      return;
    }
    clearAlert(document.getElementById("class-schedule-form-alert"));
    populateClassScheduleOptions(classScheduleOptions);
    const form = document.getElementById("class-schedule-form");
    form.reset();
    document.getElementById("class-schedule-public-id").value = schedule.public_id;
    document.getElementById("class-schedule-section").value = schedule.section_id;
    document.getElementById("class-schedule-subject").value = schedule.subject_id;
    document.getElementById("class-schedule-instructor").value = schedule.instructor_id;
    document.getElementById("class-schedule-room").value = schedule.room;
    document.getElementById("class-schedule-start-time").value = String(schedule.start_time).slice(0, 5);
    document.getElementById("class-schedule-end-time").value = String(schedule.end_time).slice(0, 5);
    const selectedDays = new Set(_parseScheduleDays(schedule.days));
    document.querySelectorAll("#class-schedule-days input").forEach((checkbox) => {
      checkbox.checked = selectedDays.has(checkbox.value);
    });
    document.getElementById("class-schedule-modal-title").textContent = "Edit schedule";
    document.getElementById("class-schedule-submit").querySelector(".button-label").textContent = "Save changes";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("class-schedule-modal")).show();
  }

  function _parseScheduleDays(value) {
    const aliases = { TH: "TH", SU: "SU" };
    const days = String(value || "").toUpperCase().replaceAll(" ", "");
    if (days.includes(",")) return days.split(",");
    const parsed = [];
    for (let index = 0; index < days.length;) {
      const token = days.slice(index).startsWith("TH")
        ? aliases.TH
        : days.slice(index).startsWith("SU")
        ? aliases.SU
        : days[index];
      parsed.push(token);
      index += token.length;
    }
    return parsed;
  }

  function openCreateSubject() {
    if (!isDepartmentHead()) return;
    clearAlert(document.getElementById("subject-form-alert"));
    document.getElementById("subject-form").reset();
    document.getElementById("subject-public-id").value = "";
    document.getElementById("subject-lec-units").value = "0";
    document.getElementById("subject-lab-units").value = "0";
    document.getElementById("subject-prerequisite").value = "None";
    document.getElementById("subject-modal-title").textContent = "Add subject";
    document.getElementById("subject-modal-eyebrow").textContent = "NEW CURRICULUM SUBJECT";
    document.getElementById("subject-submit").querySelector(".button-label").textContent = "Create subject";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("subject-modal")).show();
  }

  function openEditSubject(publicId) {
    if (!isDepartmentHead()) return;
    const subject = subjectCache.find((item) => item.public_id === publicId);
    if (!subject) {
      showAlert(elements.pageAlert, "That subject could not be found. Refresh the list and try again.");
      return;
    }
    clearAlert(document.getElementById("subject-form-alert"));
    document.getElementById("subject-form").reset();
    document.getElementById("subject-public-id").value = subject.public_id;
    document.getElementById("subject-course-no").value = subject.course_no;
    document.getElementById("subject-title").value = subject.title;
    document.getElementById("subject-lec-units").value = subject.lec_units;
    document.getElementById("subject-lab-units").value = subject.lab_units;
    document.getElementById("subject-total-units").value = subject.total_units;
    document.getElementById("subject-prerequisite").value = subject.pre_requisite;
    document.getElementById("subject-year").value = subject.year_level;
    document.getElementById("subject-semester").value = subject.semester;
    document.getElementById("subject-modal-title").textContent = "Edit subject";
    document.getElementById("subject-modal-eyebrow").textContent = "CURRICULUM SUBJECT DETAILS";
    document.getElementById("subject-submit").querySelector(".button-label").textContent = "Save changes";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("subject-modal")).show();
  }

  async function deleteSubject(publicId, button) {
    if (!isDepartmentHead()) return;
    const subject = subjectCache.find((item) => item.public_id === publicId);
    if (!subject || !window.confirm(`Permanently delete ${subject.course_no} — ${subject.title}?`)) return;
    button.disabled = true;
    try {
      const result = await apiRequest(`/subjects/${encodeURIComponent(publicId)}`, { method: "DELETE" });
      showToast(result.message || "Subject deleted.");
      await loadSubjects();
    } catch (error) {
      showAlert(elements.pageAlert, error.message);
      button.disabled = false;
    }
  }

  async function loadAuditLogs() {
    const body = elements.auditTableBody;
    body.innerHTML = '<tr><td colspan="4"><div class="loading-state"><span class="spinner-border spinner-border-sm"></span> Loading audit activity</div></td></tr>';
    document.getElementById("audit-empty").classList.add("d-none");
    const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE), offset: String(auditOffset) });
    if (auditFilters.adminId) params.set("admin_id", auditFilters.adminId);
    if (auditFilters.action) params.set("action", auditFilters.action);
    try {
      const logs = await apiRequest(`/audit-logs/?${params.toString()}`);
      if (!Array.isArray(logs)) throw new Error("The API returned an unexpected response.");
      auditHasNext = logs.length === AUDIT_PAGE_SIZE;
      document.getElementById("audit-result-count").textContent = `${logs.length} record${logs.length === 1 ? "" : "s"} on this page`;
      document.getElementById("audit-page-label").textContent = logs.length
        ? `Showing ${auditOffset + 1}–${auditOffset + logs.length}${auditHasNext ? "+" : ""}`
        : "No records on this page";
      document.getElementById("audit-prev").disabled = auditOffset === 0;
      document.getElementById("audit-next").disabled = !auditHasNext;
      document.getElementById("audit-empty").classList.toggle("d-none", logs.length > 0);
      body.innerHTML = logs.map((log) => `<tr>
        <td><span class="activity-icon d-inline-flex me-2" style="vertical-align:middle"><i class="bi ${auditIcon(log.action)}"></i></span><strong class="text-dark fw-semibold">${escapeHtml(formatAuditAction(log.action))}</strong></td>
        <td>${escapeHtml(log.actor_name || "Unknown actor")}</td>
        <td>${escapeHtml(log.ip_address || "—")}</td>
        <td>${escapeHtml(formatDate(log.created_at, true))}</td>
      </tr>`).join("");
    } catch (error) {
      body.innerHTML = `<tr><td colspan="4"><div class="empty-state"><p>${escapeHtml(error.message)}</p></div></td></tr>`;
      document.getElementById("audit-prev").disabled = true;
      document.getElementById("audit-next").disabled = true;
    }
  }

  function openEditAdmin(publicId) {
    if (!isSuperAdmin()) return;
    const admin = adminCache.find((item) => item.public_id === publicId);
    if (!admin) {
      showAlert(elements.pageAlert, "That administrator could not be found. Refresh the list and try again.");
      return;
    }
    clearAlert(document.getElementById("edit-admin-alert"));
    document.getElementById("edit-admin-public-id").value = admin.public_id;
    document.getElementById("edit-fname").value = admin.fname || "";
    document.getElementById("edit-mname").value = admin.mname || "";
    document.getElementById("edit-lname").value = admin.lname || "";
    document.getElementById("edit-id-number").value = admin.id_number || "";
    document.getElementById("edit-email").value = admin.email || "";
    document.getElementById("edit-active").checked = Boolean(admin.is_active);
    document.getElementById("edit-password").value = "";
    document.getElementById("edit-admin-title").textContent = "Edit administrator";
    document.getElementById("admin-modal-eyebrow").textContent = "ACCOUNT DETAILS";
    document.getElementById("admin-password-field").classList.add("d-none");
    document.getElementById("edit-password").required = false;
    document.getElementById("admin-active-field").classList.remove("d-none");
    document.getElementById("edit-admin-submit").querySelector(".button-label").textContent = "Save changes";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("edit-admin-modal")).show();
  }

  function openCreateAdmin() {
    if (!isSuperAdmin()) return;
    clearAlert(document.getElementById("edit-admin-alert"));
    document.getElementById("edit-admin-form").reset();
    document.getElementById("edit-admin-public-id").value = "";
    document.getElementById("edit-admin-title").textContent = "Add administrator";
    document.getElementById("admin-modal-eyebrow").textContent = "NEW ACCOUNT";
    document.getElementById("admin-password-field").classList.remove("d-none");
    document.getElementById("edit-password").required = true;
    document.getElementById("admin-active-field").classList.add("d-none");
    document.getElementById("edit-admin-submit").querySelector(".button-label").textContent = "Create account";
    bootstrap.Modal.getOrCreateInstance(document.getElementById("edit-admin-modal")).show();
  }

  async function deactivateAdmin(publicId, button) {
    if (!isSuperAdmin()) return;
    const admin = adminCache.find((item) => item.public_id === publicId);
    if (!admin || !window.confirm(`Deactivate ${fullName(admin)}? They will no longer be able to sign in.`)) return;
    button.disabled = true;
    try {
      const result = await apiRequest(`/admins/${encodeURIComponent(publicId)}`, { method: "DELETE" });
      showToast(result.message || "Administrator deactivated.");
      await loadAdmins();
      if (currentPage === "overview") await refreshOverview();
    } catch (error) {
      showAlert(elements.pageAlert, error.message);
      button.disabled = false;
    }
  }

  function showToast(message) {
    const region = document.getElementById("toast-region");
    const toast = document.createElement("div");
    toast.className = "toast align-items-center";
    toast.setAttribute("role", "status");
    toast.innerHTML = `<div class="d-flex"><div class="toast-body">${escapeHtml(message)}</div><button type="button" class="btn-close me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
    region.append(toast);
    const instance = bootstrap.Toast.getOrCreateInstance(toast, { delay: 3500 });
    toast.addEventListener("hidden.bs.toast", () => toast.remove(), { once: true });
    instance.show();
  }

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(elements.authAlert);
    if (!elements.loginForm.reportValidity()) return;
    const button = document.getElementById("login-submit");
    setLoading(button, true, "Signing in…");
    try {
      const result = await apiRequest("/auth/login", {
        method: "POST",
        auth: false,
        body: JSON.stringify({
          email: document.getElementById("login-email").value.trim(),
          password: document.getElementById("login-password").value,
        }),
      });
      const profile = result.admin;
      saveSession(result.access_token, profile);
      showApplication(profile, loginAccountType);
    } catch (error) {
      showAlert(elements.authAlert, error.message);
    } finally {
      setLoading(button, false, "Sign in");
    }
  });

  document.getElementById("login-submit").querySelector(".button-label").textContent = "Administrator sign in";

  document.querySelectorAll("[data-password-target]").forEach((button) => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordTarget);
      input.type = input.type === "password" ? "text" : "password";
      button.setAttribute("aria-label", input.type === "password" ? "Show password" : "Hide password");
      button.innerHTML = `<i class="bi ${input.type === "password" ? "bi-eye" : "bi-eye-slash"}"></i>`;
    });
  });

  document.querySelectorAll(".sidebar-nav [data-page], .user-chip [data-page], .text-action[data-page]").forEach((button) => {
    button.addEventListener("click", () => navigateTo(button.dataset.page));
  });

  document.getElementById("logout-button").addEventListener("click", () => signOut());
  document.getElementById("sidebar-toggle").addEventListener("click", () => document.getElementById("sidebar").classList.toggle("sidebar-open"));
  document.getElementById("refresh-overview").addEventListener("click", refreshOverview);
  document.getElementById("admins-refresh").addEventListener("click", loadAdmins);
  document.getElementById("create-admin-button").addEventListener("click", openCreateAdmin);
  document.getElementById("admin-status-filter").addEventListener("change", loadAdmins);
  document.getElementById("create-faculty-button").addEventListener("click", openCreateFaculty);
  document.getElementById("faculty-refresh").addEventListener("click", loadFaculty);
  document.getElementById("faculty-status-filter").addEventListener("change", loadFaculty);
  document.getElementById("faculty-role-filter").addEventListener("change", loadFaculty);
  document.getElementById("subjects-refresh").addEventListener("click", loadSubjects);
  document.getElementById("sections-refresh").addEventListener("click", loadSections);
  document.getElementById("enrollment-config-refresh").addEventListener("click", loadEnrollmentConfiguration);
  document.getElementById("enrollment-config-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isDepartmentHead()) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;

    const startValue = document.getElementById("enrollment-start").value;
    const endValue = document.getElementById("enrollment-end").value;
    if (new Date(startValue) >= new Date(endValue)) {
      showAlert(elements.pageAlert, "Enrollment end must be later than enrollment start.");
      return;
    }
    const button = document.getElementById("enrollment-config-submit");
    setLoading(button, true, "Saving…");
    clearAlert(elements.pageAlert);
    try {
      const settings = await apiRequest("/enrollment-config/current", {
        method: "PUT",
        body: JSON.stringify({
          active_school_year: document.getElementById("active-school-year").value.trim(),
          active_semester: Number(document.getElementById("active-semester").value),
          enrollment_start: fromDateTimeLocal(startValue),
          enrollment_end: fromDateTimeLocal(endValue),
        }),
      });
      document.getElementById("enrollment-start").value = toDateTimeLocal(settings.enrollment_start);
      document.getElementById("enrollment-end").value = toDateTimeLocal(settings.enrollment_end);
      document.getElementById("enrollment-config-updated").textContent =
        `Last updated ${formatDate(settings.updated_at, true)}`;
      showAlert(elements.pageAlert, "Enrollment configuration saved successfully.", "success");
    } catch (error) {
      showAlert(elements.pageAlert, error.message);
    } finally {
      setLoading(button, false, "Save configuration");
    }
  });
  document.getElementById("create-section-button").addEventListener("click", openCreateSection);
  document.getElementById("section-table-body").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-section]");
    if (editButton) openEditSection(editButton.dataset.editSection);
    const deleteButton = event.target.closest("[data-delete-section]");
    if (deleteButton) deleteSection(deleteButton.dataset.deleteSection, deleteButton);
  });
  document.getElementById("class-schedules-refresh").addEventListener("click", loadClassSchedules);
  document.getElementById("create-class-schedule-button").addEventListener("click", openCreateClassSchedule);
  document.getElementById("class-schedule-table-body").addEventListener("click", (event) => {
    const enrollmentsButton = event.target.closest("[data-show-enrollments]");
    if (enrollmentsButton) openScheduleEnrollments(enrollmentsButton.dataset.showEnrollments);
    const editButton = event.target.closest("[data-edit-class-schedule]");
    if (editButton) openEditClassSchedule(editButton.dataset.editClassSchedule);
    const deleteButton = event.target.closest("[data-delete-class-schedule]");
    if (deleteButton) deleteClassSchedule(deleteButton.dataset.deleteClassSchedule, deleteButton);
  });
  document.getElementById("subject-year-filter").addEventListener("change", loadSubjects);
  document.getElementById("subject-semester-filter").addEventListener("change", loadSubjects);
  document.getElementById("create-subject-button").addEventListener("click", openCreateSubject);
  document.getElementById("audit-refresh").addEventListener("click", loadAuditLogs);
  document.getElementById("audit-filter-form").addEventListener("submit", (event) => {
    event.preventDefault();
    auditOffset = 0;
    auditFilters = {
      adminId: document.getElementById("audit-admin-filter").value.trim(),
      action: document.getElementById("audit-action-filter").value.trim(),
    };
    loadAuditLogs();
  });
  document.getElementById("audit-prev").addEventListener("click", () => {
    auditOffset = Math.max(0, auditOffset - AUDIT_PAGE_SIZE);
    loadAuditLogs();
  });
  document.getElementById("audit-next").addEventListener("click", () => {
    if (auditHasNext) {
      auditOffset += AUDIT_PAGE_SIZE;
      loadAuditLogs();
    }
  });

  elements.adminTableBody.addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-admin]");
    if (editButton) openEditAdmin(editButton.dataset.editAdmin);
    const deactivateButton = event.target.closest("[data-deactivate-admin]");
    if (deactivateButton) deactivateAdmin(deactivateButton.dataset.deactivateAdmin, deactivateButton);
  });

  document.getElementById("faculty-table-body").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-faculty]");
    if (editButton) openEditFaculty(editButton.dataset.editFaculty);
    const deactivateButton = event.target.closest("[data-deactivate-faculty]");
    if (deactivateButton) deactivateFaculty(deactivateButton.dataset.deactivateFaculty, deactivateButton);
  });

  document.getElementById("subject-table-body").addEventListener("click", (event) => {
    const editButton = event.target.closest("[data-edit-subject]");
    if (editButton) openEditSubject(editButton.dataset.editSubject);
    const deleteButton = event.target.closest("[data-delete-subject]");
    if (deleteButton) deleteSubject(deleteButton.dataset.deleteSubject, deleteButton);
  });

  document.getElementById("subject-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const alert = document.getElementById("subject-form-alert");
    clearAlert(alert);
    if (!isDepartmentHead()) {
      showAlert(alert, "Only the department head can manage subjects.");
      return;
    }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const publicId = document.getElementById("subject-public-id").value;
    const creating = !publicId;
    const button = document.getElementById("subject-submit");
    setLoading(button, true, creating ? "Creating…" : "Saving…");
    const payload = {
      course_no: document.getElementById("subject-course-no").value.trim(),
      title: document.getElementById("subject-title").value.trim(),
      lec_units: Number(document.getElementById("subject-lec-units").value),
      lab_units: Number(document.getElementById("subject-lab-units").value),
      total_units: Number(document.getElementById("subject-total-units").value),
      pre_requisite: document.getElementById("subject-prerequisite").value.trim(),
      year_level: Number(document.getElementById("subject-year").value),
      semester: Number(document.getElementById("subject-semester").value),
    };
    try {
      await apiRequest(creating ? "/subjects/" : `/subjects/${encodeURIComponent(publicId)}`, {
        method: creating ? "POST" : "PATCH",
        body: JSON.stringify(payload),
      });
      bootstrap.Modal.getInstance(document.getElementById("subject-modal")).hide();
      showToast(creating ? "Subject created." : "Subject updated.");
      await loadSubjects();
    } catch (error) {
      showAlert(alert, error.message);
    } finally {
      setLoading(button, false, creating ? "Create subject" : "Save changes");
    }
  });

  document.getElementById("class-schedule-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const alert = document.getElementById("class-schedule-form-alert");
    clearAlert(alert);
    if (!isDepartmentHead()) {
      showAlert(alert, "Only the department head can manage class schedules.");
      return;
    }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const selectedDays = [...document.querySelectorAll("#class-schedule-days input:checked")].map((checkbox) => checkbox.value);
    if (!selectedDays.length) {
      showAlert(alert, "Select at least one day for the class section.");
      return;
    }
    const startTime = document.getElementById("class-schedule-start-time").value;
    const endTime = document.getElementById("class-schedule-end-time").value;
    if (startTime >= endTime) {
      showAlert(alert, "The end time must be later than the start time.");
      return;
    }
    const button = document.getElementById("class-schedule-submit");
    const publicId = document.getElementById("class-schedule-public-id").value;
    const creating = !publicId;
    setLoading(button, true, creating ? "Creating…" : "Saving…");
    const payload = {
      section_id: Number(document.getElementById("class-schedule-section").value),
      subject_id: Number(document.getElementById("class-schedule-subject").value),
      instructor_id: Number(document.getElementById("class-schedule-instructor").value),
      room: document.getElementById("class-schedule-room").value.trim(),
      days: selectedDays.join(","),
      start_time: startTime,
      end_time: endTime,
    };
    try {
      await apiRequest(creating ? "/class-schedules/" : `/class-schedules/${encodeURIComponent(publicId)}`, {
        method: creating ? "POST" : "PATCH",
        body: JSON.stringify(payload),
      });
      bootstrap.Modal.getInstance(document.getElementById("class-schedule-modal")).hide();
      showToast(creating ? "Class schedule created." : "Class schedule updated.");
      await loadClassSchedules();
    } catch (error) {
      showAlert(alert, error.message);
    } finally {
      setLoading(button, false, creating ? "Create schedule" : "Save changes");
    }
  });

  document.getElementById("section-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const alert = document.getElementById("section-form-alert");
    clearAlert(alert);
    if (!isDepartmentHead()) {
      showAlert(alert, "Only the department head can manage sections.");
      return;
    }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const publicId = document.getElementById("section-public-id").value;
    const creating = !publicId;
    const button = document.getElementById("section-submit");
    setLoading(button, true, creating ? "Creating…" : "Saving…");
    const payload = {
      section_name: document.getElementById("section-name").value.trim(),
      year_level: Number(document.getElementById("section-year-level").value),
      capacity: Number(document.getElementById("section-capacity").value),
      semester: Number(document.getElementById("section-semester").value),
    };
    try {
      await apiRequest(creating ? "/sections/" : `/sections/${encodeURIComponent(publicId)}`, {
        method: creating ? "POST" : "PATCH",
        body: JSON.stringify(payload),
      });
      bootstrap.Modal.getInstance(document.getElementById("section-modal")).hide();
      showToast(creating ? "Section created." : "Section updated.");
      await loadSections();
    } catch (error) {
      showAlert(alert, error.message);
    } finally {
      setLoading(button, false, creating ? "Create section" : "Save changes");
    }
  });

  document.getElementById("faculty-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(document.getElementById("faculty-form-alert"));
    if (!isSuperAdmin()) {
      showAlert(document.getElementById("faculty-form-alert"), "Only super admins can manage faculty accounts.");
      return;
    }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const publicId = document.getElementById("faculty-public-id").value;
    const creating = !publicId;
    const button = document.getElementById("faculty-submit");
    setLoading(button, true, creating ? "Creating…" : "Saving…");
    const facultyPayload = {
      fname: document.getElementById("faculty-fname").value.trim(),
      mname: document.getElementById("faculty-mname").value.trim() || null,
      lname: document.getElementById("faculty-lname").value.trim(),
      id_number: document.getElementById("faculty-id-number").value.trim(),
      email: document.getElementById("faculty-email").value.trim(),
      role: document.getElementById("faculty-role").value,
    };
    try {
      await apiRequest(creating ? "/faculty/" : `/faculty/${encodeURIComponent(publicId)}`, {
        method: creating ? "POST" : "PATCH",
        body: JSON.stringify(creating ? {
          ...facultyPayload,
          password: document.getElementById("faculty-password").value,
        } : {
          ...facultyPayload,
          is_active: document.getElementById("faculty-active").checked,
        }),
      });
      bootstrap.Modal.getInstance(document.getElementById("faculty-modal")).hide();
      showToast(creating ? "Faculty account created." : "Faculty account updated.");
      await loadFaculty();
    } catch (error) {
      showAlert(document.getElementById("faculty-form-alert"), error.message);
    } finally {
      setLoading(button, false, creating ? "Create account" : "Save changes");
    }
  });

  document.getElementById("edit-admin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(document.getElementById("edit-admin-alert"));
    if (!isSuperAdmin()) {
      showAlert(document.getElementById("edit-admin-alert"), "Only super admins can manage administrator accounts.");
      return;
    }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const button = document.getElementById("edit-admin-submit");
    const publicId = document.getElementById("edit-admin-public-id").value;
    const creating = !publicId;
    setLoading(button, true, creating ? "Creating…" : "Saving…");
    try {
      const adminPayload = {
        fname: document.getElementById("edit-fname").value.trim(),
        mname: document.getElementById("edit-mname").value.trim() || null,
        lname: document.getElementById("edit-lname").value.trim(),
        id_number: document.getElementById("edit-id-number").value.trim(),
        email: document.getElementById("edit-email").value.trim(),
      };
      const result = await apiRequest(creating ? "/admins/" : `/admins/${encodeURIComponent(publicId)}`, {
        method: creating ? "POST" : "PATCH",
        body: JSON.stringify(creating ? {
          ...adminPayload,
          password: document.getElementById("edit-password").value,
        } : {
          ...adminPayload,
          is_active: document.getElementById("edit-active").checked,
        }),
      });
      if (!creating && getAdmin()?.public_id === result.public_id) {
        localStorage.setItem(ADMIN_KEY, JSON.stringify(result));
        showApplication(result);
      }
      bootstrap.Modal.getInstance(document.getElementById("edit-admin-modal")).hide();
      showToast(creating ? "Administrator account created." : "Administrator details updated.");
      await loadAdmins();
      await refreshOverview();
    } catch (error) {
      showAlert(document.getElementById("edit-admin-alert"), error.message);
    } finally {
      setLoading(button, false, creating ? "Create account" : "Save changes");
    }
  });

  document.getElementById("password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert(elements.pageAlert);
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const newPassword = document.getElementById("new-password").value;
    if (newPassword !== document.getElementById("confirm-password").value) {
      showAlert(elements.pageAlert, "The new password and confirmation do not match.");
      return;
    }
    const button = document.getElementById("password-submit");
    setLoading(button, true, "Updating…");
    try {
      const result = await apiRequest("/auth/change-password", {
        method: "PUT",
        body: JSON.stringify({
          current_password: document.getElementById("current-password").value,
          new_password: newPassword,
        }),
      });
      form.reset();
      showAlert(elements.pageAlert, result.message || "Password changed successfully.", "success");
    } catch (error) {
      showAlert(elements.pageAlert, error.message);
    } finally {
      setLoading(button, false, "Update password");
    }
  });

  const savedToken = getToken();
  const savedAdmin = getAdmin();
  const savedAccountType = localStorage.getItem(ACCOUNT_TYPE_KEY) || "admin";
  if (savedToken && savedAdmin) {
    loginAccountType = savedAccountType;
    const profileEndpoint = savedAccountType === "faculty" ? "/auth/faculty/me" : "/auth/me";
    apiRequest(profileEndpoint).then((profile) => {
      localStorage.setItem(ADMIN_KEY, JSON.stringify(profile));
      showApplication(profile, savedAccountType);
    }).catch((error) => {
      if (getToken()) showAlert(elements.pageAlert, error.message);
    });
  }
})();
