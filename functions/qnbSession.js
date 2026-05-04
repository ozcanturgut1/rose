import soap from "soap";

let cached = null;
let cachedAt = 0;

function buildCookieHeader(setCookie) {
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const parts = arr
    .map((c) => String(c).split(";")[0].trim())
    .filter(Boolean);
  if (!parts.length) return null;
  return parts.join("; ");
}

export async function getQnbSession() {
  // basit cache: 20 dk
  const now = Date.now();
  if (cached && now - cachedAt < 20 * 60 * 1000) return cached;

  const userWsdl = process.env.QNB_WSDL_USER_SERVICE;
  const username = process.env.QNB_USERNAME;
  const password = process.env.QNB_PASSWORD;

  if (!userWsdl || !username || !password) {
    throw new Error("QNB userService env missing (QNB_WSDL_USER_SERVICE/QNB_USERNAME/QNB_PASSWORD)");
  }

  const userClient = await soap.createClientAsync(userWsdl, {
    wsdl_options: { timeout: 30000 },
  });

  let loginOk = false;
  let lastErr = null;
  const candidates = [
    { username, password },
    { userId: username, password, lang: "tr" },
    { arg0: username, arg1: password },
    { kullaniciAdi: username, sifre: password },
  ];

  for (const payload of candidates) {
    try {
      await userClient.wsLoginAsync(payload);
      loginOk = true;
      break;
    } catch (e) {
      lastErr = e;
    }
  }

  if (!loginOk) {
    throw new Error(`QNB wsLogin failed: ${String(lastErr?.message || lastErr)}`);
  }

  const headers = userClient.lastResponseHeaders || {};
  const setCookie = headers["set-cookie"] || headers["Set-Cookie"];
  const cookieHeader = buildCookieHeader(setCookie);
  if (!cookieHeader) {
    throw new Error("Login succeeded but Set-Cookie not found in lastResponseHeaders");
  }

  cached = { cookieHeader };
  cachedAt = now;
  return cached;
}
