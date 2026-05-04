import soap from "soap";
import { getQnbSession } from "./qnbSession.js";

const WSDL_USER_SERVICE = process.env.QNB_WSDL_USER_SERVICE; 
// ör: https://connectortest.efinans.com.tr/connector/ws/userService?wsdl  (test)  :contentReference[oaicite:2]{index=2}

const QNB_USERNAME = process.env.QNB_USERNAME;
const QNB_PASSWORD = process.env.QNB_PASSWORD;

let cachedClient = null;
let cachedConnectorClient = null;

export async function getQnbClient() {
  if (cachedClient) return cachedClient;

  if (!WSDL_USER_SERVICE || !QNB_USERNAME || !QNB_PASSWORD) {
    const err = new Error("QNB_CONFIG_MISSING");
    err.status = 500;
    throw err;
  }

  const client = await soap.createClientAsync(WSDL_USER_SERVICE, {
    wsdl_options: { timeout: 30000 },
  });

  // Çoğu QNB SOAP entegrasyonunda header / login token mantığı var.
  // Burayı QNB dokümanındaki kimlik doğrulama yöntemine göre netleştirip bağlayacağız.
  cachedClient = client;
  return client;
}

export async function getQnbConnectorClient() {
  if (cachedConnectorClient) return cachedConnectorClient;

  const wsdlUrl = process.env.QNB_WSDL_CONNECTOR_SERVICE;
  if (!wsdlUrl) throw new Error("QNB_WSDL_CONNECTOR_SERVICE missing in .env");

  const { cookieHeader } = await getQnbSession();

  const client = await soap.createClientAsync(wsdlUrl, {
    wsdl_options: { timeout: 30000 },
  });

  client.addHttpHeader("Cookie", cookieHeader);

  cachedConnectorClient = client;
  return client;
}
