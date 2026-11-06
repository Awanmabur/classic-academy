(function () {
  "use strict";
  const button = document.getElementById("contactSendBtn");
  if (!button) return;
  const form = button.closest("form");
  if (!form) return;
  const source = new URL(window.location.href).pathname.replace(/^\//, "") || "home";
  const sourceName = ["home", "about", "contact", "benefits", "admissions", "plan"].includes(source) ? source : "home";
  const read = (id) => String(document.getElementById(id)?.value || "").trim();
  const status = document.createElement("p");
  status.id = "academy-contact-result";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.style.marginTop = ".8rem";
  button.closest(".form-actions")?.insertAdjacentElement("afterend", status);

  async function submit(event) {
    event.preventDefault();
    if (button.disabled) return;
    if (!form.reportValidity()) return;
    const payload = {
      name: read("contact_name"),
      school: read("contact_school"),
      email: read("contact_email"),
      phone: read("contact_phone"),
      topic: read("contact_topic") || "General enquiry",
      message: read("contact_message"),
      website: read("contact_website"),
      source: sourceName,
    };
    if (payload.message.length < 10) {
      status.textContent = "Please enter a message of at least 10 characters.";
      return;
    }
    button.disabled = true;
    status.textContent = "Sending your message…";
    try {
      const response = await fetch("/api/public-contact", {
        method: "POST",
        credentials: "omit",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(18000),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.message || "Sending failed.");
      status.textContent = result.message;
      form.reset();
    } catch (error) {
      status.textContent = error?.message || "Could not send. Please email info@classictechgroup.com.";
    } finally {
      button.disabled = false;
    }
  }

  button.addEventListener("click", submit);
  form.addEventListener("submit", submit);
})();
