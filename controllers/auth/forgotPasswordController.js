/*
    MIT License
    Copyright (c) 2025 Christian I. Cabrera || XianFire Framework
    Mindoro State University - Philippines
*/
// Forgot-password page (GET /forgot-password). Resets are performed by an Accounting Supervisor (no email service configured).
export const forgotPasswordPage = (req, res) => res.render("forgotpassword", { title: "Forgot password", layoutBare: true });
