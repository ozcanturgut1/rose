import { getFirestore } from "firebase-admin/firestore";

export const createOrderToolDefinition = {
  type: "function",
  function: {
    name: "createOrder",
    description: "Yeni bir Firestore belgesi oluşturur.",
    parameters: {
      type: "object",
      properties: {
        docId: { type: "string", description: "Oluşturulacak belgenin ID'si" },
        fields: {
          type: "object",
          description: "Belge alanları",
          additionalProperties: true
        }
      },
      required: ["docId", "fields"]
    }
  }
};

export async function handleCreateOrder(args) {
  const db = getFirestore();
  await db.collection("orders").doc(args.docId).set(args.fields, { merge: false });
  return `Belge ${args.docId} başarıyla oluşturuldu.`;
}
