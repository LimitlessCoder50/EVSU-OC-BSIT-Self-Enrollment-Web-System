(() => {
  "use strict";

  const API_BASE_URL = "http://127.0.0.1:8000";
  const TOKEN_KEY = "evsuStudentToken";
  const authScreen = document.getElementById("student-auth-screen");
  const dashboard = document.getElementById("student-dashboard");
  const loginForm = document.getElementById("student-login-form");
  const signupForm = document.getElementById("student-signup-form");
  const alert = document.getElementById("student-auth-alert");
  const switchButton = document.getElementById("student-switch-button");
  let dashboardView = "fhe";
  let enrollmentWindow = null;
  let fheUploadInProgress = false;

  function showAlert(message, type = "danger") {
    alert.className = `alert alert-${type}`;
    alert.textContent = message;
    alert.classList.remove("d-none");
  }

  function clearAlert() {
    alert.textContent = "";
    alert.classList.add("d-none");
  }

  function setLoading(button, loading, label) {
    button.disabled = loading;
    button.querySelector(".button-label").textContent = label;
    button.querySelector(".spinner-border").classList.toggle("d-none", !loading);
  }

  async function request(path, options = {}) {
    const { auth = true, ...fetchOptions } = options;
    const headers = new Headers(fetchOptions.headers || {});
    if (fetchOptions.body && !(fetchOptions.body instanceof FormData)) {
      headers.set("Content-Type", "application/json");
    }
    if (auth && localStorage.getItem(TOKEN_KEY)) {
      headers.set("Authorization", `Bearer ${localStorage.getItem(TOKEN_KEY)}`);
    }
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/api/v1${path}`, {
        ...fetchOptions,
        headers,
      });
    } catch {
      throw new Error("Cannot reach the enrollment service. Check that the backend is running.");
    }

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : null;
    if (!response.ok) {
      const detail = payload?.detail;
      const message = typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((item) => item.msg || "Invalid input").join(" ")
          : typeof payload?.message === "string"
            ? payload.message
            : `Request failed (${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function termName(student) {
    const year = ({ 1: "First", 2: "Second", 3: "Third", 4: "Fourth" })[student.year_level];
    const semester = ({ 1: "First semester", 2: "Second semester", 3: "Midyear" })[student.semester];
    return `${year || "Year " + student.year_level} year · ${semester || "Semester " + student.semester}`;
  }

  function renderStudentHeader(student) {
    if (!student || typeof student !== "object") {
      throw new Error("The API returned an incomplete student profile.");
    }
    document.getElementById("dashboard-student-name").textContent =
      [student.fname, student.lname].filter(Boolean).join(" ") || "Student";
    document.getElementById("dashboard-student-id").textContent = `Student ID · ${student.id_number || "—"}`;
    document.getElementById("student-user-avatar").textContent =
      [student.fname, student.lname].filter(Boolean).map((part) => part[0]).join("") || "S";
    document.getElementById("dashboard-current-term").textContent = termName(student);
    authScreen.classList.add("d-none");
    dashboard.classList.remove("d-none");
  }

  function setApiState(connected) {
    const label = connected ? "API connected" : "API unavailable";
    document.getElementById("sidebar-api-status").textContent = label;
    document.getElementById("topbar-api-status").textContent = label;
    document.getElementById("student-sidebar-api-dot").classList.toggle("offline", !connected);
    document.getElementById("student-topbar-api-dot").classList.toggle("offline", !connected);
  }

  function setDashboardView(view) {
    const schedulesButton = document.getElementById("student-schedules-nav");
    if (view === "schedules" && schedulesButton.disabled) view = "fhe";
    dashboardView = view;

    document.getElementById("fhe-dashboard-view").classList.toggle("d-none", view !== "fhe");
    document.getElementById("available-schedules-panel").classList.toggle("d-none", view !== "schedules");
    document.querySelectorAll("[data-dashboard-view]").forEach((button) => {
      const active = button.dataset.dashboardView === view;
      button.classList.toggle("active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    const page = view === "schedules"
      ? {
        title: "Available class schedule",
        eyebrow: "CLASS SCHEDULE",
        description: "Browse schedules for your current year level and semester.",
      }
      : {
        title: "FHE Form",
        eyebrow: "ENROLLMENT REQUIREMENT",
        description: "Submit and track your FHE form for the current academic term.",
      };
    document.getElementById("student-page-breadcrumb").textContent = page.title;
    document.getElementById("student-page-title").textContent = page.title;
    document.getElementById("student-page-eyebrow").textContent = page.eyebrow;
    document.getElementById("student-page-description").textContent = page.description;
    if (window.innerWidth <= 991.98) {
      document.getElementById("student-sidebar").classList.remove("sidebar-open");
    }
  }

  function setEnrollmentWindow(windowConfig) {
    if (
      !windowConfig
      || typeof windowConfig.enrollment_start !== "string"
      || typeof windowConfig.enrollment_end !== "string"
      || typeof windowConfig.fhe_upload_open !== "boolean"
      || !["not_started", "open", "closed"].includes(windowConfig.fhe_upload_state)
    ) {
      throw new Error("The API returned an invalid enrollment window.");
    }

    enrollmentWindow = windowConfig;
    const uploadOpen = windowConfig.fhe_upload_open;
    const start = new Date(windowConfig.enrollment_start);
    const end = new Date(windowConfig.enrollment_end);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw new Error("The API returned invalid enrollment dates.");
    }
    const formatDate = (date) => new Intl.DateTimeFormat("en-PH", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Manila",
    }).format(date);
    const notice = document.getElementById("fhe-window-notice");
    notice.className = `alert alert-${uploadOpen ? "info" : "warning"}`;
    notice.textContent = uploadOpen
      ? `FHE uploads are open from ${formatDate(start)} to ${formatDate(end)} (Philippine time).`
      : windowConfig.fhe_upload_state === "not_started"
        ? `FHE uploads are not open yet. The enrollment window opens ${formatDate(start)} and closes ${formatDate(end)} (Philippine time).`
        : `The enrollment window closed ${formatDate(end)} (Philippine time). FHE form uploads are unavailable.`;
    notice.classList.remove("d-none");

    document.getElementById("fhe-form-file").disabled = !uploadOpen;
    const uploadButton = document.getElementById("fhe-upload-submit");
    uploadButton.disabled = !uploadOpen || fheUploadInProgress;
    uploadButton.querySelector(".button-label").textContent = uploadOpen
      ? "Upload FHE form"
      : "Uploads unavailable";
    const resubmitButton = document.getElementById("fhe-resubmit-button");
    resubmitButton.disabled = !uploadOpen;
    if (resubmitButton.classList.contains("d-none")) return;
    resubmitButton.title = uploadOpen
      ? ""
      : "FHE form uploads are only available during the configured enrollment window.";
  }

  function signOut(message = "") {
    localStorage.removeItem(TOKEN_KEY);
    dashboard.classList.add("d-none");
    authScreen.classList.remove("d-none");
    loginForm.reset();
    signupForm.reset();
    document.getElementById("fhe-upload-form").reset();
    document.getElementById("fhe-upload-panel").classList.remove("d-none");
    document.getElementById("fhe-session-panel").classList.add("d-none");
    document.getElementById("fhe-window-notice").classList.add("d-none");
    enrollmentWindow = null;
    fheUploadInProgress = false;
    document.getElementById("fhe-form-file").disabled = true;
    document.getElementById("fhe-upload-submit").disabled = true;
    document.getElementById("student-schedules-nav").disabled = true;
    document.getElementById("student-schedules-nav").setAttribute("aria-disabled", "true");
    document.getElementById("student-sidebar").classList.remove("sidebar-open");
    document.getElementById("student-dashboard-alert").classList.add("d-none");
    setDashboardView("fhe");
    showLogin();
    if (message) showAlert(message, "info");
  }

  function showDashboardAlert(message, type = "danger") {
    const dashboardAlert = document.getElementById("student-dashboard-alert");
    dashboardAlert.className = `alert alert-${type}`;
    dashboardAlert.textContent = message;
  }

  function setEnrollmentSession(session) {
    const uploadPanel = document.getElementById("fhe-upload-panel");
    const sessionPanel = document.getElementById("fhe-session-panel");
    const badge = document.getElementById("dashboard-fhe-badge");
    const title = document.getElementById("fhe-session-title");
    const description = document.getElementById("fhe-session-description");
    const viewLink = document.getElementById("fhe-form-view-link");
    const resubmitButton = document.getElementById("fhe-resubmit-button");
    const unlockedNotice = document.getElementById("enrollment-unlocked-notice");
    const sessionIcon = document.getElementById("fhe-session-icon");

    if (!session) {
      uploadPanel.classList.remove("d-none");
      sessionPanel.classList.add("d-none");
      document.getElementById("student-schedules-nav").disabled = true;
      document.getElementById("student-schedules-nav").setAttribute("aria-disabled", "true");
      badge.className = "badge text-bg-warning ms-auto";
      badge.textContent = "Form required";
      setDashboardView("fhe");
      return;
    }

    uploadPanel.classList.add("d-none");
    sessionPanel.classList.remove("d-none");
    document.getElementById("student-schedules-nav").disabled = false;
    document.getElementById("student-schedules-nav").setAttribute("aria-disabled", "false");
    viewLink.classList.toggle("d-none", !session.fhe_form_url);
    viewLink.href = session.fhe_form_url || "#";
    resubmitButton.classList.toggle("d-none", session.fhe_status !== "REJECTED");
    unlockedNotice.classList.remove("d-none");
    sessionIcon.className = `metric-icon ${session.fhe_status === "VERIFIED" ? "green" : session.fhe_status === "REJECTED" ? "red" : "amber"}`;

    if (session.fhe_status === "VERIFIED") {
      badge.className = "badge text-bg-success ms-auto";
      badge.textContent = "Verified";
      title.textContent = "FHE form verified";
      description.textContent = "Your form has been verified. Current-term schedules are available in the sidebar.";
    } else if (session.fhe_status === "REJECTED") {
      badge.className = "badge text-bg-danger ms-auto";
      badge.textContent = "Needs resubmission";
      title.textContent = "FHE form needs resubmission";
      description.textContent = "Your form was not approved. You can upload a replacement; current-term schedules remain available in the sidebar.";
    } else {
      badge.className = "badge text-bg-warning ms-auto";
      badge.textContent = "Pending review";
      title.textContent = "FHE form received";
      description.textContent = "Your form is waiting for review. You can browse current-term schedules from the sidebar.";
    }
    setDashboardView(dashboardView);
  }

  function renderSchedules(schedules, hasSession) {
    const emptyState = document.getElementById("available-schedules-empty");
    const tableWrap = document.getElementById("available-schedules-table-wrap");
    const body = document.getElementById("available-schedules-body");
    body.replaceChildren();
    emptyState.classList.toggle("d-none", !hasSession || schedules.length > 0);
    tableWrap.classList.toggle("d-none", !hasSession || schedules.length === 0);
    if (!hasSession) return;

    for (const schedule of schedules) {
      const row = document.createElement("tr");
      const values = [
        schedule.section_name,
        `${schedule.course_no} — ${schedule.subject_title}`,
        schedule.instructor_name,
        schedule.days,
        `${String(schedule.start_time).slice(0, 5)}–${String(schedule.end_time).slice(0, 5)}`,
        schedule.room,
        `${schedule.total_units} (${schedule.lec_units} lec / ${schedule.lab_units} lab)`,
      ];
      for (const value of values) {
        const cell = document.createElement("td");
        cell.textContent = value ?? "—";
        row.append(cell);
      }
      body.append(row);
    }
  }

  async function refreshDashboard() {
    const refreshButton = document.getElementById("student-dashboard-refresh");
    refreshButton.disabled = true;
    document.getElementById("student-dashboard-alert").classList.add("d-none");
    try {
      const result = await request("/student/enrollment-session/current");
      if (!result?.student) throw new Error("The API returned an incomplete student dashboard.");
      setEnrollmentWindow(result.enrollment_window);
      if (!Array.isArray(result.available_schedules)) {
        throw new Error("The API returned an invalid class schedule list.");
      }
      renderStudentHeader(result.student);
      const session = result.enrollment_session || null;
      setEnrollmentSession(session);
      renderSchedules(result.available_schedules, Boolean(session));
      setApiState(true);
      return true;
    } catch (error) {
      if (error.status === 401 || /session has expired/i.test(error.message)) {
        signOut("Your student session has expired. Please sign in again.");
      } else {
        setApiState(false);
        showDashboardAlert(error.message);
      }
      return false;
    } finally {
      refreshButton.disabled = false;
    }
  }

  function showLogin() {
    clearAlert();
    loginForm.classList.remove("d-none");
    signupForm.classList.add("d-none");
    document.getElementById("student-auth-title").textContent = "Student sign in";
    document.getElementById("student-auth-description").textContent = "Enter your student account credentials to continue.";
    document.getElementById("student-switch-prompt").textContent = "New student?";
    switchButton.textContent = "Create an account";
  }

  function showSignup() {
    clearAlert();
    loginForm.classList.add("d-none");
    signupForm.classList.remove("d-none");
    document.getElementById("student-auth-title").textContent = "Create student account";
    document.getElementById("student-auth-description").textContent = "Enter your student details to register for enrollment access.";
    document.getElementById("student-switch-prompt").textContent = "Already registered?";
    switchButton.textContent = "Sign in";
  }

  async function acceptAuthentication(payload) {
    if (!payload?.access_token || !payload.student) {
      throw new Error("The API returned an incomplete student sign-in response.");
    }
    localStorage.setItem(TOKEN_KEY, payload.access_token);
    renderStudentHeader(payload.student);
    await refreshDashboard();
  }

  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert();
    if (!loginForm.reportValidity()) return;

    const button = document.getElementById("student-login-submit");
    setLoading(button, true, "Signing in…");
    try {
      const payload = await request("/auth/student-login", {
        method: "POST",
        body: JSON.stringify({
          email: document.getElementById("student-login-email").value.trim(),
          password: document.getElementById("student-login-password").value,
        }),
      });
      await acceptAuthentication(payload);
    } catch (error) {
      showAlert(error.message);
    } finally {
      setLoading(button, false, "Student sign in");
    }
  });

  signupForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearAlert();
    if (!signupForm.reportValidity()) return;

    const password = document.getElementById("student-signup-password").value;
    if (password !== document.getElementById("student-confirm-password").value) {
      showAlert("Password and confirmation do not match.");
      return;
    }
    if (new TextEncoder().encode(password).length > 72) {
      showAlert("Password must be no more than 72 UTF-8 bytes.");
      return;
    }

    const button = document.getElementById("student-signup-submit");
    setLoading(button, true, "Creating account…");
    try {
      const payload = await request("/auth/student-signup", {
        method: "POST",
        body: JSON.stringify({
          id_number: document.getElementById("student-id-number").value.trim(),
          fname: document.getElementById("student-fname").value.trim(),
          mname: document.getElementById("student-mname").value.trim() || null,
          lname: document.getElementById("student-lname").value.trim(),
          email: document.getElementById("student-signup-email").value.trim(),
          password,
          year_level: Number(document.getElementById("student-year-level").value),
          semester: Number(document.getElementById("student-semester").value),
        }),
      });
      await acceptAuthentication(payload);
    } catch (error) {
      showAlert(error.message);
    } finally {
      setLoading(button, false, "Create student account");
    }
  });

  switchButton.addEventListener("click", () => {
    if (signupForm.classList.contains("d-none")) showSignup();
    else showLogin();
  });

  document.getElementById("student-logout-button").addEventListener("click", () => {
    signOut("You have been signed out.");
  });

  document.getElementById("student-dashboard-refresh").addEventListener("click", refreshDashboard);
  document.getElementById("student-sidebar-toggle").addEventListener("click", () => {
    document.getElementById("student-sidebar").classList.toggle("sidebar-open");
  });

  document.querySelectorAll("[data-dashboard-view]").forEach((button) => {
    button.addEventListener("click", () => setDashboardView(button.dataset.dashboardView));
  });

  document.getElementById("fhe-resubmit-button").addEventListener("click", () => {
    if (!enrollmentWindow?.fhe_upload_open) {
      showDashboardAlert("FHE form uploads are only available during the configured enrollment window.");
      return;
    }
    document.getElementById("fhe-upload-form").reset();
    document.getElementById("fhe-upload-panel").classList.remove("d-none");
    document.getElementById("fhe-session-panel").classList.add("d-none");
    setDashboardView("fhe");
    document.getElementById("fhe-upload-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  document.getElementById("fhe-upload-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!enrollmentWindow?.fhe_upload_open) {
      showDashboardAlert("FHE form uploads are only available during the configured enrollment window.");
      refreshDashboard();
      return;
    }
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const file = document.getElementById("fhe-form-file").files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      showDashboardAlert("FHE form files must be 10 MB or smaller.");
      return;
    }
    const button = document.getElementById("fhe-upload-submit");
    fheUploadInProgress = true;
    setLoading(button, true, "Uploading…");
    document.getElementById("student-dashboard-alert").classList.add("d-none");
    try {
      const formData = new FormData();
      formData.append("fhe_form", file);
      const session = await request("/student/enrollment-session/fhe-form", {
        method: "POST",
        body: formData,
      });
      form.reset();
      setEnrollmentSession(session);
      const refreshed = await refreshDashboard();
      if (refreshed) setDashboardView("schedules");
      showDashboardAlert(
        refreshed
          ? "Your FHE form was uploaded. Current-term class schedules are now available."
          : "Your FHE form was uploaded, but schedules could not be refreshed. Use Refresh dashboard to try again.",
        refreshed ? "success" : "warning",
      );
    } catch (error) {
      showDashboardAlert(error.message);
    } finally {
      fheUploadInProgress = false;
      setLoading(button, false, enrollmentWindow?.fhe_upload_open ? "Upload FHE form" : "Uploads unavailable");
      if (enrollmentWindow) setEnrollmentWindow(enrollmentWindow);
    }
  });

  document.querySelectorAll("[data-password-target]").forEach((toggle) => {
    toggle.addEventListener("click", () => {
      const input = document.getElementById(toggle.dataset.passwordTarget);
      input.type = input.type === "password" ? "text" : "password";
      toggle.setAttribute("aria-label", input.type === "password" ? "Show password" : "Hide password");
      toggle.innerHTML = `<i class="bi ${input.type === "password" ? "bi-eye" : "bi-eye-slash"}"></i>`;
    });
  });

  const savedToken = localStorage.getItem(TOKEN_KEY);
  if (savedToken) {
    dashboard.classList.remove("d-none");
    authScreen.classList.add("d-none");
    refreshDashboard();
  }
})();
