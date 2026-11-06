  async function doDeleteAccount() {
    try {
      const res = await fetch("/api/v1/auth/delete-account", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: deletePassword, code: deleteTotpCode }) });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error || "注销失败");
      showToast("账号已注销");
      setTimeout(() => { window.location.href = "/login"; }, 1000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : "注销失败", "err");
    }
  }
