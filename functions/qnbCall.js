import soap from "soap";

let userClient = null;
let connectorClient = null;

let loggedIn = false;
let cookieHeader = null;

async function getUserClient() {
  if (userClient) return userClient;

  const wsdl = process.env.QNB_WSDL_USER_SERVICE;
  if (!wsdl) throw new Error("QNB_WSDL_USER_SERVICE missing in .env");

  userClient = await soap.createClientAsync(wsdl, { wsdl_options: { timeout: 30000 } });
  return userClient;
}

async function getConnectorClient() {
  if (connectorClient) return connectorClient;

  const wsdl = process.env.QNB_WSDL_CONNECTOR_SERVICE;
  if (!wsdl) throw new Error("QNB_WSDL_CONNECTOR_SERVICE missing in .env");

  connectorClient = await soap.createClientAsync(wsdl, { wsdl_options: { timeout: 30000 } });
  return connectorClient;
}

function buildCookieHeader(setCookie) {
  // set-cookie bazen array gelir: ["JSESSIONID=...; Path=/; HttpOnly", "ROUTEID=...; Path=/"]
  if (!setCookie) return null;

  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];

  // Her cookie satırından sadece "name=value" kısmını alıp birleştiriyoruz
  const parts = arr
    .map((c) => String(c).split(";")[0].trim())
    .filter(Boolean);

  if (!parts.length) return null;

  return parts.join("; ");
}

async function ensureLogin() {
  if (loggedIn && cookieHeader) return;

  const userId = process.env.QNB_USERNAME;
  const password = process.env.QNB_PASSWORD;

  if (!userId || !password) throw new Error("QNB_USERNAME/QNB_PASSWORD missing in .env");

  const client = await getUserClient();

  const payload = {
    userId: String(userId),
    password: String(password),
    lang: "tr",
  };

  await client.wsLoginAsync(payload);

  // node-soap login response header’larını buraya yazar
  const headers = client.lastResponseHeaders || {};
  const setCookie = headers["set-cookie"] || headers["Set-Cookie"];

  cookieHeader = buildCookieHeader(setCookie);

  if (!cookieHeader) {
    throw new Error("Login succeeded but Set-Cookie not found in lastResponseHeaders");
  }

  // connector client hazırsa header ekle, değilse callConnector’da ekleyeceğiz
  if (connectorClient) {
    connectorClient.addHttpHeader("Cookie", cookieHeader);
  }

  loggedIn = true;
}

export async function callConnector(opName, args) {
  await ensureLogin();

  const client = await getConnectorClient();

  // Her ihtimale karşı her çağrıdan önce cookie header’ı bas
  client.addHttpHeader("Cookie", cookieHeader);

  const fn = client[`${opName}Async`];
  if (typeof fn !== "function") throw new Error(`Connector op not found: ${opName}`);

  const [resp] = await fn.call(client, args);
  return resp;
}
