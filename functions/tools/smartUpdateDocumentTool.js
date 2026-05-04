import { getFirestore, FieldValue } from "firebase-admin/firestore";

export const smartUpdateDocumentToolDefinition = {
  type: "function",
  function: {
    name: "smartUpdateDocument",
    description: "Bir sipariş belgesindeki alanları, belge yapısı boyunca (ana belge + alt belgeler) mevcut oldukları yerde günceller.",
    parameters: {
      type: "object",
      properties: {
        docId: {
          type: "string",
          description: "Güncellenecek siparişin belge ID'si (örnek: ORD00111)"
        },
        fields: {
          type: "object",
          description: "Güncellenecek alanlar ve yeni değerleri",
          additionalProperties: true
        }
      },
      required: ["docId", "fields"]
    }
  }
};

export async function handleSmartUpdateDocument(args) {
  const db = getFirestore();
  const { docId, fields } = args;
  const now = new Date().toISOString();

  let updatedCount = 0;
  const updatedFields = {};

  const rootRef = db.collection("orders").doc(docId);
  const rootSnap = await rootRef.get();

  if (!rootSnap.exists) {
    console.log(`❌ Ana belge bulunamadı: orders/${docId}`);
    return `⚠️ Belge bulunamadı: ${docId}`;
  }

  const rootData = rootSnap.data() || {};
  const rootUpdates = {};

  // Ana belgede varsa güncelle
  for (const key in fields) {
    if (rootData.hasOwnProperty(key)) {
      rootUpdates[key] = fields[key];
      rootUpdates[`${key}_guncellemeTarihi`] = now;
    }
  }

  if (Object.keys(rootUpdates).length > 0) {
    await rootRef.set(rootUpdates, { merge: true });
    updatedCount++;
    console.log("📝 Ana belge güncellendi:", rootUpdates);
  }

  // Alt koleksiyonları tara
  const subcollectionNames = await rootRef.listCollections().then(cols => cols.map(c => c.id));

  for (const sub of subcollectionNames) {
    const subSnap = await rootRef.collection(sub).get();
    for (const doc of subSnap.docs) {
      const data = doc.data() || {};
      const subUpdates = {};
      for (const key in fields) {
        if (data.hasOwnProperty(key)) {
          subUpdates[key] = fields[key];
          subUpdates[`${key}_guncellemeTarihi`] = now;
        }
      }
      if (Object.keys(subUpdates).length > 0) {
        await doc.ref.update(subUpdates);
        updatedCount++;
        console.log(`📄 Güncellendi: ${sub}/${doc.id}`, subUpdates);
      }
    }
  }

  if (updatedCount === 0) {
    return `⚠️ "${docId}" ID'li belgede belirtilen alanlar bulunamadı. Hiçbir güncelleme yapılmadı.`;
  }

  return `✅ ${updatedCount} belge/alt belge güncellendi.`;
}
