(() => {
  "use strict";

  const API_BASE_URL = "http://127.0.0.1:8000";
  const form = document.getElementById("faculty-login-form");
  const alert = document.getElementById("faculty-auth-alert");
  const button = document.getElementById("faculty-login-submit");

  function showError(message) {
    alert.className = "alert alert-danger";
    alert.textContent = message;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    alert.textContent = "";
    alert.classList.add("d-none");
    if (!form.reportValidity()) return;

    button.disabled = true;
    button.querySelector(".button-label").textContent = "Signing in…";
    button.querySelector(".spinner-border").classList.remove("d-none");
    try {
      let response;
      try {
        response = await fetch(`${API_BASE_URL}/api/v1/auth/faculty-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: document.getElementById("faculty-login-email").value.trim(),
            password: document.getElementById("faculty-login-password").value,
          }),
        });
      } catch {
        throw new Error(`Cannot reach the API at ${API_BASE_URL}. Check that the backend is running.`);
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
        throw new Error(message);
      }
      if (!payload?.access_token || !payload.faculty) {
        throw new Error("The API returned an incomplete faculty sign-in response.");
      }

      localStorage.setItem("evsuEnrollmentToken", payload.access_token);
      localStorage.setItem("evsuEnrollmentAdmin", JSON.stringify(payload.faculty));
      localStorage.setItem("evsuEnrollmentAccountType", "faculty");
      window.location.href = "./index.html";
    } catch (error) {
      showError(error.message);
    } finally {
      button.disabled = false;
      button.querySelector(".button-label").textContent = "Faculty sign in";
      button.querySelector(".spinner-border").classList.add("d-none");
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
})();
